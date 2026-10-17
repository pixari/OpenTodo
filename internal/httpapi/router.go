package httpapi

import (
	"context"
	"net/http"
)

// The router: every route is registered here or in a register*Routes function
// these call, always through routes.handle with its declared policy, so the
// route table (policy.go) sees every route.
//
// Registration order does not matter. Go's ServeMux picks the most specific
// pattern that matches a request, whatever order the patterns were registered
// in: "GET /api/v1/invitations/{token}" wins over "GET /api/v1/{collection}/{id}"
// because it matches a strict subset of the paths, and two patterns where
// neither is more specific make registration panic. The order below only groups
// the routes for reading.

// registerRoutes registers every route of the server.
func (s *Server) registerRoutes(mux *routes, web http.Handler) {
	s.registerAttachmentRoutes(mux)
	s.registerAccountRoutes(mux)
	s.registerAdminRoutes(mux)
	s.registerFeatureRoutes(mux)
	s.registerDataRoutes(mux)
	s.registerWebAppRoutes(mux, web)
}

// registerAccountRoutes: health, sign-in, the second factor, single sign-on,
// sign-up, public links, the current user, API tokens and passkeys.
func (s *Server) registerAccountRoutes(mux *routes) {
	mux.handle("GET /healthz", public("health check for the container and load balancers"), s.handleHealth)
	mux.handle("GET /api/v1/auth/status", public("sign-in screen bootstrap: tells the app what the server offers"), s.handleAuthStatus)
	mux.handle("POST /api/v1/auth/register", public("first-run owner setup and sign-up").demoDenied(), s.handleRegister)
	mux.handle("POST /api/v1/auth/login", public("password sign-in, rate limited per address"), s.handleLogin)
	mux.handle("POST /api/v1/auth/logout", public("signing out must work with an expired session too"), s.handleLogout)
	// Passwordless sign-in: anonymous by design. Finishing shares the login
	// limiter; fetching a challenge has its own per-address limiter.
	mux.handle("POST /api/v1/auth/passkey/options", public("passwordless sign-in, rate limited per address"), s.handlePasskeyLoginOptions)
	mux.handle("POST /api/v1/auth/passkey", public("passwordless sign-in, rate limited per address"), s.handlePasskeyLogin)
	// Second factor (OpenSpec `mfa-totp`): the second sign-in step is anonymous
	// (it carries the challenge), everything else requires a session or token.
	s.registerMFARoutes(mux)
	// Single sign-on (OpenSpec `oidc-login`): start and callback are part of the
	// sign-in flow (anonymous, rate limited); settings and identities require auth.
	s.registerOIDCRoutes(mux)
	s.registerMailRoutes(mux)
	// Weekly email digest settings (stats-and-review).
	s.registerDigestRoutes(mux)
	s.registerSignupRoutes(mux)
	s.registerPublicLinkRoutes(mux)

	mux.handle("GET /api/v1/me", signedIn, s.handleMe)
	mux.handle("GET /api/v1/tokens", signedIn, s.handleListTokens)
	mux.handle("POST /api/v1/tokens", signedIn.sensitive().demoDenied(), s.handleCreateToken)
	mux.handle("DELETE /api/v1/tokens/{id}", signedIn.demoDenied(), s.handleDeleteToken)
	mux.handle("POST /api/v1/passkeys/register/options", signedIn.credential().demoDenied(), s.handlePasskeyRegisterOptions)
	mux.handle("POST /api/v1/passkeys/register", signedIn.credential().demoDenied(), s.handlePasskeyRegister)
	mux.handle("GET /api/v1/passkeys", signedIn, s.handleListPasskeys)
	mux.handle("PATCH /api/v1/passkeys/{id}", signedIn.credential().demoDenied(), s.handleRenamePasskey)
	mux.handle("DELETE /api/v1/passkeys/{id}", signedIn.credential().demoDenied(), s.handleDeletePasskey)
}

