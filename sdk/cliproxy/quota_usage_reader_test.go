package cliproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestUsageReaderReadsStaleCredentialsOneAtATime(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer token-a" && r.Header.Get("Authorization") != "Bearer token-b" {
			t.Errorf("unexpected authorization header")
		}
		_, _ = w.Write([]byte(`{"five_hour":{"utilization":8,"resets_at":"2026-10-09T17:30:00Z"},"seven_day":{"utilization":2,"resets_at":"2026-10-15T21:00:00Z"},"limits":[{"kind":"weekly_scoped","percent":0,"resets_at":"2026-10-15T21:00:00Z","scope":{"model":{"display_name":"Fable"}}}]}`))
	}))
	defer server.Close()
	original := claudeUsageURL
	claudeUsageURL = server.URL
	defer func() { claudeUsageURL = original }()

	now := time.Date(2026, 10, 9, 15, 0, 0, 0, time.UTC)
	auths := []*coreauth.Auth{
		{ID: "usage-a", Provider: "claude", Metadata: map[string]any{"access_token": "token-a"}},
		{ID: "usage-b", Provider: "claude", Metadata: map[string]any{"access_token": "token-b"}},
	}
	defer coreauth.ForgetUsageReading("usage-a")
	defer coreauth.ForgetUsageReading("usage-b")
	reader := &usageReader{
		list:      func() []*coreauth.Auth { return auths },
		proxyURL:  func() string { return "" },
		client:    func(string) *http.Client { return server.Client() },
		now:       func() time.Time { return now },
		attempted: map[string]time.Time{},
		backoff:   map[string]time.Time{},
	}

	reader.tick(context.Background())
	if calls.Load() != 1 {
		t.Fatalf("first tick made %d calls, want 1", calls.Load())
	}
	reader.tick(context.Background())
	if calls.Load() != 2 {
		t.Fatalf("second tick made %d calls, want 2", calls.Load())
	}
	reader.tick(context.Background())
	if calls.Load() != 2 {
		t.Fatalf("fresh credentials were read again: %d calls", calls.Load())
	}
	windows := coreauth.QuotaWindows(auths[0], now)
	if len(windows) != 3 {
		t.Fatalf("got %d windows, want 3: %+v", len(windows), windows)
	}
	for _, w := range windows {
		if w.Kind == coreauth.QuotaWindowWeeklyScoped && w.Scope != "fable" {
			t.Fatalf("scoped window scope = %q, want fable", w.Scope)
		}
		if w.Kind == coreauth.QuotaWindowFiveHour && w.Used != 0.08 {
			t.Fatalf("5h used = %v, want 0.08", w.Used)
		}
	}
}

func TestUsageReaderBacksOffWhenThrottled(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "1200")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	original := claudeUsageURL
	claudeUsageURL = server.URL
	defer func() { claudeUsageURL = original }()

	now := time.Date(2026, 10, 9, 15, 0, 0, 0, time.UTC)
	auth := &coreauth.Auth{ID: "throttled", Provider: "claude", Metadata: map[string]any{"access_token": "token"}}
	reader := &usageReader{
		list:      func() []*coreauth.Auth { return []*coreauth.Auth{auth} },
		proxyURL:  func() string { return "" },
		client:    func(string) *http.Client { return server.Client() },
		now:       func() time.Time { return now },
		attempted: map[string]time.Time{},
		backoff:   map[string]time.Time{},
	}
	reader.tick(context.Background())
	now = now.Add(15 * time.Minute)
	reader.tick(context.Background())
	if calls.Load() != 1 {
		t.Fatalf("read again during Retry-After: %d calls", calls.Load())
	}
	now = now.Add(6 * time.Minute)
	reader.tick(context.Background())
	if calls.Load() != 2 {
		t.Fatalf("did not read after Retry-After passed: %d calls", calls.Load())
	}
	if len(coreauth.QuotaWindows(auth, now)) != 0 {
		t.Fatal("a throttled read recorded windows")
	}
}
