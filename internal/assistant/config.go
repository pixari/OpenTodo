// Package assistant is the in-app assistant (OpenSpec change `in-app-assistant`):
// the owner's configuration and provider keys, per-user consent and token
// usage, the model providers (Anthropic through the official Go SDK, and one
// standard-library Chat Completions adapter for OpenAI, Gemini and compatible
// endpoints), and the agent loop that runs read tools and *plans* write tools
// from the shared registry (internal/agenttools) without ever applying them.
//
// The server never writes on behalf of the assistant. A turn ends with at most
// one proposed change set; the browser shows it for review and applies the
// confirmed part through mutateMany with device assistant:<device-id>.
package assistant

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/audit"
	"github.com/pixari/opentodo/internal/settings"
	"github.com/pixari/opentodo/internal/webhook"
)

// SettingKey is the owner settings key (JSON value in the settings table).
const SettingKey = "assistant"

// SecretsName is the secrets file <data>/secrets/assistant.json.
const SecretsName = "assistant"

// Provider names.
const (
	Anthropic  = "anthropic"
	OpenAI     = "openai"
	Gemini     = "gemini"
	Compatible = "compatible"
)

// ProviderNames lists the providers in display order.
var ProviderNames = []string{Anthropic, OpenAI, Gemini, Compatible}

// Built-in endpoints. Only the Anthropic model ids are built in (design D3);
// the other providers' model ids are settings the owner types.
const (
	DefaultAnthropicModel = "claude-opus-5-5"
	OpenAIBaseURL         = "https://api.openai.com/v1"
	// GeminiBaseURL is Google's documented OpenAI-compatible endpoint.
	GeminiBaseURL = "https://generativelanguage.googleapis.com/v1beta/openai"
)

// AnthropicModels are offered in the model picker; the owner may type any id.
var AnthropicModels = []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}

// DefaultMonthlyCap is the default per-user monthly token cap (0 = unlimited).
const DefaultMonthlyCap = 500_000

// DisclosureVersion is bumped whenever the consent text changes materially;
// earlier consents then no longer count.
const DisclosureVersion = 1

// ProviderSettings is one provider's owner configuration.
type ProviderSettings struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model"`
	// BaseURL is the compatible provider's endpoint (owner only).
	BaseURL string `json:"base_url,omitempty"`
}

// Settings is the owner configuration (settings key "assistant"). Keys are not
// part of it: they live in the secrets file.
type Settings struct {
	Enabled              bool                        `json:"enabled"`
	Providers            map[string]ProviderSettings `json:"providers"`
	DefaultProvider      string                      `json:"default_provider"`
	AllowMemberKeys      bool                        `json:"allow_member_keys"`
	MonthlyTokenCap      int64                       `json:"monthly_token_cap_per_user"`
	AllowPrivateEndpoint bool                        `json:"allow_private_endpoint"`
	// CapMemberKeys counts turns on a member's own key against the monthly
	// cap (assistant-member-provider). Off by default: the member pays.
	CapMemberKeys bool `json:"cap_member_keys"`
	// Device is the on-device assistant for encrypted accounts
	// (assistant-on-device D2).
	Device DeviceSettings `json:"device"`
}

// Defaults is the configuration of a fresh server: off.
func Defaults() Settings {
	return Settings{
		Providers: map[string]ProviderSettings{
			Anthropic: {Model: DefaultAnthropicModel}, OpenAI: {}, Gemini: {}, Compatible: {},
		},
		DefaultProvider: Anthropic,
		MonthlyTokenCap: DefaultMonthlyCap,
	}
}

// normalise fills missing providers so callers can index freely.
func (s *Settings) normalise() {
	if s.Providers == nil {
		s.Providers = map[string]ProviderSettings{}
	}
	for _, n := range ProviderNames {
		if _, ok := s.Providers[n]; !ok {
			p := ProviderSettings{}
			if n == Anthropic {
				p.Model = DefaultAnthropicModel
			}
			s.Providers[n] = p
		}
	}
	if s.DefaultProvider == "" {
		s.DefaultProvider = Anthropic
	}
	s.Device.normalise()
}

// Active reports whether turns can run at all: enabled with an enabled default provider.
func (s Settings) Active() bool {
	return s.Enabled && s.Providers[s.DefaultProvider].Enabled
}

