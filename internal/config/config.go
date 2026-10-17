// Package config loads runtime configuration from environment variables.
// Every setting has a default so the binary runs with no configuration at all.
package config

import (
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the fully resolved runtime configuration.
type Config struct {
	Addr        string
	DataDir     string
	BaseURL     *url.URL // nil when not configured
	AllowSignup bool
	// SetupToken, when set (OPENTODO_SETUP_TOKEN), must accompany the first
	// registration on a server without accounts (OpenSpec change owner-bootstrap).
	// It has no effect once an owner exists.
	SetupToken string
	SessionTTL time.Duration
	LogLevel   slog.Level
	// ImportMaxMB caps the size of an uploaded import file (OPENTODO_IMPORT_MAX_MB).
	ImportMaxMB int
	// WebhooksAllowPrivate presets the owner's "allow private network targets"
	// webhook policy on first start only (nil when OPENTODO_WEBHOOKS_ALLOW_PRIVATE
	// is unset). Afterwards the value set in Settings is authoritative.
	WebhooksAllowPrivate *bool
	// MCP presets the owner's "AI assistants (MCP)" toggle on first start only
	// (nil when OPENTODO_MCP is unset; OpenSpec `mcp-server`). Afterwards the
	// value set in Settings is authoritative. The endpoint is off by default.
	MCP *bool
	// MCPWrites presets the owner's "AI assistants may make changes" switch on
	// first start only (nil when OPENTODO_MCP_WRITES is unset; OpenSpec
	// `mcp-write-tools`). Optional; afterwards Settings decides.
	MCPWrites *bool
	// Backup holds the optional OPENTODO_BACKUP_* presets (see backup.go).
	Backup BackupPreset
	// AttachmentsMaxFileMB and AttachmentsQuotaMB are the optional
	// OPENTODO_ATTACHMENTS_MAX_FILE_MB / _QUOTA_MB presets (attachments D5): they
	// seed the owner settings once; nil when unset.
	AttachmentsMaxFileMB *int
	AttachmentsQuotaMB   *int
	// PushDisabled turns web push off (OPENTODO_PUSH=off): the /api/v1/push routes
	// answer 404 and the reminder scheduler does not run. Push is on by default.
	PushDisabled bool
	// TrashRetentionDays is how long deleted tasks and projects stay in the Trash
	// before the server purges them (OPENTODO_TRASH_RETENTION_DAYS, default 30,
	// 0 disables automatic purge).
	TrashRetentionDays int
	// OIDC holds the optional OPENTODO_OIDC_* overrides of the single sign-on
	// settings (OpenSpec `oidc-login`). Each set variable overrides the value from
	// Settings and locks that field; nothing is required.
	OIDC OIDCEnv
	// CalDAV presets the owner's CalDAV toggle on first start only (nil when
	// OPENTODO_CALDAV is unset; OpenSpec `caldav`). Afterwards the value set in
	// Settings is authoritative.
	CalDAV *bool
	// CalendarFeeds presets the owner's calendar feeds switch on first start only
	// (nil when OPENTODO_CALENDAR_FEEDS is unset; OpenSpec calendar-feeds).
	CalendarFeeds *bool
	// Email holds the optional OPENTODO_EMAIL_* settings of email capture
	// (OpenSpec `email-to-task`, see email.go); off unless fully configured.
	Email EmailConfig
	// SMTP holds the optional OPENTODO_SMTP_* overrides of outgoing email
	// (OpenSpec `outgoing-email`, see smtp.go).
	SMTP SMTPConfig
	// Demo turns the server into a public demo instance (OPENTODO_DEMO=true;
	// OpenSpec `demo-mode`): a private, short-lived sandbox per visitor
	// (`demo-sandboxes`), a nightly reset, sign-up and every abusable feature
	// refused with 403 demo_restricted. Off by default.
	Demo bool
	// DemoMaxSandboxes caps live demo sandboxes (OPENTODO_DEMO_MAX_SANDBOXES;
	// 0 means the default, 500) and DemoMaxDBMB stops new sandboxes above that
	// database size (OPENTODO_DEMO_MAX_DB_MB; 0 means the default, 1024). Both
	// optional and read only in demo mode.
	DemoMaxSandboxes int
	DemoMaxDBMB      int
	// TrustedProxies lists the proxies whose X-Forwarded-For is believed and
	// whose hops are skipped when finding the client address
	// (OPENTODO_TRUSTED_PROXIES: IPs, CIDRs and/or the keywords "private" and
	// "cloudflare"). Optional; empty means the default, PrivateRanges
	// (trusted-client-identity).
	TrustedProxies []netip.Prefix
	// TrustCloudflare is set when OPENTODO_TRUSTED_PROXIES names "cloudflare":
	// a request whose nearest hop is a Cloudflare edge may then name the client
	// with CF-Connecting-IP.
	TrustCloudflare bool
	// Host turns on host mode (OPENTODO_HOST_URL; OpenSpec `multi-tenant-host`,
	// see host.go): many tenants in one process. Nil for a normal server.
	Host *HostConfig
	// Warnings are configuration problems the server started despite (OpenSpec
	// `trusted-proxies-lenient`): logged at startup and shown to the owner.
	Warnings []Warning
}

// Warning is a configuration problem that did not stop startup: the variable,
// a message saying what was ignored and how to fix it, and the ignored values.
// The JSON form is what the owner's /api/v1/me carries in config_warnings.
type Warning struct {
	Variable string   `json:"variable"`
	Message  string   `json:"message"`
	Ignored  []string `json:"ignored,omitempty"`

	logAttrs []any  // the startup log line's fields
	logMsg   string // the startup log line; empty means "invalid entries ignored"
}

// LogWarnings writes one error line per configuration warning, so the cause
// is in the container log even though the server keeps running.
func (c Config) LogWarnings(log *slog.Logger) {
	for _, w := range c.Warnings {
		if w.logMsg != "" {
			log.Error(w.logMsg, w.logAttrs...)
			continue
		}
		log.Error(w.Variable+": invalid entries ignored", w.logAttrs...)
	}
}

// OIDCEnv mirrors oidc.Env (converted by the HTTP layer) so this package stays
// free of feature imports.
type OIDCEnv struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	DisplayName  string
	SSOOnly      *bool
}

