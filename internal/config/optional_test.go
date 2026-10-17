package config

import "testing"

// optionalBool backs the preset switches (OPENTODO_MCP, OPENTODO_CALDAV, …)
// since server-code-structure split Load; unset stays nil.
func TestOptionalBool(t *testing.T) {
	for _, c := range []struct {
		value   string
		want    *bool
		wantErr string
	}{
		{"", nil, ""},
		{"  ", nil, ""},
		{"true", ptr(true), ""},
		{" false ", ptr(false), ""},
		{"1", ptr(true), ""},
		{"maybe", nil, `OPENTODO_TEST_FLAG must be true or false, got "maybe"`},
	} {
		t.Setenv("OPENTODO_TEST_FLAG", c.value)
		got, err := optionalBool("OPENTODO_TEST_FLAG")
		if c.wantErr != "" {
			if err == nil || err.Error() != c.wantErr {
				t.Errorf("%q: err = %v, want %q", c.value, err, c.wantErr)
			}
			continue
		}
		if err != nil || (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%q: got %v, %v; want %v", c.value, got, err, c.want)
		}
	}
}

func ptr(b bool) *bool { return &b }
