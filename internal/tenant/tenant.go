// Package tenant builds one OpenTodo server around one data directory: the
// database and its lock, the services, the notifier, the HTTP handler and the
// background jobs (OpenSpec `multi-tenant-host`, design D1). A self-hosted
// server opens exactly one tenant; a host (internal/host) opens many, lazily.
package tenant

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/pixari/opentodo/internal/audit"
	"github.com/pixari/opentodo/internal/auth"
	"github.com/pixari/opentodo/internal/backup"
	"github.com/pixari/opentodo/internal/calfeed"
	"github.com/pixari/opentodo/internal/config"
	"github.com/pixari/opentodo/internal/demo"
	"github.com/pixari/opentodo/internal/digest"
	"github.com/pixari/opentodo/internal/e2ee"
	"github.com/pixari/opentodo/internal/email"
	"github.com/pixari/opentodo/internal/httpapi"
	"github.com/pixari/opentodo/internal/mail"
	"github.com/pixari/opentodo/internal/mcp"
	"github.com/pixari/opentodo/internal/notify"
	"github.com/pixari/opentodo/internal/push"
	"github.com/pixari/opentodo/internal/settings"
	"github.com/pixari/opentodo/internal/store"
	opsync "github.com/pixari/opentodo/internal/sync"
	"github.com/pixari/opentodo/internal/web"
	"github.com/pixari/opentodo/internal/webhook"
)

// Options configure Open.
type Options struct {
	Version string
	Log     *slog.Logger
	// Restart is called when a restore confirmed in the web app needs the
	// tenant to be closed and opened again (backup-restore-web D1). A
	// self-hosted server re-executes itself; a host closes the tenant so the
	// next request reopens it and applies the restore.
	Restart func()
	// Hosted is set when a host serves this tenant (multi-tenant-host D2, D4):
	// operator-level settings come from the host, the background jobs run in the
	// host's shared scheduler and the tenant's limits apply.
	Hosted *Hosted
	// Web serves the embedded app; nil builds the default handler.
	Web http.Handler
	// PushOptions adjusts web push before it is built (tests point it at a
	// fake push service).
	PushOptions func(*push.Options)
	// Now is the weekly digest's clock (a host passes its own, tests a fake
	// one); nil is time.Now.
	Now func() time.Time
}

// Hosted is what a host passes to each of its tenants.
type Hosted struct {
	// Name is the tenant name (the first label of its host name).
	Name string
	// PushSubject is the operator's VAPID contact (a mailto: or https: URI).
	PushSubject string
	// Quota bounds the tenant's writes (multi-tenant-host D5); nil means none.
	Quota opsync.Quota
	// MaxMembers caps the tenant's accounts; 0 means no limit.
	MaxMembers int
	// Changed is called after every committed write, so the host can refresh
	// the tenant's entries in the "next due" index (D3).
	Changed func()
	// OnClose is called once the tenant has closed (the host's bookkeeping).
	OnClose func()
}

// Tenant is one open data directory and everything built around it.
type Tenant struct {
	Cfg      config.Config
	DB       *sql.DB
	Reader   *sql.DB // query-only pool for pure reads (store.OpenReader)
	Auth     *auth.Service
	Sync     *opsync.Service
	Hooks    *webhook.Service
	Inbox    *notify.InApp
	Backups  *backup.Service
	MCP      *mcp.Settings
	Push     *push.Service // nil when web push is off
	Email    *email.Service
	Calendar *calfeed.Worker
	Mail     *mail.Service   // nil on a demo instance
	Digest   *digest.Service // weekly digests (stats-and-review); nil with Mail
	Demo     *demo.Service   // nil unless OPENTODO_DEMO
	Handler  http.Handler

	log       *slog.Logger
	hosted    *Hosted
	unlock    func()
	closeOnce sync.Once
	closeErr  error
}

