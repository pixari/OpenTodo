package httpapi

import (
	"errors"
	"net/http"

	"github.com/pixari/opentodo/internal/audit"
	"github.com/pixari/opentodo/internal/auth"
	"github.com/pixari/opentodo/internal/config"
)

// Health, sign-in, sign-out, the current user and API tokens.

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if _, err := s.auth.UserCount(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unhealthy", "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": s.version})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	allowed, err := s.auth.SignupAllowed(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	count, _ := s.auth.UserCount(r.Context())
	u, sess, _, err := s.authenticateSession(r)
	if err != nil {
		s.internal(w, err)
		return
	}
	out := map[string]any{
		"setupRequired": count == 0,
		// A configured OPENTODO_SETUP_TOKEN guards the first account (OpenSpec
		// change owner-bootstrap); false once an owner exists.
		"setupTokenRequired": count == 0 && s.auth.SetupTokenRequired(),
		"signupAllowed":      allowed,
		"authenticated":      u != nil,
		"user":               u,
		"version":            s.version,
		"passkeysAvailable":  s.cfg.PasskeysAvailable(),
		// The host passkeys are bound to (OPENTODO_BASE_URL's), so a page opened at
		// another host can say so; public information, empty without a base URL.
		"passkeyDomain": s.cfg.RPID(),
		"oidc":          s.oidcStatus(r.Context()),
		"outgoingEmail": map[string]bool{"enabled": s.mailEnabled(r.Context())},
	}
	// Without a token, a client outside the local network needs the setup code
	// from the server log (trusted-client-identity).
	out["setupCodeRequired"] = count == 0 && s.auth.SetupCodeRequired() && !isLocalAddr(clientIP(r))
	if s.hosted {
		// A hosted tenant (multi-tenant-host D4): the app hides the operator's panels.
		out["hosted"] = true
	}
	if s.demo != nil {
		// Demo instance (OpenSpec `demo-sandboxes`): a sandbox-creation token, the
		// sandbox lifetimes and the next reset; no credentials.
		out["demo"] = s.demo.Info()
	}
	if u != nil {
		st, err := s.auth.MFAStatusFor(r.Context(), u, sess != nil)
		if err != nil {
			s.internal(w, err)
			return
		}
		out["mfa"] = st
		// The web app reads its profile here (OpenSpec `e2ee`, design D5/D9).
		out["encryption"] = s.encryptionStatus(r.Context(), u.ID)
		out["minClientVersion"] = MinClientVersion
	}
	writeJSON(w, http.StatusOK, out)
}