// registerAdminRoutes: invitations, user administration, the audit log,
// webhooks and backups.
func (s *Server) registerAdminRoutes(mux *routes) {
	// Invitations: owner-only management plus the one public preview route the
	// spec defines (the invitee has no account yet).
	mux.handle("GET /api/v1/invitations", adminsOnly("manage invitations"), s.handleListInvitations)
	mux.handle("POST /api/v1/invitations", adminsOnly("manage invitations").sensitive().demoDenied(), s.handleCreateInvitation)
	mux.handle("DELETE /api/v1/invitations/{id}", adminsOnly("manage invitations").credential().demoDenied(), s.handleRevokeInvitation)
	mux.handle("GET /api/v1/invitations/{token}", public("the invitee previews the invitation before having an account"), s.handlePreviewInvitation)
	// User administration (OpenSpec `user-management`).
	s.registerUserRoutes(mux)
	// Audit log: owner-only reads, export and settings; personal activity for
	// everyone.
	mux.handle("GET /api/v1/audit", ownerOnly("access the audit log"), s.handleAuditList)
	mux.handle("GET /api/v1/audit/export", ownerOnly("access the audit log"), s.handleAuditExport)
	mux.handle("GET /api/v1/settings/audit", ownerOnly("access the audit log"), s.handleGetAuditSettings)
	mux.handle("PUT /api/v1/settings/audit", ownerOnly("access the audit log").demoDenied(), s.handlePutAuditSettings)
	mux.handle("GET /api/v1/me/activity", signedIn, s.handleMyActivity)
	// Webhooks (OpenSpec `webhooks`): /api/v1/webhooks* and /api/v1/settings/webhooks,
	// all behind requireAuth.
	s.registerWebhookRoutes(mux)
	// Backups: owner only (OpenSpec `backups`).
	mux.handle("GET /api/v1/backups", ownerOnly("manage backups"), s.handleBackupStatus)
	mux.handle("GET /api/v1/backups/settings", ownerOnly("manage backups"), s.handleGetBackupSettings)
	mux.handle("PUT /api/v1/backups/settings", ownerOnly("manage backups").credential().demoDenied(), s.handlePutBackupSettings)
	mux.handle("POST /api/v1/backups/run", ownerOnly("manage backups").demoDenied(), s.handleBackupRun)
	mux.handle("POST /api/v1/backups/test", ownerOnly("manage backups").demoDenied(), s.handleBackupTest)
	// Web restore (backup-restore-web): owner only; confirm and safety-copy
	// delete also need a fresh session and refuse API tokens (in the handlers).
	mux.handle("GET /api/v1/backups/archives", ownerOnly("manage backups").demoDenied(), s.handleBackupArchives)
	mux.handle("GET /api/v1/backups/restore", ownerOnly("manage backups").demoDenied(), s.handleRestoreState)
	mux.handle("POST /api/v1/backups/restore", ownerOnly("manage backups").sessionOnly().recent().demoDenied(), s.handleRestoreConfirm)
	mux.handle("POST /api/v1/backups/restore/uploads", ownerOnly("manage backups").demoDenied(), s.handleRestoreUpload)
	mux.handle("POST /api/v1/backups/restore/prepare", ownerOnly("manage backups").demoDenied(), s.handleRestorePrepare)
	mux.handle("DELETE /api/v1/backups/restore/safety-copies/{name}", ownerOnly("manage backups").sessionOnly().recent().demoDenied(), s.handleDeleteSafetyCopy)
	mux.handle("DELETE /api/v1/backups/restore/{id}", ownerOnly("manage backups").demoDenied(), s.handleRestoreCancel)
}