// Open applies a pending web restore, takes the data directory's shared lock,
// opens and migrates the database and wires every service and the HTTP
// handler for cfg.DataDir. It starts no background job: a self-hosted server
// calls StartJobs once it leads the jobs, a host runs them through its shared
// scheduler. Close releases everything.
func Open(ctx context.Context, cfg config.Config, o Options) (t *Tenant, err error) {
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	// A restore confirmed in the web app is applied before the database opens. A
	// failure is recorded and the tenant opens on the previous database.
	if err := backup.ApplyPendingRestore(cfg.DataDir, log, nil); err != nil {
		log.Error("restore: could not record the outcome", "err", err)
	}
	// Hold the data directory shared for the life of the tenant: `opentodo
	// restore` and the other maintenance commands refuse to touch it while it is
	// open, but a newer server may open it beside us (rolling updates).
	unlock, err := store.LockShared(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", cfg.DataDir, err)
	}
	db, err := store.Open(cfg.DataDir)
	if err != nil {
		unlock()
		return nil, err
	}
	t = &Tenant{Cfg: cfg, DB: db, log: log, hosted: o.Hosted, unlock: unlock}
	defer func() {
		if err != nil {
			t.Close()
			t = nil
		}
	}()
	if t.Reader, err = store.OpenReader(cfg.DataDir); err != nil {
		return nil, err
	}
	if err := t.wire(ctx, o); err != nil {
		return nil, err
	}
	return t, nil
}

// wire builds every service of the tenant and its HTTP handler. Nothing is
// stored on t until everything was built, so a failure leaves t as Open made it.
func (t *Tenant) wire(ctx context.Context, o Options) error {
	cfg, log, db, hosted := t.Cfg, t.log, t.DB, o.Hosted
	if cfg.Demo {
		// Demo instance (OpenSpec `demo-mode`, docs/self-hosting/demo.md): no sign-up,
		// no web push, and none of the outbound integrations below run.
		cfg.AllowSignup, cfg.PushDisabled = false, true
	}
	authSvc := auth.NewService(db, cfg.SessionTTL, cfg.AllowSignup)
	authSvc.SetSetupToken(cfg.SetupToken)
	syncSvc := opsync.NewService(db)
	syncSvc.SetReader(t.Reader)
	hooks, err := wireWebhooks(ctx, cfg, o, db, authSvc, syncSvc, log)
	if err != nil {
		return err
	}
	inbox := openInbox(ctx, db, syncSvc, log)
	backups, err := openBackups(ctx, cfg, o, db, authSvc, log)
	if err != nil {
		return err
	}
	mcpSettings, err := openMCPSettings(ctx, cfg, hosted, db, log)
	if err != nil {
		return err
	}
	opts := []httpapi.Option{httpapi.WithWebhooks(hooks), httpapi.WithBackups(backups), httpapi.WithNotifications(inbox), httpapi.WithMCPSettings(mcpSettings)}
	if hosted != nil {
		opts = append(opts, httpapi.WithHosted())
	}
	pushSvc := openPush(cfg, o, db, syncSvc, log)
	if pushSvc != nil {
		opts = append(opts, httpapi.WithPush(pushSvc))
	}
	// Email to task (docs/email.md): off unless OPENTODO_EMAIL_* configure a
	// mailbox; then one goroutine polls it over IMAP. A host has no per-tenant
	// mailbox, so the feature stays off there.
	emailCfg := cfg.Email
	if hosted != nil {
		emailCfg = config.EmailConfig{}
	}
	emailSvc := email.New(db, syncSvc, emailCfg, email.Options{Log: log, Audit: authSvc.Audit()})
	opts = append(opts, httpapi.WithEmail(emailSvc))
	// Calendar subscriptions (calendar-feeds): fetched under the webhooks'
	// private-network policy; the server sets the switch and the notifier.
	calWorker := &calfeed.Worker{Store: calfeed.NewStore(db), Fetcher: calfeed.NewFetcher(hooks.AllowPrivate, o.Version), Log: log}
	opts = append(opts, httpapi.WithCalendarFeeds(calWorker))
	mailSvc, digestSvc := openMail(cfg, o, db, authSvc, syncSvc, log)
	if mailSvc != nil {
		opts = append(opts, httpapi.WithMail(mailSvc))
	}
	demoSvc, err := startDemo(ctx, cfg, authSvc, syncSvc, log)
	if err != nil {
		return err
	}
	if demoSvc != nil {
		opts = append(opts, httpapi.WithDemo(demoSvc))
	}
	webHandler := o.Web
	if webHandler == nil {
		// A demo page also tells search engines not to index it (demo-sandboxes D5).
		webHandler = web.HandlerWith(web.Options{NoIndex: cfg.Demo})
	}
	t.Handler = httpapi.New(cfg, authSvc, syncSvc, webHandler, log, o.Version, opts...)
	t.Cfg, t.Auth, t.Sync, t.Hooks, t.Inbox, t.Backups, t.MCP = cfg, authSvc, syncSvc, hooks, inbox, backups, mcpSettings
	t.Push, t.Email, t.Calendar, t.Demo = pushSvc, emailSvc, calWorker, demoSvc
	t.Mail, t.Digest = mailSvc, digestSvc
	return nil
}