type credentials struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	// Invitation is an optional invitation secret that admits one member while
	// sign-up is closed (OpenSpec `invitations`).
	Invitation string `json:"invitation"`
	// ProjectInvite is an optional project invite link secret: the new account
	// joins that project (OpenSpec `project-invite-links`).
	ProjectInvite string `json:"projectInvite"`
	// SetupToken must accompany the first registration when OPENTODO_SETUP_TOKEN
	// is set (OpenSpec `owner-bootstrap`); ignored afterwards.
	SetupToken string `json:"setupToken"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.registerLimiter.allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts, try again later")
		return
	}
	if !s.originAllowed(r) {
		writeError(w, http.StatusForbidden, "bad_origin", "cross-site request rejected")
		return
	}
	var c credentials
	if err := readJSON(r, &c); err != nil {
		badBody(w, err)
		return
	}
	// In SSO-only mode new accounts come from the provider, never a password
	// form (the first account is the owner and can always be created).
	if n, err := s.auth.UserCount(r.Context()); err == nil && n > 0 && s.auth.SSOOnly(r.Context()) {
		writeError(w, http.StatusForbidden, "sso_required", auth.ErrSSORequired.Error())
		return
	}
	if c.ProjectInvite != "" {
		if c.Invitation != "" {
			writeError(w, http.StatusBadRequest, "invalid_input", "send either invitation or projectInvite, not both")
			return
		}
		s.registerWithProjectInvite(w, r, c)
		return
	}
	// Open sign-up on a server that can send mail verifies the address first
	// (OpenSpec `outgoing-email` D4); invitations and the first account never do.
	if c.Invitation == "" && s.auth.OpenSignup() && s.mailEnabled(r.Context()) {
		if n, err := s.auth.UserCount(r.Context()); err == nil && n > 0 {
			s.registerWithVerification(w, r, c)
			return
		}
	}
	// Without a setup token, a first registration from a public address needs
	// the setup code from the server log (trusted-client-identity).
	u, err := s.auth.RegisterFrom(r.Context(), c.Email, c.Name, c.Password, c.Invitation, c.SetupToken, isLocalAddr(clientIP(r)))
	switch {
	case errors.Is(err, auth.ErrSetupTokenInvalid):
		writeError(w, http.StatusForbidden, "setup_token_invalid", err.Error())
		return
	case errors.Is(err, auth.ErrSetupCodeInvalid):
		writeError(w, http.StatusForbidden, "setup_code_invalid", err.Error())
		return
	case errors.Is(err, auth.ErrMemberLimit):
		writeError(w, http.StatusForbidden, "limit_members", err.Error())
		return
	case errors.Is(err, auth.ErrSignupClosed):
		writeError(w, http.StatusForbidden, "signup_closed", err.Error())
		return
	case errors.Is(err, auth.ErrInvitationInvalid):
		writeError(w, http.StatusNotFound, "invitation_invalid", err.Error())
		return
	case errors.Is(err, auth.ErrInvitationEmailMismatch):
		writeError(w, http.StatusForbidden, "invitation_email_mismatch", err.Error())
		return
	case errors.Is(err, auth.ErrEmailTaken):
		writeError(w, http.StatusConflict, "email_taken", err.Error())
		return
	case errors.Is(err, auth.ErrInvalidEmail), errors.Is(err, auth.ErrWeakPassword):
		writeError(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	if s.startSession(w, r, u, http.StatusCreated, false) {
		s.audit.Record(r.Context(), audit.LoginSucceeded(u.ID, u.Email, "register"))
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Only failures count against the address (trusted-client-identity).
	ip := clientIP(r)
	if blocked, first := s.limiter.check(ip); blocked {
		// One event per window and address once limiting kicks in, instead of one
		// per refused attempt, so credential stuffing cannot flood the log.
		if first {
			s.audit.Record(r.Context(), audit.LoginFailed("", "", audit.ReasonRateLimited))
		}
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts, try again later")
		return
	}
	if !s.originAllowed(r) {
		writeError(w, http.StatusForbidden, "bad_origin", "cross-site request rejected")
		return
	}
	var c credentials
	if err := readJSON(r, &c); err != nil {
		badBody(w, err)
		return
	}
	key, err := s.loginAccountKey(r.Context(), c.Email)
	if err != nil {
		s.internal(w, err)
		return
	}
	if s.accountLocked(w, r, key) {
		return
	}
	u, err := s.auth.Authenticate(r.Context(), c.Email, c.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		s.limiter.hit(ip)
		s.accountLimiter.hit(key)
		var f *auth.LoginFailure
		if errors.As(err, &f) {
			s.audit.Record(r.Context(), audit.LoginFailed(f.UserID, f.Email, f.Reason))
		}
		writeError(w, http.StatusUnauthorized, "invalid_credentials", err.Error())
		return
	}
	if errors.Is(err, auth.ErrAccountDeactivated) {
		var d *auth.DeactivatedLogin
		if errors.As(err, &d) {
			s.audit.Record(r.Context(), audit.LoginFailed(d.UserID, d.Email, audit.ReasonDeactivated))
		}
		writeError(w, http.StatusForbidden, "account_deactivated", "this account has been deactivated; ask the server owner or an admin")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	// SSO-only mode: members must use the provider (oidc-login D6).
	if s.ssoRequired(w, r, u) {
		return
	}
	// An enrolled account needs its second factor, unless this browser was
	// remembered (mfa-totp D3, D6).
	if done := s.secondStep(w, r, u, "password"); done {
		return
	}
	if s.startSession(w, r, u, http.StatusOK, false) {
		s.audit.Record(r.Context(), audit.LoginSucceeded(u.ID, u.Email, "password"))
	}
}

// startSession issues the session cookie and answers with the user. mfa marks
// the second factor as satisfied for the session. It reports whether the
// session was created.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, u *auth.User, status int, mfa bool) bool {
	if _, ok := s.issueSession(w, r, u, mfa); !ok {
		return false
	}
	writeJSON(w, status, map[string]any{"user": u})
	return true
}

// issueSession creates the session and sets its cookie without writing a body
// (the provider callback redirects instead). It returns the cookie value.
func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, u *auth.User, mfa bool) (string, bool) {
	secret, exp, err := s.auth.CreateSessionMFA(r.Context(), u.ID, r.UserAgent(), mfa)
	if errors.Is(err, auth.ErrAccountDeactivated) {
		writeError(w, http.StatusForbidden, "account_deactivated", "this account has been deactivated; ask the server owner or an admin")
		return "", false
	}
	if err != nil {
		s.internal(w, err)
		return "", false
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: secret, Path: "/", Expires: exp,
		HttpOnly: true, Secure: s.secureCookie(r), SameSite: http.SameSiteLaxMode,
	})
	// A successful sign-in clears the account's failed attempts.
	s.accountLimiter.reset(accountKey(u.ID))
	return secret, true
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	redirect := ""
	if c, err := r.Cookie(sessionCookie); err == nil {
		u, lookupErr := s.auth.UserBySession(r.Context(), c.Value)
		// The identity-token hint is read before the session (and the hint with
		// it) is deleted; only sessions that started through the provider have one.
		idToken, viaProvider, _ := s.auth.SessionIDToken(r.Context(), c.Value)
		if err := s.auth.DeleteSession(r.Context(), c.Value); err == nil && lookupErr == nil {
			s.audit.Record(r.Context(), audit.Logout(u.ID))
			if viaProvider {
				redirect = s.providerLogoutURL(r, idToken)
			}
		}
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.secureCookie(r), SameSite: http.SameSiteLaxMode})
	// Provider sign-out (oidc-login D7): the local session is already gone; the
	// client follows the redirect to the provider's end-session endpoint.
	if redirect != "" {
		writeJSON(w, http.StatusOK, map[string]any{"redirect": redirect})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// baseURLMailWarning tells the owner why emailed links are refused: they are
// built from OPENTODO_BASE_URL only (harden-links-and-sharing).
var baseURLMailWarning = config.Warning{Variable: "OPENTODO_BASE_URL",
	Message: "outgoing email is configured but no base URL is set, so password resets, sign-up verification and invitations are not sent by email. Set OPENTODO_BASE_URL to the address people open OpenTodo at, such as https://todo.example.com, and restart."}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	st, err := s.auth.MFAStatusFor(r.Context(), u, sessionFrom(r.Context()) != nil)
	if err != nil {
		s.internal(w, err)
		return
	}
	authInfo, err := s.credentialInfo(r)
	if err != nil {
		s.internal(w, err)
		return
	}
	// encryption and minClientVersion: OpenSpec `e2ee` (design D8, D9); auth:
	// `agent-ready-cli` (design D7).
	out := map[string]any{"user": u, "mfa": st,
		"encryption": s.encryptionStatus(r.Context(), u.ID), "minClientVersion": MinClientVersion, "auth": authInfo}
	// Attachment limits and this account's usage (attachments D5), for the device's checks.
	if info, err := s.attachmentInfo(r.Context(), u.ID); err == nil {
		out["attachments"] = info
	}
	// Configuration problems the server started despite (trusted-proxies-lenient):
	// for the owner's own session only, never for members, admins or API tokens.
	if u.Role == auth.RoleOwner && tokenFrom(r.Context()).ID == "" {
		warnings := append([]config.Warning{}, s.cfg.Warnings...)
		if s.cfg.Origin() == "" && s.mailEnabled(r.Context()) {
			warnings = append(warnings, baseURLMailWarning)
		}
		out["config_warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, out)
}

// credentialInfo describes how the request authenticated (agent-ready-cli D7):
// method session or token, the scope and, for tokens, the token's id and name,
// never its secret. For an agent token it adds whether writes are allowed right
// now (both switches), since the switch route itself refuses agent tokens.
func (s *Server) credentialInfo(r *http.Request) (map[string]any, error) {
	tok := tokenFrom(r.Context())
	if tok.ID == "" {
		return map[string]any{"method": "session", "scope": auth.ScopeFull}, nil
	}
	out := map[string]any{"method": "token", "scope": tok.Scope, "token_id": tok.ID, "token_name": tok.Name}
	if tok.Scope == auth.ScopeAgent && s.agentAccess != nil {
		c, err := s.agentCaller(r.Context(), userFrom(r.Context()), tok)
		if err != nil {
			return nil, err
		}
		out["writes_allowed"] = c.CanWrite()
		if d := c.WriteDenial(); d != "" {
			out["writes_denied"] = d
		}
	}
	return out, nil
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	list, err := s.auth.ListTokens(r.Context(), userFrom(r.Context()).ID)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": list})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
	}
	if err := readJSON(r, &in); err != nil {
		badBody(w, err)
		return
	}
	// An admin token is minted only by a person in a recently confirmed session
	// (the route policy checked the freshness), never by another token.
	if in.Scope == auth.ScopeAdmin && sessionFrom(r.Context()) == nil {
		writeError(w, http.StatusForbidden, "session_required", "an admin token can only be created from a signed-in session")
		return
	}
	t, plain, err := s.auth.CreateTokenScoped(r.Context(), userFrom(r.Context()).ID, in.Name, in.Scope)
	if errors.Is(err, auth.ErrInvalidScope) {
		writeError(w, http.StatusBadRequest, "invalid_input", "scope: must be full, read, agent or admin")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": t, "secret": plain})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	err := s.auth.DeleteToken(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"))
	if errors.Is(err, auth.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "token not found")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
