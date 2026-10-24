// Package httpapi exposes the JSON API and wires authentication, the op log and
// the embedded web app into one http.Handler.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pixari/opentodo/internal/agenttools"
	"github.com/pixari/opentodo/internal/assistant"
	"github.com/pixari/opentodo/internal/audit"
	"github.com/pixari/opentodo/internal/auth"
	"github.com/pixari/opentodo/internal/backup"
	"github.com/pixari/opentodo/internal/blobs"
	"github.com/pixari/opentodo/internal/calfeed"
	"github.com/pixari/opentodo/internal/channels"
	"github.com/pixari/opentodo/internal/config"
	"github.com/pixari/opentodo/internal/demo"
	"github.com/pixari/opentodo/internal/email"
	"github.com/pixari/opentodo/internal/importer"
	"github.com/pixari/opentodo/internal/issues"
	"github.com/pixari/opentodo/internal/mail"
	"github.com/pixari/opentodo/internal/maps"
	"github.com/pixari/opentodo/internal/mcp"
	"github.com/pixari/opentodo/internal/notify"
	"github.com/pixari/opentodo/internal/oidc"
	"github.com/pixari/opentodo/internal/push"
	"github.com/pixari/opentodo/internal/relay"
	"github.com/pixari/opentodo/internal/rules"
	"github.com/pixari/opentodo/internal/settings"
	"github.com/pixari/opentodo/internal/stt"
	opsync "github.com/pixari/opentodo/internal/sync"
	"github.com/pixari/opentodo/internal/webhook"
)

const sessionCookie = "opentodo_session"

