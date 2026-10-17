package httpapi

import (
	"sync"
	"time"
)

// rateLimiter is a fixed-window per-key counter, enough to blunt password
// guessing. Keys that are IPv6 addresses count per /64 (addrKey). Expired
// windows are removed by a background sweep, never while counting a hit
// (trusted-client-identity).
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
}

type window struct {
	start   time.Time
	count   int
	refused int // refusals counted by check
}

func newRateLimiter(limit int, w time.Duration) *rateLimiter {
	l := &rateLimiter{limit: limit, window: w, hits: map[string]*window{}}
	limiterSweeper.add(l)
	return l
}

// blocked reports whether key already used up its window, without counting an
// attempt (callers that count only failures check this first, then hit).
func (l *rateLimiter) blocked(key string) bool {
	key = addrKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	return ok && time.Since(w.start) <= l.window && w.count >= l.limit
}

// check is blocked plus firstRefusal: true for exactly one refused check per
// window, so callers log one event per window instead of one per attempt.
func (l *rateLimiter) check(key string) (blocked, firstRefusal bool) {
	key = addrKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	if !ok || time.Since(w.start) > l.window || w.count < l.limit {
		return false, false
	}
	w.refused++
	return true, w.refused == 1
}

// retryAfter is how long until key's window ends (0 when it is not blocked).
func (l *rateLimiter) retryAfter(key string) time.Duration {
	key = addrKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	if !ok || w.count < l.limit {
		return 0
	}
	return max(0, l.window-time.Since(w.start))
}

// reset forgets key's attempts (a successful sign-in clears its failures).
func (l *rateLimiter) reset(key string) {
	key = addrKey(key)
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

func (l *rateLimiter) allow(key string) bool {
	ok, _ := l.hit(key)
	return ok
}

// hit counts one attempt for key. firstRefusal is true for exactly one refused
// attempt per window: the first one over the limit.
func (l *rateLimiter) hit(key string) (allowed, firstRefusal bool) {
	key = addrKey(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.hits[key]
	if !ok || now.Sub(w.start) > l.window {
		l.hits[key] = &window{start: now, count: 1}
		return true, false
	}
	w.count++
	return w.count <= l.limit, w.count == l.limit+1
}

// sweep removes the windows that ended before now.
func (l *rateLimiter) sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, v := range l.hits {
		if now.Sub(v.start) > l.window {
			delete(l.hits, k)
		}
	}
}