// wireWebhooks builds outbound webhooks: events come from the winning changes
// of each committed sync batch; the worker sends queued deliveries until
// shutdown. On a host it also installs the tenant's limits and the host's
// change callback.
func wireWebhooks(ctx context.Context, cfg config.Config, o Options, db *sql.DB, authSvc *auth.Service, syncSvc *opsync.Service, log *slog.Logger) (*webhook.Service, error) {
	hosted := o.Hosted
	hooks := webhook.New(db, syncSvc, webhook.Options{Version: o.Version, Log: log})
	if hosted == nil {
		if err := hooks.SeedAllowPrivate(ctx, cfg.WebhooksAllowPrivate); err != nil {
			return nil, err
		}
		syncSvc.SetObserver(hooks.Observe)
		return hooks, nil
	}
	// A host's private network is the operator's (multi-tenant-host D4):
	// tenants never deliver to it, whatever was stored before.
	if err := hooks.SetAllowPrivate(ctx, false); err != nil {
		return nil, err
	}
	authSvc.SetMemberLimit(hosted.MaxMembers)
	syncSvc.SetQuota(hosted.Quota)
	changed := hosted.Changed
	syncSvc.SetObserver(func(ctx context.Context, changes []opsync.Change) {
		hooks.Observe(ctx, changes)
		if changed != nil {
			changed()
		}
	})
	return hooks, nil
}

// openInbox builds in-app notifications (task-assignment): assignment events
// land in the notifications table after commit. Old read rows are swept on open.
func openInbox(ctx context.Context, db *sql.DB, syncSvc *opsync.Service, log *slog.Logger) *notify.InApp {
	inbox := notify.NewInApp(db, log)
	syncSvc.AddSink(inbox)
	if n, err := inbox.Sweep(ctx); err != nil {
		log.Warn("notification sweep failed", "err", err)
	} else if n > 0 {
		log.Info("old notifications removed", "count", n)
	}
	return inbox
}

// openBackups builds scheduled backups (docs/backups.md): off until the owner
// configures them, or seeded once from OPENTODO_BACKUP_*.
func openBackups(ctx context.Context, cfg config.Config, o Options, db *sql.DB, authSvc *auth.Service, log *slog.Logger) (*backup.Service, error) {
	backups := backup.New(db, cfg.DataDir, backup.Options{Version: o.Version, Log: log, Audit: authSvc.Audit()})
	if o.Restart != nil {
		backups.SetRestartFunc(o.Restart)
	}
	if !cfg.Demo {
		if seeded, err := backups.ApplyPreset(ctx, cfg.Backup); err != nil {
			return nil, err
		} else if seeded {
			log.Info("backup settings seeded from OPENTODO_BACKUP_* variables")
		}
	}
	return backups, nil
}

