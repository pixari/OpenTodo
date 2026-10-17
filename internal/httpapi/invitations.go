package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/auth"
	"github.com/pixari/opentodo/internal/mail"
)

// Owner-managed invitations and their public preview, plus the origin helpers
// that build the links sent by email.

func (s *Server) handleListInvitations(w http.ResponseWriter, r *http.Request) {
	list, err := s.auth.ListInvitations(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": list})
}

func (s *Server) handleCreateInvitation(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	if !s.inviteLimiter.allow(u.ID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many invitations created, try again later")
		return
	}
	var in struct {
		Email          string   `json:"email"`
		ExpiresInHours *float64 `json:"expiresInHours"`
		Send           bool     `json:"send"`
	}
	if err := readJSON(r, &in); err != nil {
		badBody(w, err)
		return
	}
	msg, ok := s.inviteMessage(w, r, in.Send, in.Email, mail.KindInvitation, u, "")
	if !ok {
		return
	}
	ttl := auth.DefaultInvitationTTL
	if in.ExpiresInHours != nil {
		h := *in.ExpiresInHours
		if h != float64(int64(h)) || h < 1 || h > 720 {
			writeError(w, http.StatusBadRequest, "invalid_input", auth.ErrInvalidExpiry.Error())
			return
		}
		ttl = time.Duration(h) * time.Hour
	}
	inv, secret, err := s.auth.CreateInvitation(r.Context(), u, in.Email, ttl)
	switch {
	case errors.Is(err, auth.ErrInvalidEmail):
		writeError(w, http.StatusBadRequest, "invalid_input", "email: "+err.Error())
		return
	case errors.Is(err, auth.ErrInvalidExpiry):
		writeError(w, http.StatusBadRequest, "invalid_input", err.Error())
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	link := s.inviteLinkOrigin(r, msg) + "/invite/" + secret
	out := map[string]any{"invitation": inv, "link": link}
	if in.Send {
		msg.Vars.Link, msg.Vars.Expiry = link, ttl
		if err := s.mail.Send(r.Context(), msg); err != nil {
			if rerr := s.auth.RevokeInvitation(context.WithoutCancel(r.Context()), u.ID, inv.ID); rerr != nil {
				s.log.Error("revoke unsent invitation", "err", rerr)
			}
			s.mailSendError(w, err)
			return
		}
		out["sent"] = true
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleRevokeInvitation(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	err := s.auth.RevokeInvitation(r.Context(), u.ID, r.PathValue("id"))
	switch {
	case errors.Is(err, auth.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "invitation not found")
		return
	case errors.Is(err, auth.ErrInvitationSpent):
		writeError(w, http.StatusConflict, "invitation_spent", err.Error())
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePreviewInvitation is public: the invitee has no account yet. The
// invite-link limiter makes token guessing as expensive as password guessing,
// and every failure is the same 404.
func (s *Server) handlePreviewInvitation(w http.ResponseWriter, r *http.Request) {
	if !s.invitePreviewLimiter.allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many attempts, try again later")
		return
	}
	p, err := s.auth.PreviewInvitation(r.Context(), r.PathValue("token"))
	if errors.Is(err, auth.ErrInvitationInvalid) {
		writeError(w, http.StatusNotFound, "invitation_invalid", err.Error())
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// publicOrigin is the base for links handed to the signed-in user who asked for
// them (CalDAV address, feeds, public links, copied invite links): the
// configured base URL when set, otherwise the origin of the request, so LAN
// installs still get a working link. Links that are mailed use mailLinkOrigin.
func (s *Server) publicOrigin(r *http.Request) string {
	if o := s.cfg.Origin(); o != "" {
		return o
	}
	scheme := "http"
	if requestIsHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + requestHost(r)
}

// requestHost is the host the client asked for: the request's Host, or
// X-Forwarded-Host when the connection comes from a trusted proxy
// (OPENTODO_TRUSTED_PROXIES). Anyone else could name any host in that header
// (OpenSpec change harden-links-and-sharing).
func requestHost(r *http.Request) string {
	if fromTrustedProxy(r) {
		if fwd := firstHeaderValue(r, "X-Forwarded-Host"); fwd != "" {
			return fwd
		}
	}
	return r.Host
}

func firstHeaderValue(r *http.Request, name string) string {
	return strings.TrimSpace(strings.Split(r.Header.Get(name), ",")[0])
}

// mailLinkOrigin is the base for links that grant access and leave the server
// by email (password reset, sign-up verification, invitations): the configured
// base URL only, never anything taken from the request, which an anonymous
// caller controls. Without one it writes 409 base_url_required and returns "".
func (s *Server) mailLinkOrigin(w http.ResponseWriter) string {
	o := s.cfg.Origin()
	if o == "" {
		writeError(w, http.StatusConflict, "base_url_required", "emailed links need the server's public address: the owner must set OPENTODO_BASE_URL")
	}
	return o
}