// Server holds the dependencies of the HTTP layer.
type Server struct {
	cfg     config.Config
	auth    *auth.Service
	audit   *audit.Recorder
	sync    *opsync.Service
	web     http.Handler
	log     *slog.Logger
	version string
	// wrongHosts remembers the hosts already reported as not the base URL's.
	wrongHosts hostWarnings
	// blobs stores attachment files (attachments D2); nil without a data directory.
	blobs *blobs.Store
	// attachmentLimiter caps uploads per account (120/hour, attachments D5).
	attachmentLimiter *rateLimiter
	// One limiter per purpose, per client address, 10 a minute each
	// (trusted-client-identity): limiter counts failed password sign-ins,
	// registerLimiter registrations and sign-up links, resetLimiter password
	// reset requests and links, invitePreviewLimiter invitation and project
	// invite links, publicLinkLimiter unknown public links, mcpLimiter MCP
	// requests without a valid token and passkeyLimiter passkey sign-ins.
	limiter, registerLimiter, resetLimiter, invitePreviewLimiter *rateLimiter
	publicLinkLimiter, mcpLimiter, passkeyLimiter                *rateLimiter
	// accountLimiter counts failed passwords, second-factor codes and
	// re-authentications per account (accountFailures in 15 minutes), on top of
	// the per-address limits.
	accountLimiter *rateLimiter
	// passkeyOptions limits anonymous passkey challenge requests separately, so
	// the sign-in screen's autofill request does not use up password attempts.
	passkeyOptions *rateLimiter
	// inviteLimiter caps invitation creation per account (20/hour).
	inviteLimiter *rateLimiter
	// projectInviteLimiter caps project invite link creation per account
	// (20/hour; OpenSpec `project-invite-links`), see projectinvites.go.
	projectInviteLimiter *rateLimiter
	// workspaceInviteLimiter caps workspace invite link creation per account
	// (20/hour; OpenSpec change workspaces), see workspaceinvites.go.
	workspaceInviteLimiter *rateLimiter
	// mfaLimiter guards the second sign-in step and reauthLimiter
	// re-authentication, per client address (10/min each; OpenSpec `mfa-totp`).
	mfaLimiter    *rateLimiter
	reauthLimiter *rateLimiter
	// adminLimiter caps mutating user-administration requests per acting
	// account (60/hour) and passwordLimiter self-service password changes per
	// account (10/hour) (OpenSpec `user-management` D9).
	adminLimiter    *rateLimiter
	passwordLimiter *rateLimiter
	// emailChangeLimiter caps email change requests per account (5/hour) and
	// avatarLimiter picture uploads per account (30/hour) (settings-refresh D10).
	emailChangeLimiter, avatarLimiter *rateLimiter
	// sttLimiter caps phrases sent to the speech service per account (30/minute).
	sttLimiter *rateLimiter
	// pushTestLimiter caps test pushes per account (5 per 10 minutes; OpenSpec
	// `push-test-delivery` D3), see push.go.
	pushTestLimiter *rateLimiter
	// mail sends outgoing email (OpenSpec `outgoing-email`); nil on a demo
	// instance or when not wired, which means "not configured".
	mail *mail.Service
	// smtpTestLimiter caps test messages per account (5 per 10 minutes).
	smtpTestLimiter *rateLimiter
	// public holds the public-link limiters (OpenSpec `public-links`).
	public publicLimiters
	// pages limits task pages (OpenSpec task-pages), see taskpages.go.
	pages taskPageLimiters
	// importer previews, runs and undoes file imports (OpenSpec `data-import`).
	importer *importer.Service
	// hooks manages outbound webhooks; nil when not wired (routes answer 503).
	hooks *webhook.Service

	// backups is nil when the server runs without the backup service (tests).
	backups *backup.Service
	// push is nil when web push is not wired (tests); see push.go.
	push *push.Service
	// tzOffsets caches each user's last reported zone offset (minutes east of UTC).
	tzOffsets sync.Map
	// inbox serves in-app notifications (OpenSpec `task-assignment`).
	inbox *notify.InApp
	// oidc is single sign-on (OpenSpec `oidc-login`); oidcLimiter guards its
	// anonymous start and callback routes per client address (20/min).
	oidc *oidc.Service
	// pictureClient fetches provider pictures (oidc-profile-pictures); nil
	// means the outbound client.
	pictureClient *http.Client
	// brand caches the instance branding (instance-branding).
	brand       brandingState
	oidcLimiter *rateLimiter
	// caldav caches the CalDAV toggle and davLimiter counts failed Basic
	// authentications per client address (10/min; OpenSpec `caldav`).
	caldav caldavState
	// Calendar feeds (calendar-feeds): the switch cache, the fetch worker and limiters.
	calFeeds        caldavState
	calWorker       *calfeed.Worker
	calFetchLimiter *rateLimiter
	feedLimiter     *rateLimiter
	davLimiter      *rateLimiter
	// Issue import (issue-import): the switch cache, the poller and the
	// shared limit of hand-triggered checks and syncs.
	issuesOn    caldavState
	issueWorker *issues.Worker
	// Notification channels (notification-channels): the service and the
	// per-user limit of test messages; see channels.go.
	channels       *channels.Service
	channelLimiter *rateLimiter
	// stt is the speech-to-text service (settings-refresh D7), see stt.go.
	stt          *stt.Service
	issueLimiter *rateLimiter
	// maps is the map proxy and mapsLimiter the per-user search limit (OpenSpec
	// `task-locations`); see maps.go.
	maps        *maps.Service
	mapsLimiter *rateLimiter
	// parseLimiter is the per-account quick-add parse limit (OpenSpec change
	// extension-v2, design D1).
	parseLimiter *rateLimiter
	// mcpSettings is the owner's AI assistants toggle and mcp the read-only MCP
	// server behind /mcp (OpenSpec `mcp-server`); see mcp.go.
	mcpSettings *mcp.Settings
	// rules is the automation rules engine and ruleSwitch its owner switch
	// (automation-rules); rules is nil on a demo instance.
	rules      *rules.Engine
	ruleSwitch *rules.Switch
	mcp        *mcp.Server
	// agentTools is the AI agent tool registry behind /mcp and agentAccess the
	// users' "Allow AI assistants to make changes" switches (mcp-write-tools).
	agentTools  *agenttools.Registry
	agentAccess *agenttools.Access
	// agentExclusions is the per-project "Keep away from AI assistants" switch
	// (agent-planning-fields D9).
	agentExclusions *agenttools.Exclusions
	// relayStore and relayHub let an encrypted account's opted-in device answer
	// MCP tool calls (mcp-device-relay); see relay.go.
	relayStore *relay.Store
	relayHub   *relay.Hub
	// email is email capture (OpenSpec `email-to-task`); emailLimiter caps
	// inbox changes and rotations per account (30/hour).
	email        *email.Service
	emailLimiter *rateLimiter
	// demo is set on a demo instance (OpenSpec `demo-mode`); see demo.go.
	demo *demo.Service
	// assistant is the in-app assistant (OpenSpec `in-app-assistant`); see
	// assistant.go. assistantSetup lets tests adjust it once built.
	assistant      *assistant.Service
	assistantSetup func(*assistant.Service)
	// assistantTestLimiter limits members' own connection tests (assistant-member-provider).
	assistantTestLimiter *rateLimiter
	// csp caches the page's Content-Security-Policy (assistant-on-device D3).
	csp cspCache
	// idemSalt makes Idempotency-Key ids unguessable (agent-ready-cli D5);
	// see idempotency.go.
	idemSalt string
	// hosted is set for a tenant a host serves (multi-tenant-host); see hosted.go.
	hosted bool
	// routeTable records every registered route with its policy (policy.go).
	routeTable []routeEntry
	// streams counts open live-update streams per client address and in all
	// (SEC-6); see events.go.
	streams streamCounter
}