// DefaultTrashRetentionDays applies when OPENTODO_TRASH_RETENTION_DAYS is unset.
const DefaultTrashRetentionDays = 30

// MaxTrashRetentionDays bounds OPENTODO_TRASH_RETENTION_DAYS (ten years).
const MaxTrashRetentionDays = 3650

// Import file size bounds for OPENTODO_IMPORT_MAX_MB.
const (
	DefaultImportMaxMB = 20
	MaxImportMaxMB     = 200
)

// MinSetupTokenLen is the shortest accepted OPENTODO_SETUP_TOKEN (owner-bootstrap
// design D2); Coolify's generated SERVICE_PASSWORD_* values are longer.
const MinSetupTokenLen = 16

// Load reads OPENTODO_* variables from the environment.
func Load() (Config, error) {
	c := Config{
		Addr:        getenv("OPENTODO_ADDR", ":8080"),
		DataDir:     getenv("OPENTODO_DATA_DIR", "./data"),
		SessionTTL:  90 * 24 * time.Hour,
		LogLevel:    slog.LevelInfo,
		ImportMaxMB: DefaultImportMaxMB,

		TrashRetentionDays: DefaultTrashRetentionDays,
	}
	if err := c.loadServerVars(); err != nil {
		return c, err
	}
	if err := c.loadToggles(); err != nil {
		return c, err
	}
	if err := c.loadTrashAndPush(); err != nil {
		return c, err
	}
	if err := c.loadOIDC(); err != nil {
		return c, err
	}
	if err := c.loadDemo(); err != nil {
		return c, err
	}
	if raw := strings.TrimSpace(os.Getenv("OPENTODO_TRUSTED_PROXIES")); raw != "" {
		// Lenient on purpose (trusted-proxies-lenient): a typo must not stop the
		// server, and dropping an entry only ever trusts fewer hops.
		t := ParseTrustedProxies(raw)
		c.TrustedProxies, c.TrustCloudflare = t.Prefixes, t.Cloudflare
		if w, ok := t.Warning(); ok {
			c.Warnings = append(c.Warnings, w)
		}
		if w, ok := t.NoLocalProxyWarning(); ok {
			c.Warnings = append(c.Warnings, w)
		}
	}
	switch strings.ToLower(getenv("OPENTODO_LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn", "warning":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		return c, fmt.Errorf("OPENTODO_LOG_LEVEL must be debug, info, warn or error")
	}
	b, err := loadBackupPreset()
	if err != nil {
		return c, err
	}
	c.Backup = b
	if c.AttachmentsMaxFileMB, err = optionalInt("OPENTODO_ATTACHMENTS_MAX_FILE_MB", 1, 2048); err != nil {
		return c, err
	}
	if c.AttachmentsQuotaMB, err = optionalInt("OPENTODO_ATTACHMENTS_QUOTA_MB", 0, 1<<20); err != nil {
		return c, err
	}
	if c.Email, err = loadEmail(); err != nil {
		return c, err
	}
	if c.SMTP, err = loadSMTP(); err != nil {
		return c, err
	}
	if c.Host, err = loadHost(); err != nil {
		return c, err
	}
	if c.Host != nil && c.Demo {
		return c, fmt.Errorf("OPENTODO_HOST_URL (host mode) and OPENTODO_DEMO cannot be combined")
	}
	return c, nil
}

// ImportMaxBytes is the import file size limit in bytes; a zero value (a Config
// built by hand, as in tests) means the default.
func (c Config) ImportMaxBytes() int64 {
	mb := c.ImportMaxMB
	if mb <= 0 {
		mb = DefaultImportMaxMB
	}
	return int64(mb) << 20
}

// SecureCookies reports whether the base URL is https: cookies then always
// carry the Secure flag and responses send Strict-Transport-Security. The HTTP
// layer also sets Secure for a request that arrived over https.
func (c Config) SecureCookies() bool {
	return c.BaseURL != nil && c.BaseURL.Scheme == "https"
}

// Origin returns the configured public origin (scheme://host) or "".
func (c Config) Origin() string {
	if c.BaseURL == nil {
		return ""
	}
	return c.BaseURL.Scheme + "://" + c.BaseURL.Host
}

// RPID returns the WebAuthn relying-party identifier: the host of the public
// base URL without port, or "" when no base URL is configured.
func (c Config) RPID() string {
	if c.BaseURL == nil {
		return ""
	}
	return strings.ToLower(c.BaseURL.Hostname())
}

// PasskeysAvailable reports whether passkey ceremonies can be offered. Browsers
// only allow them on secure origins, so this needs an https base URL, or a
// localhost development origin which browsers treat as secure.
func (c Config) PasskeysAvailable() bool {
	if c.BaseURL == nil {
		return false
	}
	if c.BaseURL.Scheme == "https" {
		return c.BaseURL.Hostname() != ""
	}
	if c.BaseURL.Scheme != "http" {
		return false
	}
	switch strings.ToLower(c.BaseURL.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// loadServerVars reads the base URL, sign-up, the setup token, the session
// length and the import size limit.
func (c *Config) loadServerVars() error {
	if v := strings.TrimSpace(os.Getenv("OPENTODO_BASE_URL")); v != "" {
		u, err := url.Parse(v)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("OPENTODO_BASE_URL must be an absolute URL, got %q", v)
		}
		c.BaseURL = u
	}
	if v := os.Getenv("OPENTODO_ALLOW_SIGNUP"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("OPENTODO_ALLOW_SIGNUP must be true or false, got %q", v)
		}
		c.AllowSignup = b
	}
	if v := strings.TrimSpace(os.Getenv("OPENTODO_SETUP_TOKEN")); v != "" {
		if len(v) < MinSetupTokenLen {
			return fmt.Errorf("OPENTODO_SETUP_TOKEN must be at least %d characters when set", MinSetupTokenLen)
		}
		c.SetupToken = v
	}
	if v := os.Getenv("OPENTODO_SESSION_DAYS"); v != "" {
		d, err := strconv.Atoi(v)
		if err != nil || d < 1 {
			return fmt.Errorf("OPENTODO_SESSION_DAYS must be a positive integer, got %q", v)
		}
		c.SessionTTL = time.Duration(d) * 24 * time.Hour
	}
	if v := strings.TrimSpace(os.Getenv("OPENTODO_IMPORT_MAX_MB")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > MaxImportMaxMB {
			return fmt.Errorf("OPENTODO_IMPORT_MAX_MB must be an integer from 1 to %d, got %q", MaxImportMaxMB, v)
		}
		c.ImportMaxMB = n
	}
	return nil
}

// loadToggles reads the feature switches an operator may preset; unset ones
// stay nil.
func (c *Config) loadToggles() error {
	var err error
	if c.WebhooksAllowPrivate, err = optionalBool("OPENTODO_WEBHOOKS_ALLOW_PRIVATE"); err != nil {
		return err
	}
	if c.MCP, err = optionalBool("OPENTODO_MCP"); err != nil {
		return err
	}
	if c.MCPWrites, err = optionalBool("OPENTODO_MCP_WRITES"); err != nil {
		return err
	}
	if c.CalDAV, err = optionalBool("OPENTODO_CALDAV"); err != nil {
		return err
	}
	if c.CalendarFeeds, err = optionalBool("OPENTODO_CALENDAR_FEEDS"); err != nil {
		return err
	}
	return nil
}

// loadTrashAndPush reads the trash retention and the web push switch.
func (c *Config) loadTrashAndPush() error {
	if v := strings.TrimSpace(os.Getenv("OPENTODO_TRASH_RETENTION_DAYS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > MaxTrashRetentionDays {
			return fmt.Errorf("OPENTODO_TRASH_RETENTION_DAYS must be an integer from 0 (never purge) to %d, got %q", MaxTrashRetentionDays, v)
		}
		c.TrashRetentionDays = n
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OPENTODO_PUSH"))) {
	case "", "on", "true", "1", "yes":
	case "off", "false", "0", "no":
		c.PushDisabled = true
	default:
		return fmt.Errorf("OPENTODO_PUSH must be on or off, got %q", os.Getenv("OPENTODO_PUSH"))
	}
	return nil
}

// loadOIDC reads the single sign-on overrides (OPENTODO_OIDC_*).
func (c *Config) loadOIDC() error {
	c.OIDC = OIDCEnv{
		Issuer:       strings.TrimRight(strings.TrimSpace(os.Getenv("OPENTODO_OIDC_ISSUER")), "/"),
		ClientID:     strings.TrimSpace(os.Getenv("OPENTODO_OIDC_CLIENT_ID")),
		ClientSecret: strings.TrimSpace(os.Getenv("OPENTODO_OIDC_CLIENT_SECRET")),
		DisplayName:  strings.TrimSpace(os.Getenv("OPENTODO_OIDC_DISPLAY_NAME")),
	}
	if c.OIDC.Issuer != "" {
		if u, err := url.Parse(c.OIDC.Issuer); err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("OPENTODO_OIDC_ISSUER must be an https URL, got %q", c.OIDC.Issuer)
		}
	}
	if v := strings.TrimSpace(os.Getenv("OPENTODO_OIDC_SSO_ONLY")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("OPENTODO_OIDC_SSO_ONLY must be true or false, got %q", v)
		}
		c.OIDC.SSOOnly = &b
	}
	return nil
}