// openMCPSettings builds the MCP endpoint's settings (docs/mcp.md): off until
// the owner enables it; OPENTODO_MCP presets the toggle and OPENTODO_MCP_WRITES
// the "AI assistants may make changes" switch, on first start only. On a host
// both are the operator's and are applied on every open.
func openMCPSettings(ctx context.Context, cfg config.Config, hosted *Hosted, db *sql.DB, log *slog.Logger) (*mcp.Settings, error) {
	mcpSettings := mcp.NewSettings(db)
	if hosted != nil {
		if err := mcpSettings.Set(ctx, "", cfg.MCP != nil && *cfg.MCP, nil); err != nil {
			return nil, err
		}
		if err := mcpSettings.SetWrites(ctx, "", cfg.MCPWrites != nil && *cfg.MCPWrites, nil); err != nil {
			return nil, err
		}
		return mcpSettings, nil
	}
	if seeded, err := mcpSettings.Seed(ctx, cfg.MCP); err != nil {
		return nil, err
	} else if seeded {
		log.Info("MCP setting seeded from OPENTODO_MCP", "enabled", *cfg.MCP)
	}
	if seeded, err := mcpSettings.SeedWrites(ctx, cfg.MCPWrites); err != nil {
		return nil, err
	} else if seeded {
		log.Info("MCP writes setting seeded from OPENTODO_MCP_WRITES", "enabled", *cfg.MCPWrites)
	}
	return mcpSettings, nil
}

// openPush builds reminders' web push to subscribed devices
// (docs/reminders.md). On unless OPENTODO_PUSH=off (nil then); the VAPID key
// pair is created under the data directory on first use. In-app reminders work
// either way.
func openPush(cfg config.Config, o Options, db *sql.DB, syncSvc *opsync.Service, log *slog.Logger) *push.Service {
	if cfg.PushDisabled {
		return nil
	}
	subject := cfg.Origin()
	if o.Hosted != nil {
		subject = o.Hosted.PushSubject
	}
	po := push.Options{Log: log, Subject: subject}
	if o.PushOptions != nil {
		o.PushOptions(&po)
	}
	return push.New(db, syncSvc, cfg.DataDir, po)
}

// openMail builds outgoing email (docs/self-hosting/outgoing-email.md): never
// on a demo instance (both nil then); otherwise configured in Settings or by
// OPENTODO_SMTP_* (on a host, only by the operator's OPENTODO_SMTP_*). The
// weekly digest (stats-and-review) rides on it: each user opts in for
// themselves, on a host too, and it sends nothing while outgoing email is not
// configured.
func openMail(cfg config.Config, o Options, db *sql.DB, authSvc *auth.Service, syncSvc *opsync.Service, log *slog.Logger) (*mail.Service, *digest.Service) {
	if cfg.Demo {
		return nil, nil
	}
	ehlo := ""
	if cfg.BaseURL != nil {
		ehlo = cfg.BaseURL.Hostname()
	}
	mailSvc := mail.New(settings.New(db), cfg.DataDir, mail.Options{Env: cfg.SMTP, Audit: authSvc.Audit(), Log: log,
		E2EE: e2ee.NewStore(db), Transport: &mail.Transport{LocalName: ehlo}})
	digestSvc := digest.New(db, syncSvc, mailSvc, digest.Options{Origin: cfg.Origin(), Log: log, Now: o.Now})
	return mailSvc, digestSvc
}

// startDemo, on a demo instance only (nil otherwise), provisions the hidden
// owner, drops the shared accounts of the first demo version and catches up on
// a missed nightly reset before serving.
func startDemo(ctx context.Context, cfg config.Config, authSvc *auth.Service, syncSvc *opsync.Service, log *slog.Logger) (*demo.Service, error) {
	if !cfg.Demo {
		return nil, nil
	}
	demoSvc := demo.New(authSvc, syncSvc, log)
	demoSvc.SetLimits(cfg.DemoMaxSandboxes, cfg.DemoMaxDBMB)
	if err := demoSvc.Start(ctx); err != nil {
		return nil, fmt.Errorf("demo mode: %w", err)
	}
	log.Warn("demo mode is on: every visitor gets a private sandbox, deleted after inactivity and every night", "reset_hour_utc", demo.ResetHour)
	return demoSvc, nil
}

