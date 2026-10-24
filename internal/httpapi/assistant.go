package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/agenttools"
	"github.com/pixari/opentodo/internal/assistant"
	"github.com/pixari/opentodo/internal/auth"
)

// In-app assistant (OpenSpec change `in-app-assistant`): the owner's settings
// and provider keys, the user's consent and own key, usage, and the turn
// route that streams an answer and at most one proposed change set. The
// server never applies a proposal: the browser does, after review, through
// mutateMany with device assistant:<device-id>.

// Turn limits (design D5).
const (
	turnMaxBody     = 256 << 10
	turnMaxMessages = 40
	turnTimeout     = 5 * time.Minute
	// A member's "Test connection" of their own provider
	// (assistant-member-provider): at most 5 per account in 10 minutes.
	memberTestLimit  = 5
	memberTestWindow = 10 * time.Minute
)

// WithAssistantSetup adjusts the assistant service after it is built (tests
// point the providers at httptest fakes through it).
func WithAssistantSetup(f func(*assistant.Service)) Option {
	return func(s *Server) { s.assistantSetup = f }
}

func (s *Server) registerAssistantRoutes(mux *routes) {
	store := assistant.NewStore(s.sync.DB(), s.cfg.DataDir, nil)
	s.assistant = assistant.NewService(store, &assistant.Loop{Tools: s.agentTools, Sync: s.sync, Log: s.log})
	s.assistantTestLimiter = newRateLimiter(memberTestLimit, memberTestWindow)
	if s.assistantSetup != nil {
		s.assistantSetup(s.assistant)
	}
	mux.handle("GET /api/v1/settings/assistant", signedIn, s.handleGetAssistantSettings)
	mux.handle("PUT /api/v1/settings/assistant", ownerOnly("manage the assistant settings").credential().demoDenied(), s.handlePutAssistantSettings)
	mux.handle("POST /api/v1/settings/assistant/test", ownerOnly("manage the assistant settings").demoDenied(), s.handleTestAssistant)
	mux.handle("GET /api/v1/me/assistant", signedIn.demoDenied(), s.handleGetMyAssistant)
	mux.handle("PUT /api/v1/me/assistant", signedIn.fullTokens().demoDenied(), s.handlePutMyAssistant)
	mux.handle("GET /api/v1/me/assistant/usage", signedIn.demoDenied(), s.handleMyAssistantUsage)
	mux.handle("POST /api/v1/me/assistant/test", signedIn.sessionOnly().demoDenied(), s.handleTestMyAssistant)
	mux.handle("POST /api/v1/assistant/turn", signedIn.sessionOnly().demoDenied(), s.handleAssistantTurn)
	mux.handle("GET /api/v1/assistant/skills", signedIn.demoDenied(), s.handleAssistantSkills)
}

// handleAssistantSkills lists the built-in skills (assistant-skills), or an
// empty list when the assistant is not available to this user: not enabled
// on the server, or an end-to-end encrypted account.
func (s *Server) handleAssistantSkills(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := []agenttools.Skill{}
	if s.assistantSettings(ctx).Active() {
		enc, err := s.keys().Enabled(ctx, userFrom(ctx).ID)
		if err != nil {
			s.internal(w, err)
			return
		}
		if !enc {
			out = agenttools.Skills
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"skills": out})
}

// ---- owner settings ----

func (s *Server) assistantSettings(ctx context.Context) assistant.Settings {
	set, err := s.assistant.Store.Settings(ctx)
	if err != nil {
		s.log.Error("assistant settings unreadable; treating the assistant as off", "err", err)
		set = assistant.Defaults()
	}
	if s.demo != nil {
		set.Enabled = false
	}
	return set
}