// DeviceActive reports whether the on-device assistant is offered to
// encrypted accounts: the main switch, the device switch and a provider.
func (s Settings) DeviceActive() bool {
	return s.Enabled && s.Device.Enabled && len(s.Device.Providers) > 0
}

// ProviderLabel is the name shown in the disclosure.
func ProviderLabel(name string) string {
	switch name {
	case Anthropic:
		return "Anthropic (Claude)"
	case OpenAI:
		return "OpenAI"
	case Gemini:
		return "Google Gemini"
	case Compatible:
		return "the model server your server owner set up"
	}
	return name
}

// InvalidError is a refused settings change: Field names the offending input.
type InvalidError struct {
	Field string
	Msg   string
}

func (e *InvalidError) Error() string { return e.Field + ": " + e.Msg }

func invalid(field, msg string) *InvalidError { return &InvalidError{Field: field, Msg: msg} }

// ErrPrivateTarget is a compatible base URL that resolves only to private
// addresses while the owner has not allowed private endpoints.
var ErrPrivateTarget = webhook.ErrPrivateTarget

func known(name string) bool {
	for _, n := range ProviderNames {
		if n == name {
			return true
		}
	}
	return false
}

// validateStatic checks what needs no network or secrets.
func (s Settings) validateStatic() error {
	for name := range s.Providers {
		if !known(name) {
			return invalid("providers."+name, "unknown provider (expected anthropic, openai, gemini or compatible)")
		}
	}
	if !known(s.DefaultProvider) {
		return invalid("default_provider", "unknown provider (expected anthropic, openai, gemini or compatible)")
	}
	if s.MonthlyTokenCap < 0 || s.MonthlyTokenCap > 1_000_000_000_000 {
		return invalid("monthly_token_cap_per_user", "must be 0 (unlimited) or a positive number of tokens")
	}
	for _, name := range ProviderNames {
		if err := validateProvider(name, s.Providers[name], "a model id is required to enable this provider"); err != nil {
			return err
		}
	}
	if err := s.Device.validate(); err != nil {
		return err
	}
	// An owner whose people all use encryption needs no server provider when
	// devices may call providers themselves (assistant-on-device D2).
	if s.Enabled && !s.Providers[s.DefaultProvider].Enabled && !s.Device.Enabled {
		return invalid("default_provider", "the default provider must be enabled")
	}
	return nil
}

// ---- secrets ----

// OperatorKey names the owner's key for a provider in the secrets file.
func OperatorKey(provider string) string { return "operator:" + provider }

// UserKey names a user's own key for a provider in the secrets file.
func UserKey(userID, provider string) string { return "user:" + userID + ":" + provider }

// ---- store ----

// Store holds the owner settings, the secrets file, consent and usage.
type Store struct {
	db      *sql.DB
	set     *settings.Store
	secrets *settings.SecretsFile
	now     func() time.Time
}

// NewStore wires the store over the database and <dataDir>/secrets/assistant.json.
func NewStore(db *sql.DB, dataDir string, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, set: settings.New(db), secrets: settings.NewSecretsFile(dataDir, SecretsName), now: now}
}

// SecretsPath is the secrets file location (docs and tests).
func (st *Store) SecretsPath() string { return st.secrets.Path() }

// Settings loads the owner configuration (Defaults when unset). A read error
// reads as disabled at call sites.
func (st *Store) Settings(ctx context.Context) (Settings, error) {
	s := Defaults()
	if _, err := st.set.Get(ctx, SettingKey, &s); err != nil {
		return Defaults(), err
	}
	s.normalise()
	return s, nil
}

// Secrets loads the key file. The value redacts itself in JSON and logs.
func (st *Store) Secrets() (settings.Secrets, error) { return st.secrets.Load() }

// KeyChange is a requested key update: nil keeps, "" clears, a value sets.
type KeyChange = map[string]*string