// StartJobs starts the background jobs of a self-hosted server. They stop when
// ctx is cancelled or stop is called; stop cancels them and returns once every
// goroutine StartJobs started (and any backup in progress) has finished, so
// the database can be closed after it (reliable-background-jobs). A delivery
// or send in progress records its outcome first; each is bounded by its own
// timeout.
func (t *Tenant) StartJobs(ctx context.Context, demoSignal func(context.Context, *demo.Service)) (stop func()) {
	cfg := t.Cfg
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	spawn := func(f func(context.Context)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f(ctx)
		}()
	}
	// Prune audit events past the owner's retention at startup and hourly.
	// Expired pending sign-ups (outgoing-email) go on the same tick.
	t.Auth.Audit().AlsoPrune(t.Auth.PruneSignups)
	spawn(func(ctx context.Context) { t.Auth.Audit().RunPruner(ctx, audit.PruneInterval) })
	// Read notifications past the 90-day retention: swept on open and daily.
	spawn(func(ctx context.Context) { t.Inbox.RunSweeper(ctx, notify.SweepInterval) })
	if !cfg.Demo {
		// The backup service counts its own goroutines (scheduler, restore
		// housekeeping, a run started from the web app); stop waits for them.
		t.Backups.Start(ctx)
	}
	if t.Push != nil {
		spawn(t.Push.Run)
	}
	if t.Digest != nil {
		// Weekly digests: a pass every 5 minutes; it sends nothing while
		// outgoing email is not configured.
		spawn(t.Digest.Run)
	}
	if t.Demo != nil {
		// Expired-sandbox cleanup every 5 minutes and the nightly reset.
		spawn(t.Demo.Run)
		if demoSignal != nil {
			// The operator (or a test) can force a reset with SIGUSR1; there is no route.
			spawn(func(ctx context.Context) { demoSignal(ctx, t.Demo) })
		}
	} else {
		spawn(t.Email.Run)
	}
	// Purge items that outlived the Trash retention at startup and daily
	// (OPENTODO_TRASH_RETENTION_DAYS, default 30, 0 disables; docs/sync.md).
	spawn(func(ctx context.Context) { t.Sync.RunRetention(ctx, cfg.TrashRetentionDays, t.log) })
	// Query planner statistics: refreshed on open and daily (database-concurrency).
	spawn(func(ctx context.Context) { store.RunOptimizer(ctx, t.DB, store.OptimizeInterval, t.log) })
	if !cfg.Demo {
		// No outbound calendar fetches on a demo instance.
		spawn(t.Calendar.Run)
		// No outbound webhook deliveries on a demo instance.
		spawn(t.Hooks.Run)
	}
	return func() {
		cancel()
		wg.Wait()
		if !cfg.Demo {
			t.Backups.Stop()
		}
	}
}

// Hosted reports the host's settings for this tenant; nil when self-hosted.
func (t *Tenant) Hosted() *Hosted { return t.hosted }

// Close stops the backup service, ends live event streams, closes the database and releases the data
// directory. It is safe to call more than once.
func (t *Tenant) Close() error {
	t.closeOnce.Do(func() {
		// A backup started from the web app runs even where this process does
		// not lead the jobs: cancel it and wait for its outcome first.
		if t.Backups != nil {
			t.Backups.Stop()
		}
		if t.Sync != nil {
			t.Sync.Notifier().CloseAll()
		}
		if t.Reader != nil {
			t.Reader.Close()
		}
		if t.DB != nil {
			t.closeErr = t.DB.Close()
		}
		if t.unlock != nil {
			t.unlock()
		}
		if t.hosted != nil && t.hosted.OnClose != nil {
			t.hosted.OnClose()
		}
	})
	return t.closeErr
}
