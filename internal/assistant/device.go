package assistant

import (
	"fmt"
	"net/url"
	"strings"
)

// The on-device assistant for end-to-end encrypted accounts (OpenSpec change
// assistant-on-device). The server never runs these turns: the browser that
// holds the account key reads its own decrypted rows, calls the provider the
// user set up on the device with the user's own key, and applies reviewed
// changes through the op log. The server only stores the owner's switch (which
// providers a device may call, and the model server origins), which also
// decides the page's connect-src (design D3), and the user's consent.

// DeviceSettings is the owner's switch (design D2).
type DeviceSettings struct {
	Enabled bool `json:"enabled"`
	// Providers a device may call: anthropic, openai, gemini, compatible.
	Providers []string `json:"providers"`
	// Origins are the model server origins a device may call (compatible).
	Origins []string `json:"origins"`
}

// MaxDeviceOrigins bounds the owner's model server list.
const MaxDeviceOrigins = 10

// DeviceConsentPrefix marks a consent recorded for the on-device assistant
// ("device:anthropic"): never valid for a server turn.
const DeviceConsentPrefix = "device:"

// ProviderOrigins are the browser-facing API origins of the built-in providers.
var ProviderOrigins = map[string]string{
	Anthropic: "https://api.anthropic.com",
	OpenAI:    "https://api.openai.com",
	Gemini:    "https://generativelanguage.googleapis.com",
}

// Allows reports whether devices may call the provider.
func (d DeviceSettings) Allows(provider string) bool {
	for _, p := range d.Providers {
		if p == provider {
			return true
		}
	}
	return false
}

// ConnectSources are the origins the page's connect-src adds while the
// on-device assistant is available (design D3): the allowed built-in
// providers' API origins, then the owner's model server origins.
func (s Settings) ConnectSources() []string {
	if !s.DeviceActive() {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(o string) {
		if o != "" && !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	for _, p := range ProviderNames {
		if s.Device.Allows(p) {
			add(ProviderOrigins[p])
		}
	}
	if s.Device.Allows(Compatible) {
		for _, o := range s.Device.Origins {
			add(o)
		}
	}
	return out
}

func (d *DeviceSettings) normalise() {
	if d.Providers == nil {
		d.Providers = []string{}
	}
	if d.Origins == nil {
		d.Origins = []string{}
	}
	for i, o := range d.Origins {
		d.Origins[i] = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(o), "/"))
	}
}

func (d DeviceSettings) validate() error {
	seen := map[string]bool{}
	for _, p := range d.Providers {
		if !known(p) {
			return invalid("device.providers", "unknown provider "+fmt.Sprintf("%q", p)+" (expected anthropic, openai, gemini or compatible)")
		}
		if seen[p] {
			return invalid("device.providers", "each provider may appear once")
		}
		seen[p] = true
	}
	if len(d.Origins) > MaxDeviceOrigins {
		return invalid("device.origins", fmt.Sprintf("at most %d model server origins", MaxDeviceOrigins))
	}
	for _, o := range d.Origins {
		if err := CheckDeviceOrigin(o); err != nil {
			return invalid("device.origins", err.Error())
		}
	}
	if d.Allows(Compatible) && len(d.Origins) == 0 {
		return invalid("device.origins", "add the origin of at least one model server to allow model servers")
	}
	return nil
}

// CheckDeviceOrigin accepts https://host[:port], or http:// only for this
// computer (localhost, 127.0.0.1, [::1]): any other plain-http origin would be
// mixed content from an https page and carry the key in the clear. No path,
// query, fragment, credentials or wildcard (design D2).
func CheckDeviceOrigin(o string) error {
	u, err := url.Parse(o)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return fmt.Errorf("%q is not an origin like https://models.example.com", o)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.ContainsAny(o, "*?#@ ") {
		return fmt.Errorf("%q must be an origin only: scheme, host and port, without path, query or credentials", o)
	}
	host := u.Hostname()
	switch u.Scheme {
	case "https":
	case "http":
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			return fmt.Errorf("%q: plain http is allowed only for localhost, 127.0.0.1 and [::1]; use https for other hosts", o)
		}
	default:
		return fmt.Errorf("%q must start with https:// (or http://localhost)", o)
	}
	if strings.Contains(host, "*") || host == "" {
		return fmt.Errorf("%q: wildcards are not allowed", o)
	}
	return nil
}
