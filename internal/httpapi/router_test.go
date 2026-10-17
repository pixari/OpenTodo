package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The router comment (router.go) relies on Go's ServeMux choosing the most
// specific pattern whatever the registration order (server-code-structure).
func TestMuxPrefersSpecificPatternInAnyOrder(t *testing.T) {
	for _, literalFirst := range []bool{true, false} {
		mux := http.NewServeMux()
		hit := ""
		literal := func(http.ResponseWriter, *http.Request) { hit = "invitation" }
		generic := func(http.ResponseWriter, *http.Request) { hit = "collection" }
		if literalFirst {
			mux.HandleFunc("GET /api/v1/invitations/{token}", literal)
			mux.HandleFunc("GET /api/v1/{collection}/{id}", generic)
		} else {
			mux.HandleFunc("GET /api/v1/{collection}/{id}", generic)
			mux.HandleFunc("GET /api/v1/invitations/{token}", literal)
		}
		mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/v1/invitations/abc", nil))
		if hit != "invitation" {
			t.Errorf("literal registered first=%v: the request reached %q, want the invitation route", literalFirst, hit)
		}
		mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/v1/tasks/abc", nil))
		if hit != "collection" {
			t.Errorf("literal registered first=%v: /api/v1/tasks/abc reached %q, want the collection route", literalFirst, hit)
		}
	}
}