// SaveSettings validates next with the keys that will be in effect, stores
// settings and keys, and records settings.changed for every changed setting
// (keys as unset/set, never values). check resolves the compatible base URL.
// validateProvider checks one provider's settings; an enabled provider needs
// a model id (noModel is the message when it is missing) and, for the
// compatible provider, a valid base URL. Saving and "Test connection" share it.
func validateProvider(name string, p ProviderSettings, noModel string) error {
	if len(p.Model) > 200 || strings.ContainsAny(p.Model, "\r\n\t") {
		return invalid("providers."+name+".model", "must be a model id of at most 200 characters")
	}
	if name != Compatible && p.BaseURL != "" {
		return invalid("providers."+name+".base_url", "only the compatible provider takes a base URL")
	}
	if !p.Enabled {
		return nil
	}
	if strings.TrimSpace(p.Model) == "" {
		return invalid("providers."+name+".model", noModel)
	}
	if name == Compatible {
		if strings.TrimSpace(p.BaseURL) == "" {
			return invalid("providers.compatible.base_url", "a base URL is required for the compatible provider")
		}
		if _, err := webhook.ValidateURL(p.BaseURL); err != nil {
			return invalid("providers.compatible.base_url", strings.TrimPrefix(err.Error(), webhook.ErrBadURL.Error()+": "))
		}
	}
	return nil
}

func (st *Store) SaveSettings(ctx context.Context, actorID string, next Settings, keys KeyChange, check func(ctx context.Context, rawURL string, allowPrivate bool) error, rec *audit.Recorder) (Settings, error) {
	next.normalise()
	if err := next.validateStatic(); err != nil {
		return Settings{}, err
	}
	for name := range keys {
		if !known(name) {
			return Settings{}, invalid("keys."+name, "unknown provider")
		}
	}
	sec, err := st.secrets.Load()
	if err != nil {
		return Settings{}, err
	}
	effective := func(p string) bool {
		if v, ok := keys[p]; ok && v != nil {
			return *v != ""
		}
		return sec.Has(OperatorKey(p))
	}
	for _, name := range []string{Anthropic, OpenAI, Gemini} {
		if next.Providers[name].Enabled && !effective(name) && !next.AllowMemberKeys {
			return Settings{}, invalid("keys."+name, "an API key is required to enable this provider (or allow members to bring their own)")
		}
	}
	if c := next.Providers[Compatible]; c.Enabled && check != nil {
		if err := check(ctx, c.BaseURL, next.AllowPrivateEndpoint); err != nil {
			return Settings{}, err
		}
	}
	prev, err := st.Settings(ctx)
	if err != nil {
		return Settings{}, err
	}
	changes := map[string]*string{}
	for name, v := range keys {
		if v == nil {
			continue
		}
		val := strings.TrimSpace(*v)
		changes[OperatorKey(name)] = &val
	}
	if err := st.secrets.Update(changes); err != nil {
		return Settings{}, err
	}
	if err := st.set.Set(ctx, SettingKey, next); err != nil {
		return Settings{}, err
	}
	if rec != nil {
		for _, ev := range diffSettings(prev, next) {
			rec.Record(ctx, audit.SettingsChanged(actorID, ev[0], ev[1], ev[2]))
		}
		for _, name := range sortedKeys(keys) {
			v := keys[name]
			if v == nil {
				continue
			}
			from, to := presence(sec.Has(OperatorKey(name))), presence(strings.TrimSpace(*v) != "")
			if from != to {
				rec.Record(ctx, audit.SettingsChanged(actorID, "assistant."+name+".key", from, to))
			}
		}
	}
	return next, nil
}

func presence(set bool) string {
	if set {
		return "set"
	}
	return "unset"
}