// WithBackups (an Option, see webhooks.go) enables the owner-only /api/v1/backups routes.
func WithBackups(b *backup.Service) Option { return func(s *Server) { s.backups = b } }

// opTS stamps REST-originated ops with the sync service's server clock
// (sync-convergence), shared with every other server-side writer, so two writes
// to one field within the same millisecond never tie under the winner rule.
func (s *Server) opTS() int64 { return s.sync.ServerTS() }

// New builds the router. web may be nil when only the API is wanted (tests).
func New(cfg config.Config, authSvc *auth.Service, syncSvc *opsync.Service, web http.Handler, log *slog.Logger, version string, opts ...Option) http.Handler {
	s := newServer(cfg, authSvc, syncSvc, web, log, version)
	for _, o := range opts {
		o(s)
	}
	s.wireServices(cfg, log)
	// Every route declares its access policy (route-authorization-policy); see
	// policy.go and router.go.
	mux := &routes{s: s, mux: http.NewServeMux()}
	s.registerRoutes(mux, web)
	s.routeTable = mux.table
	return s.securityHeaders(s.logRequests(auditContext(s.demoGuard(s.hostGuard(mux.mux)))))
}

// newServer builds the Server with its rate limiters and the importer; the
// options run after it.
func newServer(cfg config.Config, authSvc *auth.Service, syncSvc *opsync.Service, web http.Handler, log *slog.Logger, version string) *Server {
	s := &Server{cfg: cfg, auth: authSvc, audit: authSvc.Audit(), sync: syncSvc, web: web, log: log, version: version,
		limiter: newRateLimiter(10, time.Minute), inviteLimiter: newRateLimiter(20, time.Hour),
		registerLimiter: newRateLimiter(10, time.Minute), resetLimiter: newRateLimiter(10, time.Minute),
		invitePreviewLimiter: newRateLimiter(10, time.Minute), publicLinkLimiter: newRateLimiter(10, time.Minute),
		mcpLimiter: newRateLimiter(10, time.Minute), passkeyLimiter: newRateLimiter(10, time.Minute),
		accountLimiter: newRateLimiter(accountFailures, accountWindow),
		passkeyOptions: newRateLimiter(10, time.Minute),
		mfaLimiter:     newRateLimiter(10, time.Minute), reauthLimiter: newRateLimiter(10, time.Minute),
		adminLimiter: newRateLimiter(60, time.Hour), passwordLimiter: newRateLimiter(10, time.Hour),
		emailChangeLimiter: newRateLimiter(5, time.Hour), avatarLimiter: newRateLimiter(30, time.Hour), sttLimiter: newRateLimiter(30, time.Minute),
		oidcLimiter: newRateLimiter(20, time.Minute), davLimiter: newRateLimiter(10, time.Minute),
		emailLimiter: newRateLimiter(30, time.Hour),
		importer:     importer.New(syncSvc.DB(), syncSvc, log)}
	// Imports: unpacked archives are bounded by the upload limit, and an uploaded
	// database is read from a private copy under the data directory (OpenSpec
	// change named-importers).
	importTmp := ""
	if cfg.DataDir != "" {
		importTmp = filepath.Join(cfg.DataDir, "tmp")
		if err := os.MkdirAll(importTmp, 0o700); err != nil {
			log.Warn("import: temporary directory", "err", err)
			importTmp = ""
		}
	}
	s.importer.SetLimits(cfg.ImportMaxBytes(), importTmp)
	return s
}

