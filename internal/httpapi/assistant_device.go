package httpapi

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pixari/opentodo/internal/assistant"
)

// The on-device assistant for encrypted accounts (OpenSpec change
// assistant-on-device): its part of the status, its consent, and the page's
// connect-src. The server never runs or sees an on-device turn.

// cspBase is the page policy with connect-src last, so allowed provider
// origins are appended to it (design D3).
const cspBase = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; connect-src 'self'"

// cspTTL bounds how long a process serves a policy after another process
// (rolling update) changed the settings; a save in this process refreshes at once.
const cspTTL = 30 * time.Second

type cspCache struct {
	mu    sync.Mutex
	value string
	at    time.Time
}

// buildCSP is the page policy for these settings.
func buildCSP(set assistant.Settings) string {
	extra := set.ConnectSources()
	if len(extra) == 0 {
		return cspBase
	}
	return cspBase + " " + strings.Join(extra, " ")
}

// contentSecurityPolicy returns the cached page policy, rebuilt from the
// assistant settings when older than cspTTL.
func (s *Server) contentSecurityPolicy(ctx context.Context) string {
	if s.assistant == nil {
		return cspBase
	}
	s.csp.mu.Lock()
	defer s.csp.mu.Unlock()
	if s.csp.value != "" && time.Since(s.csp.at) < cspTTL {
		return s.csp.value
	}
	s.csp.value = buildCSP(s.assistantSettings(ctx))
	s.csp.at = time.Now()
	return s.csp.value
}

// forgetCSP makes the next page request rebuild the policy (after a save).
func (s *Server) forgetCSP() {
	s.csp.mu.Lock()
	s.csp.value = ""
	s.csp.mu.Unlock()
}

// deviceView is the on-device part of an encrypted account's status: what the
// owner allows (no keys exist for it on the server) and the device consent.
func deviceView(set assistant.Settings, consent *assistant.Consent) map[string]any {
	providers, origins := []string{}, []string{}
	if set.DeviceActive() {
		providers = append(providers, set.Device.Providers...)
		if set.Device.Allows(assistant.Compatible) {
			origins = append(origins, set.Device.Origins...)
		}
	}
	consented := ""
	if consent != nil && consent.DisclosureVersion == assistant.DisclosureVersion && strings.HasPrefix(consent.Provider, assistant.DeviceConsentPrefix) {
		consented = strings.TrimPrefix(consent.Provider, assistant.DeviceConsentPrefix)
	}
	return map[string]any{
		"available": set.DeviceActive(), "providers": providers, "origins": origins,
		"consented_provider": consented, "anthropic_models": assistant.AnthropicModels, "default_model": assistant.DefaultAnthropicModel,
	}
}

// putDeviceConsent records or withdraws consent for the on-device assistant
// (design D6): only an encrypted account, only while the owner allows that provider.
func (s *Server) putDeviceConsent(w http.ResponseWriter, r *http.Request, set assistant.Settings, provider string, accept bool) {
	ctx := r.Context()
	u := userFrom(ctx)
	if accept {
		enc, err := s.keys().Enabled(ctx, u.ID)
		if err != nil {
			s.internal(w, err)
			return
		}
		if !enc || !set.DeviceActive() || !set.Device.Allows(provider) {
			writeError(w, http.StatusForbidden, "forbidden", "the on-device assistant is for end-to-end encrypted accounts, with a provider the server owner allows")
			return
		}
	}
	if err := s.assistant.Store.SetConsent(ctx, u.ID, assistant.DeviceConsentPrefix+provider, accept); err != nil {
		s.internal(w, err)
		return
	}
	s.handleGetMyAssistant(w, r)
}