// ownerView is the owner's settings with key presence flags, never keys.
func (s *Server) ownerView(ctx context.Context) (map[string]any, error) {
	set := s.assistantSettings(ctx)
	sec, err := s.assistant.Store.Secrets()
	if err != nil {
		return nil, err
	}
	providers := map[string]any{}
	for _, n := range assistant.ProviderNames {
		p := set.Providers[n]
		v := map[string]any{"enabled": p.Enabled, "model": p.Model, "key_set": sec.Has(assistant.OperatorKey(n)), "label": assistant.ProviderLabel(n)}
		if n == assistant.Compatible {
			v["base_url"] = p.BaseURL
		}
		providers[n] = v
	}
	ownKeyMembers, err := s.assistant.Store.CountMemberKeyUsers(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"enabled": set.Enabled, "active": set.Active(), "providers": providers, "default_provider": set.DefaultProvider,
		"allow_member_keys": set.AllowMemberKeys, "monthly_token_cap_per_user": set.MonthlyTokenCap,
		"allow_private_endpoint": set.AllowPrivateEndpoint,
		"cap_member_keys":        set.CapMemberKeys,
		"member_providers":       assistant.MemberProviders,
		"own_key_members":        ownKeyMembers,
		"anthropic_models":       assistant.AnthropicModels,
		"default_model":          assistant.DefaultAnthropicModel,
		"device":                 set.Device,
		"device_origins":         assistant.ProviderOrigins,
	}, nil
}

// memberView is the status every account may read: no keys, no base URL.
func (s *Server) memberView(ctx context.Context) map[string]any {
	set := s.assistantSettings(ctx)
	p := set.Providers[set.DefaultProvider]
	return map[string]any{"enabled": set.Active(), "provider": set.DefaultProvider, "provider_label": assistant.ProviderLabel(set.DefaultProvider),
		"model": p.Model, "allow_member_keys": set.AllowMemberKeys, "monthly_token_cap_per_user": set.MonthlyTokenCap,
		"cap_member_keys": set.CapMemberKeys}
}