// wireServices connects the services to each other once the options have run:
// trusted proxies, the setup code, the idempotency salt, the demo write guard,
// webhooks for imports, single sign-on, email capture, the in-app inbox,
// passkeys and account deletion. cfg and log are New's arguments, not the
// fields an option may have replaced.
func (s *Server) wireServices(cfg config.Config, log *slog.Logger) {
	authSvc, syncSvc := s.auth, s.sync
	setTrustedProxies(cfg.TrustedProxies, cfg.TrustCloudflare)
	s.announceSetupCode()
	if err := s.loadIdempotencySalt(context.Background()); err != nil {
		// Without a stored salt keyed ids still derive per user; they are only
		// guessable by someone who knows the user id and the key.
		log.Error("idempotency salt unavailable", "err", err)
	}
	if s.demo != nil {
		// Sandbox writes are bounded: field sizes and the write budget (demo-sandboxes D3).
		syncSvc.SetWriteGuard(s.demo.Guard())
	}
	if s.hooks != nil {
		// Imports reach webhooks as one summary per job (harden-server-edges).
		s.importer.SetSummaryObserver(s.hooks.ObserveImport)
	}
	if s.oidc == nil {
		s.oidc = oidc.New(settings.New(syncSvc.DB()), cfg.DataDir, oidc.Options{Env: oidc.Env(cfg.OIDC)})
	}
	// SSO-only mode refuses local sign-in for members (oidc-login D6).
	authSvc.SetSSOOnly(s.oidc.SSOOnly)
	if s.email == nil {
		// Disabled unless cfg.Email is set; only cmd/opentodo starts the poller.
		s.email = email.New(syncSvc.DB(), syncSvc, cfg.Email, email.Options{Log: log, Audit: authSvc.Audit()})
	}
	if s.inbox == nil {
		s.inbox = notify.NewInApp(syncSvc.DB(), log)
		syncSvc.AddSink(s.inbox)
	}
	// Passkeys need a relying party; it is derived from the base URL so the
	// 409 guard in the handlers and the service always agree.
	if cfg.PasskeysAvailable() && !authSvc.PasskeysAvailable() {
		authSvc.ConfigurePasskeys(cfg.RPID(), cfg.Origin())
	}
	// Deleting an account removes its synced data in the same transaction
	// (user-management D4; the project-sharing hook lives in the sync package).
	authSvc.SetBeforeDelete(syncSvc.DeleteAccountData)
}

// internal answers 500 (or 503 while every password-hashing slot is busy) and
// logs the cause.
func (s *Server) internal(w http.ResponseWriter, err error) {
	if errors.Is(err, auth.ErrBusy) {
		// Every password-hashing slot is taken (SEC-5): a retry soon succeeds.
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, "busy", "the server is busy, try again in a moment")
		return
	}
	s.log.Error("request failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