// registerFeatureRoutes: sharing, push, notifications, trash, CalDAV and
// calendar feeds, comments, encryption, MCP, the assistant, email capture, demo
// sandboxes and hosted tenants.
func (s *Server) registerFeatureRoutes(mux *routes) {
	// Project sharing (OpenSpec `project-sharing`).
	s.registerSharingRoutes(mux)
	// Project invite links (OpenSpec `project-invite-links`).
	s.registerProjectInviteRoutes(mux)
	// Web push (OpenSpec `reminders`): registered only while push is enabled.
	s.registerPushRoutes(mux)
	// Notifications (OpenSpec `task-assignment`).
	s.registerNotificationRoutes(mux)
	// Trash and history (OpenSpec `trash-and-history`).
	s.registerTrashRoutes(mux)
	// CalDAV (OpenSpec `caldav`): app passwords, the owner toggle and /dav/.
	s.seedCaldav(context.Background())
	s.registerCaldavRoutes(mux)
	s.registerCalendarFeedRoutes(mux)
	// Comments and activity (OpenSpec `comments-and-activity`).
	s.registerCommentRoutes(mux)
	// End-to-end encryption (OpenSpec `e2ee`): wrapped key record and history purge.
	s.registerEncryptionRoutes(mux)
	// Read-only MCP endpoint and its owner toggle (OpenSpec `mcp-server`).
	s.registerMCPRoutes(mux)
	// In-app assistant (OpenSpec `in-app-assistant`): settings, consent, usage
	// and the turn route over the same tool registry.
	s.registerAssistantRoutes(mux)
	// Email to task (OpenSpec `email-to-task`).
	s.registerEmailRoutes(mux)
	// Demo sandboxes (OpenSpec `demo-sandboxes`): registered on a demo instance only.
	s.registerDemoRoutes(mux)
	// Hosted tenants (OpenSpec `multi-tenant-host`): the owner's archive download.
	s.registerHostedRoutes(mux)
}

// registerDataRoutes: sync, live updates, export, import and the generic REST
// collections, plus the 404 for unknown API routes.
func (s *Server) registerDataRoutes(mux *routes) {
	mux.handle("POST /api/v1/sync", signedIn, s.handleSync)
	mux.handle("GET /api/v1/sync/events", signedIn, s.handleEvents)
	mux.handle("GET /api/v1/export", signedIn, s.handleExport)
	// Import (OpenSpec `data-import`).
	mux.handle("POST /api/v1/import/preview", signedIn.demoDenied(), s.handleImportPreview)
	mux.handle("POST /api/v1/import", signedIn.demoDenied(), s.handleImportStart)
	mux.handle("GET /api/v1/import/jobs", signedIn, s.handleImportJobs)
	mux.handle("GET /api/v1/import/jobs/{id}", signedIn, s.handleImportJob)
	mux.handle("POST /api/v1/import/jobs/{id}/undo", signedIn.demoDenied(), s.handleImportUndo)
	mux.handle("GET /api/v1/{collection}", signedIn, s.handleList)
	mux.handle("POST /api/v1/{collection}", signedIn, s.handleCreate)
	mux.handle("GET /api/v1/{collection}/{id}", signedIn, s.handleGet)
	mux.handle("PATCH /api/v1/{collection}/{id}", signedIn, s.handlePatch)
	mux.handle("DELETE /api/v1/{collection}/{id}", signedIn, s.handleDelete)
	mux.handle("/api/", public("unknown API routes answer 404 not_found"), func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "unknown API route")
	})
}

// registerWebAppRoutes serves the embedded web app; web is nil when only the
// API is wanted (tests).
func (s *Server) registerWebAppRoutes(mux *routes, web http.Handler) {
	if web != nil {
		// The share sheet POSTs here when the service worker is not active yet.
		mux.handle("POST /share", public("the share sheet posts here before the service worker runs; it only redirects into the app"), s.handleSharePost)
		mux.handler("/", public("the web app; it signs in through the API"), web)
		// A public list page (public-links D7): no indexing and no referrer, so
		// the secret in its address never leaks to a site it links to.
		mux.handle("GET /public/", public("a public list page; its data comes from the public-link API"), func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
			w.Header().Set("Referrer-Policy", "no-referrer")
			web.ServeHTTP(w, r)
		})
	}
}