func sortedKeys(m map[string]*string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// diffSettings lists [setting, from, to] for every changed value. A base URL
// is recorded by host only (it may carry credentials in its user info).
func diffSettings(a, b Settings) [][3]string {
	var out [][3]string
	add := func(name, from, to string) {
		if from != to {
			out = append(out, [3]string{name, from, to})
		}
	}
	add("assistant.enabled", fmt.Sprint(a.Enabled), fmt.Sprint(b.Enabled))
	add("assistant.default_provider", a.DefaultProvider, b.DefaultProvider)
	add("assistant.allow_member_keys", fmt.Sprint(a.AllowMemberKeys), fmt.Sprint(b.AllowMemberKeys))
	add("assistant.monthly_token_cap_per_user", fmt.Sprint(a.MonthlyTokenCap), fmt.Sprint(b.MonthlyTokenCap))
	add("assistant.allow_private_endpoint", fmt.Sprint(a.AllowPrivateEndpoint), fmt.Sprint(b.AllowPrivateEndpoint))
	add("assistant.cap_member_keys", fmt.Sprint(a.CapMemberKeys), fmt.Sprint(b.CapMemberKeys))
	add("assistant.device.enabled", fmt.Sprint(a.Device.Enabled), fmt.Sprint(b.Device.Enabled))
	add("assistant.device.providers", strings.Join(a.Device.Providers, ","), strings.Join(b.Device.Providers, ","))
	add("assistant.device.origins", strings.Join(a.Device.Origins, ","), strings.Join(b.Device.Origins, ","))
	for _, n := range ProviderNames {
		pa, pb := a.Providers[n], b.Providers[n]
		add("assistant."+n+".enabled", fmt.Sprint(pa.Enabled), fmt.Sprint(pb.Enabled))
		add("assistant."+n+".model", pa.Model, pb.Model)
		add("assistant."+n+".base_url", hostOf(pa.BaseURL), hostOf(pb.BaseURL))
	}
	return out
}

func hostOf(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "invalid"
	}
	return u.Scheme + "://" + u.Host
}

// ---- per-user keys ----

// SetUserKey stores or clears a user's own key for a provider and records
// settings.changed (assistant.own_key.<provider>, unset/set).
func (st *Store) SetUserKey(ctx context.Context, userID, provider, key string, rec *audit.Recorder) error {
	if !known(provider) {
		return invalid("provider", "unknown provider")
	}
	sec, err := st.secrets.Load()
	if err != nil {
		return err
	}
	key = strings.TrimSpace(key)
	name := UserKey(userID, provider)
	from, to := presence(sec.Has(name)), presence(key != "")
	if err := st.secrets.Update(map[string]*string{name: &key}); err != nil {
		return err
	}
	if rec != nil && from != to {
		rec.Record(ctx, audit.SettingsChanged(userID, "assistant.own_key."+provider, from, to))
	}
	return nil
}

// RemoveUserKeys deletes every key a user stored (account deletion).
func (st *Store) RemoveUserKeys(userID string) error {
	empty := ""
	changes := map[string]*string{}
	for _, p := range ProviderNames {
		changes[UserKey(userID, p)] = &empty
	}
	return st.secrets.Update(changes)
}

// KeyFor returns the key a turn of userID uses for provider: the user's own key
// when the owner allows member keys and one is set, otherwise the operator's.
func (st *Store) KeyFor(userID, provider string, s Settings) (key string, own bool, err error) {
	sec, err := st.secrets.Load()
	if err != nil {
		return "", false, err
	}
	if s.AllowMemberKeys && sec.Has(UserKey(userID, provider)) {
		return sec.Value(UserKey(userID, provider)), true, nil
	}
	return sec.Value(OperatorKey(provider)), false, nil
}

// ---- consent ----

// Consent is a user's recorded acceptance of the disclosure.
type Consent struct {
	AcceptedAt        int64  `json:"accepted_at"`
	DisclosureVersion int    `json:"disclosure_version"`
	Provider          string `json:"provider"`
}

// Consent returns the user's consent, or nil.
func (st *Store) Consent(ctx context.Context, userID string) (*Consent, error) {
	var c Consent
	err := st.db.QueryRowContext(ctx, `SELECT accepted_at, disclosure_version, provider FROM assistant_consent WHERE user_id = ?`, userID).
		Scan(&c.AcceptedAt, &c.DisclosureVersion, &c.Provider)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read assistant consent: %w", err)
	}
	return &c, nil
}

// Valid reports whether a consent covers the current disclosure and provider.
func (c *Consent) Valid(provider string) bool {
	return c != nil && c.Provider == provider && c.DisclosureVersion == DisclosureVersion
}

// SetConsent records (accept) or withdraws consent.
func (st *Store) SetConsent(ctx context.Context, userID, provider string, accept bool) error {
	if !accept {
		_, err := st.db.ExecContext(ctx, `DELETE FROM assistant_consent WHERE user_id = ?`, userID)
		return err
	}
	_, err := st.db.ExecContext(ctx, `INSERT INTO assistant_consent(user_id, accepted_at, disclosure_version, provider) VALUES(?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET accepted_at = excluded.accepted_at, disclosure_version = excluded.disclosure_version, provider = excluded.provider`,
		userID, st.now().UnixMilli(), DisclosureVersion, provider)
	if err != nil {
		return fmt.Errorf("store assistant consent: %w", err)
	}
	return nil
}