func (s *Server) handleGetAssistantSettings(w http.ResponseWriter, r *http.Request) {
	if u := userFrom(r.Context()); u.Role != "owner" {
		writeJSON(w, http.StatusOK, s.memberView(r.Context()))
		return
	}
	v, err := s.ownerView(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handlePutAssistantSettings(w http.ResponseWriter, r *http.Request) {
	cur := s.assistantSettings(r.Context())
	var in struct {
		assistant.Settings
		Keys map[string]*string `json:"keys"`
	}
	in.Settings = cur
	// Provider objects are replaced as a whole, so start from a fresh map.
	in.Settings.Providers = map[string]assistant.ProviderSettings{}
	for k, v := range cur.Providers {
		in.Settings.Providers[k] = v
	}
	if err := readJSONLimit(r, &in, 64<<10); err != nil {
		badBodyWith(w, err, "invalid_input", err.Error())
		return
	}
	actor := userFrom(r.Context()).ID
	_, err := s.assistant.Store.SaveSettings(r.Context(), actor, in.Settings, in.Keys, s.assistant.Net.CheckBaseURL, s.audit)
	var inv *assistant.InvalidError
	switch {
	case errors.As(err, &inv):
		writeError(w, http.StatusBadRequest, "invalid_input", inv.Error())
		return
	case errors.Is(err, assistant.ErrPrivateTarget):
		writeError(w, http.StatusBadRequest, "private_target", "the base URL resolves to a private, loopback or link-local address; turn on \"Allow private endpoints\" to use a model server on your own network")
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	s.forgetCSP()
	v, err := s.ownerView(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleTestAssistant(w http.ResponseWriter, r *http.Request) {
	// The on-screen values are optional; absent ones fall back to the saved
	// settings (assistant-test-unsaved-settings).
	var in struct {
		Provider             string  `json:"provider"`
		Model                *string `json:"model"`
		BaseURL              *string `json:"base_url"`
		Key                  *string `json:"key"`
		AllowPrivateEndpoint *bool   `json:"allow_private_endpoint"`
	}
	if err := readJSON(r, &in); err != nil {
		badBodyWith(w, err, "invalid_input", err.Error())
		return
	}
	res := s.assistant.TestConnection(r.Context(), in.Provider, s.assistantSettings(r.Context()),
		assistant.Draft{Model: in.Model, BaseURL: in.BaseURL, Key: in.Key, AllowPrivateEndpoint: in.AllowPrivateEndpoint})
	if res.Code == "invalid_input" {
		writeError(w, http.StatusBadRequest, "invalid_input", res.Message)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ---- the user's consent, own key and usage ----

// consentFields lists what the disclosure says may be sent.
var consentFields = []string{"task titles and descriptions", "project, section and label names", "due dates, priorities and completion",
	"comments", "names of members of shared projects", "your display name, today's date and your time zone", "the messages you type"}

func (s *Server) myAssistant(ctx context.Context, u *auth.User) (map[string]any, error) {
	set := s.assistantSettings(ctx)
	encrypted, err := s.keys().Enabled(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	consent, err := s.assistant.Store.Consent(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	sec, err := s.assistant.Store.Secrets()
	if err != nil {
		return nil, err
	}
	route, err := s.assistant.Store.Resolve(ctx, u.ID, set)
	if err != nil {
		return nil, err
	}
	choice, err := s.assistant.Store.MemberChoice(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	reason := ""
	mode := "server"
	switch {
	case !set.Enabled:
		reason = "disabled"
	case encrypted && set.DeviceActive():
		mode = "device"
	case !set.Active():
		reason = "no_provider"
	case encrypted:
		reason = "encryption_enabled"
	}
	if reason != "" {
		mode = ""
	}
	p := set.Providers[set.DefaultProvider]
	source := "server"
	if route.Member {
		source = "own"
	}
	// provider, provider_label and model name what a turn uses now (the
	// member's own provider when it is in effect): the disclosure and the
	// consent are about that provider (assistant-member-provider).
	out := map[string]any{
		"available": reason == "", "enabled": set.Active() || mode == "device", "reason": reason, "mode": mode,
		"provider": route.Provider, "provider_label": assistant.ProviderLabel(route.Provider), "model": route.Model,
		"source": source, "own_key_in_use": route.Own,
		"server_provider": set.DefaultProvider, "server_provider_label": assistant.ProviderLabel(set.DefaultProvider), "server_model": p.Model,
		"consented": consent.Valid(route.Provider), "disclosure_version": assistant.DisclosureVersion, "fields": consentFields,
		"allow_member_keys": set.AllowMemberKeys, "own_key_set": sec.Has(assistant.UserKey(u.ID, route.Provider)),
		"server_own_key_set": sec.Has(assistant.UserKey(u.ID, set.DefaultProvider)),
		"operator_key_set":   sec.Has(assistant.OperatorKey(set.DefaultProvider)) || set.DefaultProvider == assistant.Compatible,
		"cap_member_keys":    set.CapMemberKeys, "own_provider": nil,
		"member_providers": assistant.MemberProviders, "anthropic_models": assistant.AnthropicModels,
	}
	if choice != nil {
		out["own_provider"] = map[string]any{"provider": choice.Provider, "provider_label": assistant.ProviderLabel(choice.Provider),
			"model": choice.Model, "key_set": sec.Has(assistant.UserKey(u.ID, choice.Provider))}
	}
	if consent != nil {
		out["consent"] = consent
	}
	if encrypted {
		out["device"] = deviceView(set, consent)
	}
	return out, nil
}

func (s *Server) handleGetMyAssistant(w http.ResponseWriter, r *http.Request) {
	v, err := s.myAssistant(r.Context(), userFrom(r.Context()))
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handlePutMyAssistant(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := userFrom(ctx)
	var in struct {
		Consent  *bool   `json:"consent"`
		Provider string  `json:"provider"`
		OwnKey   *string `json:"own_key"`
		// OwnProvider is the member's own provider ("" = use the server's
		// assistant) and OwnModel its model (assistant-member-provider).
		OwnProvider *string `json:"own_provider"`
		OwnModel    *string `json:"own_model"`
	}
	if err := readJSONLimit(r, &in, 16<<10); err != nil {
		badBodyWith(w, err, "invalid_input", err.Error())
		return
	}
	set := s.assistantSettings(ctx)
	if strings.HasPrefix(in.Provider, assistant.DeviceConsentPrefix) {
		// Consent for the on-device assistant (assistant-on-device D6).
		if in.Consent == nil || in.OwnKey != nil || in.OwnProvider != nil || in.OwnModel != nil {
			writeError(w, http.StatusBadRequest, "invalid_input", "a device provider takes consent only")
			return
		}
		s.putDeviceConsent(w, r, set, strings.TrimPrefix(in.Provider, assistant.DeviceConsentPrefix), *in.Consent)
		return
	}
	if in.Consent == nil && in.OwnKey == nil && in.OwnProvider == nil && in.OwnModel == nil {
		writeError(w, http.StatusBadRequest, "invalid_input", "consent: true or false, own_key, own_provider or own_model is required")
		return
	}
	// Storing a key or choosing a provider needs the owner's permission;
	// removing either never does.
	addsKey := in.OwnKey != nil && strings.TrimSpace(*in.OwnKey) != ""
	choosing := (in.OwnProvider != nil && *in.OwnProvider != "") || in.OwnModel != nil
	if (addsKey || choosing) && !set.AllowMemberKeys {
		writeError(w, http.StatusForbidden, "forbidden", "the server owner has not allowed members to bring their own key")
		return
	}
	if in.OwnKey != nil && len(*in.OwnKey) > 1024 {
		writeError(w, http.StatusBadRequest, "invalid_input", "own_key: at most 1024 characters")
		return
	}
	cur, err := s.assistant.Store.MemberChoice(ctx, u.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	sec, err := s.assistant.Store.Secrets()
	if err != nil {
		s.internal(w, err)
		return
	}
	// next is the member's choice after this request (nil: the server's assistant).
	next := cur
	if in.OwnProvider != nil {
		next = nil
		if p := strings.TrimSpace(*in.OwnProvider); p != "" {
			model := ""
			if in.OwnModel != nil {
				model = strings.TrimSpace(*in.OwnModel)
			} else if cur != nil && cur.Provider == p {
				model = cur.Model
			}
			next = &assistant.MemberChoice{Provider: p, Model: model}
		}
	} else if in.OwnModel != nil {
		if cur == nil {
			writeError(w, http.StatusBadRequest, "invalid_input", "own_model: choose your own provider first (own_provider)")
			return
		}
		next = &assistant.MemberChoice{Provider: cur.Provider, Model: strings.TrimSpace(*in.OwnModel)}
	}
	if next != nil {
		if err := assistant.ValidateMemberChoice(next.Provider, next.Model); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_input", err.Error())
			return
		}
	}
	// The key belongs to the member's own provider when one is chosen, else
	// to the owner's provider (as before this change).
	keyProvider := set.DefaultProvider
	if next != nil {
		keyProvider = next.Provider
	}
	removesKey := in.OwnKey != nil && !addsKey
	if next != nil && removesKey {
		// Removing the key of your own provider goes back to the server's assistant.
		next = nil
	}
	if next != nil && !addsKey && !sec.Has(assistant.UserKey(u.ID, next.Provider)) {
		writeError(w, http.StatusBadRequest, "invalid_input", "own_key: enter your API key for "+assistant.ProviderLabel(next.Provider))
		return
	}
	// The provider a turn will use once this request is applied.
	effective := set.DefaultProvider
	if set.AllowMemberKeys && next != nil {
		effective = next.Provider
	}
	if in.Consent != nil && *in.Consent {
		if !set.Active() {
			writeError(w, http.StatusConflict, "assistant_disabled", "the assistant is not enabled on this server")
			return
		}
		if enc, err := s.keys().Enabled(ctx, u.ID); err != nil {
			s.internal(w, err)
			return
		} else if enc {
			writeError(w, http.StatusConflict, "encryption_enabled", "the assistant cannot read end-to-end encrypted tasks")
			return
		}
		// The disclosure the person accepted must name the provider in effect.
		if in.Provider != effective {
			writeError(w, http.StatusConflict, "provider_changed", "the provider changed; read the updated disclosure and accept again")
			return
		}
	}
	if in.OwnKey != nil {
		if err := s.assistant.Store.SetUserKey(ctx, u.ID, keyProvider, *in.OwnKey, s.audit); err != nil {
			s.internal(w, err)
			return
		}
	}
	if cur != nil && (next == nil || next.Provider != cur.Provider) && !(in.OwnKey != nil && keyProvider == cur.Provider) {
		// Leaving the provider you chose (for another one or for the
		// server's assistant) removes the key you stored for it.
		if err := s.assistant.Store.SetUserKey(ctx, u.ID, cur.Provider, "", s.audit); err != nil {
			s.internal(w, err)
			return
		}
	}
	if !sameChoice(cur, next) {
		provider, model := "", ""
		if next != nil {
			provider, model = next.Provider, next.Model
		}
		if err := s.assistant.Store.SetMemberChoice(ctx, u.ID, provider, model, s.audit); err != nil {
			s.internal(w, err)
			return
		}
	}
	if in.Consent != nil {
		if err := s.assistant.Store.SetConsent(ctx, u.ID, effective, *in.Consent); err != nil {
			s.internal(w, err)
			return
		}
	}
	s.handleGetMyAssistant(w, r)
}

func sameChoice(a, b *assistant.MemberChoice) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Provider == b.Provider && a.Model == b.Model
}

// handleTestMyAssistant is a member's "Test connection" of their own
// provider, model and key: signed-in sessions only, rate limited, and only
// toward the built-in host of the provider they chose.
func (s *Server) handleTestMyAssistant(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := userFrom(ctx)
	set := s.assistantSettings(ctx)
	if !set.Active() {
		writeError(w, http.StatusConflict, "assistant_disabled", "the assistant is not enabled on this server")
		return
	}
	if !set.AllowMemberKeys {
		writeError(w, http.StatusForbidden, "forbidden", "the server owner has not allowed members to bring their own key")
		return
	}
	// The on-screen provider, model and key are optional; absent ones fall
	// back to the member's saved choice (assistant-test-unsaved-settings).
	var in struct {
		Provider *string `json:"provider"`
		Model    *string `json:"model"`
		Key      *string `json:"key"`
	}
	if r.ContentLength != 0 {
		if err := readJSON(r, &in); err != nil {
			badBodyWith(w, err, "invalid_input", err.Error())
			return
		}
	}
	if !s.assistantTestLimiter.allow(u.ID) {
		w.Header().Set("Retry-After", fmt.Sprint(int(memberTestWindow.Seconds())))
		writeError(w, http.StatusTooManyRequests, "rate_limited", fmt.Sprintf("at most %d connection tests in %d minutes; try again later", memberTestLimit, int(memberTestWindow.Minutes())))
		return
	}
	route, err := s.assistant.Store.MemberTestRoute(ctx, u.ID, assistant.MemberDraft{Provider: in.Provider, Model: in.Model, Key: in.Key})
	var inv *assistant.InvalidError
	if errors.As(err, &inv) {
		writeError(w, http.StatusBadRequest, "invalid_input", inv.Error())
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	res := s.assistant.TestMember(ctx, route, set)
	s.log.Info("assistant member connection test", "provider", route.Provider, "ok", res.OK, "code", res.Code)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleMyAssistantUsage(w http.ResponseWriter, r *http.Request) {
	set := s.assistantSettings(r.Context())
	u, err := s.assistant.Store.Usage(r.Context(), userFrom(r.Context()).ID, set.MonthlyTokenCap)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, usageView(u, set.CapMemberKeys))
}

// usageView is the month's usage: total_tokens counts every turn,
// counted_tokens what is measured against cap, own_key the turns on the
// user's own key (left out of counted_tokens unless cap_member_keys).
func usageView(u assistant.Usage, capMemberKeys bool) map[string]any {
	return map[string]any{"month": u.Month, "input_tokens": u.InputTokens, "output_tokens": u.OutputTokens, "total_tokens": u.Total(),
		"turns": u.Turns, "cap": u.Cap, "resets_at": u.ResetsAt, "counted_tokens": u.Counted(capMemberKeys), "cap_member_keys": capMemberKeys,
		"own_key": map[string]any{"input_tokens": u.Own.InputTokens, "output_tokens": u.Own.OutputTokens, "total_tokens": u.Own.Total(), "turns": u.Own.Turns}}
}

// ---- the turn ----

type turnRequest struct {
	Messages []assistant.Message `json:"messages"`
	Timezone string              `json:"timezone"`
	View     string              `json:"view"`
	Selected []string            `json:"selected"`
	// Skill is a built-in skill id and Workday the device's working day
	// (assistant-skills D2); both optional.
	Skill   string             `json:"skill,omitempty"`
	Workday *assistant.Workday `json:"workday,omitempty"`
}

func (s *Server) handleAssistantTurn(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	set := s.assistantSettings(ctx)
	if !set.Enabled {
		writeError(w, http.StatusNotFound, "not_found", "the assistant is not enabled on this server")
		return
	}
	u := userFrom(ctx)
	// Never for an encrypted account, on-device mode or not (assistant-on-device).
	if enc, err := s.keys().Enabled(ctx, u.ID); err != nil {
		s.internal(w, err)
		return
	} else if enc {
		writeError(w, http.StatusConflict, "encryption_enabled", "the assistant cannot read end-to-end encrypted tasks; your tasks never leave your devices unencrypted")
		return
	}
	if !set.Active() {
		writeError(w, http.StatusNotFound, "not_found", "the assistant is not enabled on this server")
		return
	}
	// The member's own provider, model and key, or the owner's provider
	// (assistant-member-provider); consent must name the provider used.
	route, err := s.assistant.Store.Resolve(ctx, u.ID, set)
	if err != nil {
		s.internal(w, err)
		return
	}
	consent, err := s.assistant.Store.Consent(ctx, u.ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	if !consent.Valid(route.Provider) {
		writeError(w, http.StatusForbidden, "consent_required", "read which data is sent to "+assistant.ProviderLabel(route.Provider)+" and accept before the first message")
		return
	}
	in, skill, zone, ok := readTurn(w, r)
	if !ok {
		return
	}
	usage, err := s.assistant.Store.Usage(ctx, u.ID, set.MonthlyTokenCap)
	if err != nil {
		s.internal(w, err)
		return
	}
	// Turns on the member's own key are outside the cap unless the owner
	// counts them (cap_member_keys).
	capped := set.MonthlyTokenCap > 0 && (!route.Own || set.CapMemberKeys)
	if capped && usage.Counted(set.CapMemberKeys) >= set.MonthlyTokenCap {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]any{"code": "assistant_quota",
			"message":   fmt.Sprintf("you have used this month's assistant allowance of %d tokens; it resets on %s", set.MonthlyTokenCap, usage.ResetsAt),
			"resets_at": usage.ResetsAt}})
		return
	}
	release, err := s.assistant.Acquire(u.ID)
	switch {
	case errors.Is(err, assistant.ErrTurnInProgress):
		writeError(w, http.StatusConflict, "turn_in_progress", "another answer is still being written; wait for it or stop it first")
		return
	case errors.Is(err, assistant.ErrBusy):
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "assistant_busy", "the assistant is busy on this server; try again in a few seconds")
		return
	}
	defer release()
	prov, err := s.assistant.ProviderFor(route, set)
	if errors.Is(err, assistant.ErrNoKey) {
		writeError(w, http.StatusConflict, "no_key", "no API key is configured for "+assistant.ProviderLabel(route.Provider)+"; ask the server owner")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}

	// Stream server-sent events from here on.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(turnTimeout + 30*time.Second))
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	send := func(event string, data any) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		_ = rc.Flush()
	}
	tctx, cancel := context.WithTimeout(ctx, turnTimeout)
	defer cancel()
	start := time.Now()
	res := s.assistant.Loop.Run(tctx, prov, assistant.TurnInput{
		UserID: u.ID, UserName: u.Name, Zone: zone, Messages: in.Messages, View: in.View, Selected: s.visibleToAssistants(ctx, u.ID, in.Selected), Skill: skill, Workday: in.Workday,
	}, assistant.Events{
		Text:   func(t string) { send("text", map[string]string{"text": t}) },
		Status: func(t string) { send("status", map[string]string{"text": t}) },
	})
	// Usage is counted from the provider's usage fields, whatever the outcome
	// (a refusal still costs tokens), in a context that outlives a disconnect.
	if res.Input+res.Output > 0 {
		if err := s.assistant.Store.AddUsage(context.WithoutCancel(ctx), u.ID, res.Input, res.Output, route.Own); err != nil {
			s.log.Error("assistant usage not recorded", "err", err)
		}
		if skill != nil {
			if err := s.assistant.Store.AddSkillUse(context.WithoutCancel(ctx), u.ID, skill.ID); err != nil {
				s.log.Error("assistant skill use not recorded", "err", err)
			}
		}
	}
	// Logs hold the provider, outcome, duration and token counts only (design D8).
	s.log.Info("assistant turn", "provider", route.Provider, "own_key", route.Own, "skill", in.Skill, "stop", string(res.Stop), "duration_ms", time.Since(start).Milliseconds(),
		"input_tokens", res.Input, "output_tokens", res.Output, "proposed", len(res.Changes), "failed", res.Err != nil)
	if ctx.Err() != nil {
		return // the browser went away (stopped or closed)
	}
	// month_total is what counts against the cap; cap is 0 for a turn the
	// cap does not apply to (the member's own key).
	total := usage.Counted(set.CapMemberKeys)
	if !route.Own || set.CapMemberKeys {
		total += res.Input + res.Output
	}
	turnCap := set.MonthlyTokenCap
	if !capped {
		turnCap = 0
	}
	send("usage", map[string]any{"input": res.Input, "output": res.Output, "month_total": total, "cap": turnCap, "own_key": route.Own})
	if res.Err != nil {
		code, msg := "provider_error", "the provider could not answer"
		if pe, ok := assistant.AsProviderError(res.Err); ok {
			code, msg = pe.Code, pe.Msg
			if route.Own && pe.Code == assistant.CodeProviderAuth {
				msg = assistant.OwnKeyRejected()
			}
		} else if errors.Is(res.Err, context.DeadlineExceeded) {
			code, msg = "timeout", "the answer took too long and was stopped"
		} else {
			s.log.Error("assistant turn failed", "err", res.Err)
		}
		send("error", map[string]string{"code": code, "message": msg})
		return
	}
	if len(res.Changes) > 0 {
		send("changeset", map[string]any{"items": res.Changes, "limit": assistant.MaxEntities})
	}
	done := map[string]any{"stop_reason": string(res.Stop), "server_time": time.Now().UTC().Format(time.RFC3339)}
	if res.Message != "" {
		done["message"] = res.Message
	}
	send("done", done)
}

// readTurn reads and checks a turn request: its size, its messages, the
// skill and the time zone. It answers the error itself and reports false then.
func readTurn(w http.ResponseWriter, r *http.Request) (turnRequest, *agenttools.Skill, *time.Location, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, turnMaxBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "a turn is at most 256 KB; start a new conversation or clear older messages")
			return turnRequest{}, nil, nil, false
		}
		writeError(w, http.StatusBadRequest, "bad_request", "could not read the request body")
		return turnRequest{}, nil, nil, false
	}
	var in turnRequest
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_input", "invalid JSON body")
		return turnRequest{}, nil, nil, false
	}
	if len(in.Messages) > turnMaxMessages {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("a turn carries at most %d messages", turnMaxMessages))
		return turnRequest{}, nil, nil, false
	}
	if msg := validateTurn(in); msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return turnRequest{}, nil, nil, false
	}
	var skill *agenttools.Skill
	if in.Skill != "" {
		sk, ok := agenttools.SkillByID(in.Skill)
		if !ok {
			writeError(w, http.StatusBadRequest, "unknown_skill", "there is no skill with this id")
			return turnRequest{}, nil, nil, false
		}
		skill = &sk
	}
	zone, err := agenttools.ParseZone(in.Timezone, "timezone")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_input", "timezone: must be an IANA time zone such as Europe/Rome")
		return turnRequest{}, nil, nil, false
	}
	return in, skill, zone, true
}

func validateTurn(in turnRequest) string {
	if len(in.Messages) == 0 {
		return "messages: at least one message is required"
	}
	for i, m := range in.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			return fmt.Sprintf("messages[%d].role: must be user or assistant", i)
		}
	}
	for i, m := range in.Messages {
		if m.Untrusted && m.Role != "user" {
			return fmt.Sprintf("messages[%d]: only user messages can carry pasted text", i)
		}
	}
	last := in.Messages[len(in.Messages)-1]
	if last.Role != "user" || last.Untrusted || strings.TrimSpace(last.Text) == "" {
		return "messages: the last message must be the user's question"
	}
	if in.Workday != nil && !in.Workday.Valid() {
		return "workday: startHour before endHour within 0–24, dayLength 15–1440 minutes"
	}
	if len(in.Selected) > 200 {
		return "selected: at most 200 ids"
	}
	if len(in.View) > 40 {
		return "view: unknown view"
	}
	return ""
}
