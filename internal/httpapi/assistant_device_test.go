package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/pixari/opentodo/internal/assistant"
	"github.com/pixari/opentodo/internal/settings"
)

// The on-device assistant for encrypted accounts (OpenSpec change
// assistant-on-device): the owner switch, the status and consent of an
// encrypted account, the turn route that still refuses, and the page policy.

func deviceSettings(enabled bool, providers []string, origins []string) map[string]any {
	return map[string]any{"enabled": true, "device": map[string]any{"enabled": enabled, "providers": providers, "origins": origins}}
}

func pageCSP(e *env) string {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+"/", nil)
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.Header.Get("Content-Security-Policy")
}

func connectSrc(csp string) string {
	for _, part := range strings.Split(csp, ";") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "connect-src "); ok {
			return v
		}
	}
	return ""
}

func TestDeviceAssistantSettings(t *testing.T) {
	e, llm, _ := assistantEnv(t)
	// Bad origins and a model server without origins name device.origins.
	for _, bad := range []map[string]any{
		deviceSettings(true, []string{"compatible"}, []string{"http://192.168.1.20:11434"}),
		deviceSettings(true, []string{"compatible"}, []string{"https://*.example.com"}),
		deviceSettings(true, []string{"compatible"}, []string{"https://models.example.com/v1"}),
		deviceSettings(true, []string{"compatible"}, []string{"https://user:pw@models.example.com"}),
		deviceSettings(true, []string{"compatible"}, nil),
		deviceSettings(true, []string{"skynet"}, nil),
	} {
		resp, out := e.do("PUT", "/api/v1/settings/assistant", bad)
		if resp.StatusCode != 400 || errCode(out) != "invalid_input" || !strings.Contains(out["error"].(map[string]any)["message"].(string), "device.") {
			t.Fatalf("%v: %d %v", bad, resp.StatusCode, out)
		}
	}
	if c := connectSrc(pageCSP(e)); c != "'self'" {
		t.Fatalf("connect-src before = %q", c)
	}
	// Allowed without any server provider or key.
	resp, out := e.do("PUT", "/api/v1/settings/assistant", deviceSettings(true, []string{"anthropic", "compatible"}, []string{"HTTP://localhost:11434/", "https://models.example.com:8443"}))
	e.mustStatus(resp, 200, out)
	dev := out["device"].(map[string]any)
	if dev["enabled"] != true || len(dev["origins"].([]any)) != 2 || dev["origins"].([]any)[0] != "http://localhost:11434" {
		t.Fatalf("saved device: %v", dev)
	}
	if c := connectSrc(pageCSP(e)); c != "'self' https://api.anthropic.com http://localhost:11434 https://models.example.com:8443" {
		t.Fatalf("connect-src = %q", c)
	}
	// The owner's own (plaintext) account has no server provider.
	resp, out = e.do("GET", "/api/v1/me/assistant", nil)
	e.mustStatus(resp, 200, out)
	if out["reason"] != "no_provider" || out["mode"] != "" || out["device"] != nil {
		t.Fatalf("plaintext owner: %v", out)
	}
	// A plaintext account cannot consent for a device.
	resp, out = e.do("PUT", "/api/v1/me/assistant", map[string]any{"consent": true, "provider": "device:anthropic"})
	if resp.StatusCode != 403 || errCode(out) != "forbidden" {
		t.Fatalf("plaintext device consent: %d %v", resp.StatusCode, out)
	}
	// An encrypted member gets the on-device mode.
	m := newClientAt(e, "10.0.0.9")
	resp, out = m.do("POST", "/api/v1/auth/register", map[string]string{"email": "m@example.com", "name": "M", "password": "correct horse battery"})
	m.mustStatus(resp, 201, out)
	resp, out = m.do("PUT", "/api/v1/encryption/keys", keyRecord(1, 1))
	m.mustStatus(resp, 201, out)
	resp, out = m.do("GET", "/api/v1/me/assistant", nil)
	m.mustStatus(resp, 200, out)
	d := out["device"].(map[string]any)
	if out["available"] != true || out["mode"] != "device" || out["reason"] != "" || out["enabled"] != true || d["consented_provider"] != "" || len(d["providers"].([]any)) != 2 {
		t.Fatalf("encrypted member: %v", out)
	}
	for _, p := range []string{"device:openai", "device:skynet"} {
		resp, out = m.do("PUT", "/api/v1/me/assistant", map[string]any{"consent": true, "provider": p})
		if resp.StatusCode != 403 {
			t.Fatalf("%s: %d %v", p, resp.StatusCode, out)
		}
	}
	resp, out = m.do("PUT", "/api/v1/me/assistant", map[string]any{"consent": true, "provider": "device:anthropic", "own_key": "x"})
	if resp.StatusCode != 400 {
		t.Fatalf("device consent with a key: %d %v", resp.StatusCode, out)
	}
	out = m.consentAssistant("device:anthropic")
	if out["device"].(map[string]any)["consented_provider"] != "anthropic" || out["consented"] != false {
		t.Fatalf("after consent: %v", out)
	}
	// The server still never runs a turn for an encrypted account.
	if code, body, _ := m.turn(ask("hi")); code != 409 || errCode(body) != "encryption_enabled" {
		t.Fatalf("encrypted turn: %d %v", code, body)
	}
	if llm.hits.Load() != 0 {
		t.Fatal("a provider was contacted")
	}
	// Withdrawing works whatever the settings.
	resp, out = m.do("PUT", "/api/v1/me/assistant", map[string]any{"consent": false, "provider": "device:anthropic"})
	m.mustStatus(resp, 200, out)
	if out["device"].(map[string]any)["consented_provider"] != "" {
		t.Fatalf("after withdrawal: %v", out)
	}
	// A member cannot change the owner switch; anonymous requests are refused.
	resp, out = m.do("PUT", "/api/v1/settings/assistant", deviceSettings(false, nil, nil))
	if resp.StatusCode != 403 {
		t.Fatalf("member: %d %v", resp.StatusCode, out)
	}
	anon := newClientFor(e)
	resp, out = anon.do("PUT", "/api/v1/me/assistant", map[string]any{"consent": true, "provider": "device:anthropic"})
	if resp.StatusCode != 401 {
		t.Fatalf("anonymous: %d %v", resp.StatusCode, out)
	}
	// Turning the switch off removes the origins again and the mode.
	resp, out = e.do("PUT", "/api/v1/settings/assistant", map[string]any{"enabled": false, "device": map[string]any{"enabled": false, "providers": []string{}, "origins": []string{}}})
	e.mustStatus(resp, 200, out)
	if c := connectSrc(pageCSP(e)); c != "'self'" {
		t.Fatalf("connect-src after = %q", c)
	}
	resp, out = m.do("GET", "/api/v1/me/assistant", nil)
	m.mustStatus(resp, 200, out)
	if out["mode"] != "" || out["available"] != false {
		t.Fatalf("after switch off: %v", out)
	}
}

func TestDeviceAssistantNeverOnDemo(t *testing.T) {
	d := newDemoServer(t)
	set := assistant.Defaults()
	set.Enabled = true
	set.Device = assistant.DeviceSettings{Enabled: true, Providers: []string{"anthropic"}, Origins: []string{}}
	if err := settings.New(d.base.db).Set(context.Background(), assistant.SettingKey, set); err != nil {
		t.Fatal(err)
	}
	if c := connectSrc(pageCSP(d.anonymous())); c != "'self'" {
		t.Fatalf("demo connect-src = %q", c)
	}
}

func TestDeviceOriginCheck(t *testing.T) {
	for o, ok := range map[string]bool{
		"https://api.example.com": true, "https://api.example.com:8443": true, "http://localhost:11434": true, "http://127.0.0.1:1234": true, "http://[::1]:8080": true,
		"http://example.com": false, "http://10.0.0.5:11434": false, "ftp://example.com": false, "https://example.com/v1": false, "https://example.com?x=1": false,
		"https://*.example.com": false, "example.com": false, "": false,
	} {
		if err := assistant.CheckDeviceOrigin(o); (err == nil) != ok {
			t.Errorf("%q: err=%v, want ok=%v", o, err, ok)
		}
	}
}