// ---- usage ----

// Usage is a user's token usage in one UTC month: every turn, and the part
// of it that ran on the user's own key.
type Usage struct {
	Month        string   `json:"month"`
	InputTokens  int64    `json:"input_tokens"`
	OutputTokens int64    `json:"output_tokens"`
	Turns        int64    `json:"turns"`
	Cap          int64    `json:"cap"`
	ResetsAt     string   `json:"resets_at"`
	Own          OwnUsage `json:"own_key"`
}

// OwnUsage is the part of a month's usage that ran on the user's own key.
type OwnUsage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
	Turns        int64 `json:"turns"`
}

// Total is input plus output tokens.
func (u Usage) Total() int64 { return u.InputTokens + u.OutputTokens }

// Total is input plus output tokens on the user's own key.
func (o OwnUsage) Total() int64 { return o.InputTokens + o.OutputTokens }

// Counted is the usage measured against the monthly cap: everything when the
// owner caps member keys, otherwise everything but the own-key turns.
func (u Usage) Counted(capMemberKeys bool) int64 {
	if capMemberKeys {
		return u.Total()
	}
	return max(0, u.Total()-u.Own.Total())
}

// month is the UTC calendar month of t and the first day of the next one.
func month(t time.Time) (string, string) {
	t = t.UTC()
	next := time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return t.Format("2006-01"), next.Format("2006-01-02")
}

// Usage returns this month's usage for the user with the cap applied.
func (st *Store) Usage(ctx context.Context, userID string, cap int64) (Usage, error) {
	m, reset := month(st.now())
	u := Usage{Month: m, Cap: cap, ResetsAt: reset}
	err := st.db.QueryRowContext(ctx, `SELECT input_tokens, output_tokens, turns FROM assistant_usage WHERE user_id = ? AND month = ?`, userID, m).
		Scan(&u.InputTokens, &u.OutputTokens, &u.Turns)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return u, fmt.Errorf("read assistant usage: %w", err)
	}
	err = st.db.QueryRowContext(ctx, `SELECT input_tokens, output_tokens, turns FROM assistant_usage_own_key WHERE user_id = ? AND month = ?`, userID, m).
		Scan(&u.Own.InputTokens, &u.Own.OutputTokens, &u.Own.Turns)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return u, fmt.Errorf("read assistant own-key usage: %w", err)
	}
	return u, nil
}

// AddSkillUse counts one turn that ran the named skill this month.
func (st *Store) AddSkillUse(ctx context.Context, userID, skill string) error {
	m, _ := month(st.now())
	_, err := st.db.ExecContext(ctx, `INSERT INTO assistant_skill_usage(user_id, month, skill, turns) VALUES(?,?,?,1)
		ON CONFLICT(user_id, month, skill) DO UPDATE SET turns = turns + 1`, userID, m, skill)
	if err != nil {
		return fmt.Errorf("record skill use: %w", err)
	}
	return nil
}

// SkillUses returns this month's skill runs of a user, by skill id.
func (st *Store) SkillUses(ctx context.Context, userID string) (map[string]int64, error) {
	m, _ := month(st.now())
	rows, err := st.db.QueryContext(ctx, `SELECT skill, turns FROM assistant_skill_usage WHERE user_id = ? AND month = ?`, userID, m)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

// AddUsage adds one turn's tokens to this month's row; own marks a turn on
// the user's own key, which is also added to the own-key row.
func (st *Store) AddUsage(ctx context.Context, userID string, in, out int64, own bool) error {
	m, _ := month(st.now())
	tables := []string{"assistant_usage"}
	if own {
		tables = append(tables, "assistant_usage_own_key")
	}
	for _, tbl := range tables {
		_, err := st.db.ExecContext(ctx, `INSERT INTO `+tbl+`(user_id, month, input_tokens, output_tokens, turns) VALUES(?,?,?,?,1)
		ON CONFLICT(user_id, month) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens,
		output_tokens = output_tokens + excluded.output_tokens, turns = turns + 1`, userID, m, in, out)
		if err != nil {
			return fmt.Errorf("record assistant usage: %w", err)
		}
	}
	return nil
}