// loadDemo reads demo mode and its limits.
func (c *Config) loadDemo() error {
	if v := strings.TrimSpace(os.Getenv("OPENTODO_DEMO")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("OPENTODO_DEMO must be true or false, got %q", v)
		}
		c.Demo = b
	}
	for _, v := range []struct {
		name string
		dst  *int
	}{{"OPENTODO_DEMO_MAX_SANDBOXES", &c.DemoMaxSandboxes}, {"OPENTODO_DEMO_MAX_DB_MB", &c.DemoMaxDBMB}} {
		if raw := strings.TrimSpace(os.Getenv(v.name)); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 1000000 {
				return fmt.Errorf("%s must be a positive integer, got %q", v.name, raw)
			}
			*v.dst = n
		}
	}
	return nil
}

// optionalBool reads a boolean variable; unset (or blank) is nil.
func optionalBool(name string) (*bool, error) {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return nil, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return nil, fmt.Errorf("%s must be true or false, got %q", name, v)
	}
	return &b, nil
}

func getenv(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// optionalInt reads an optional whole-number variable within [min, max]; an
// invalid value is an error naming the variable, so startup stops.
func optionalInt(name string, min, max int) (*int, error) {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return nil, fmt.Errorf("%s must be a whole number from %d to %d, got %q", name, min, max, v)
	}
	return &n, nil
}
