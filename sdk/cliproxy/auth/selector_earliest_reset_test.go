package auth

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

var earliestResetNow = time.Date(2026, 10, 9, 15, 0, 0, 0, time.UTC)

func claudeAuthWithHeaders(id string, fiveHour, weekly, fable float64, weeklyReset, fableReset time.Time) *Auth {
	unix := func(t time.Time) string { return strconv.FormatInt(t.Unix(), 10) }
	format := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	return &Auth{
		ID:       id,
		Provider: "claude",
		Quota: QuotaState{
			ObservedAt: earliestResetNow.Add(-time.Minute),
			Signals: map[string]string{
				"Anthropic-Ratelimit-Unified-5h-Utilization":    format(fiveHour),
				"Anthropic-Ratelimit-Unified-5h-Reset":          unix(earliestResetNow.Add(2 * time.Hour)),
				"Anthropic-Ratelimit-Unified-7d-Utilization":    format(weekly),
				"Anthropic-Ratelimit-Unified-7d-Reset":          unix(weeklyReset),
				"Anthropic-Ratelimit-Unified-7d_oi-Utilization": format(fable),
				"Anthropic-Ratelimit-Unified-7d_oi-Reset":       unix(fableReset),
			},
		},
	}
}

func pickEarliestReset(t *testing.T, model string, auths ...*Auth) string {
	t.Helper()
	selector := &EarliestResetSelector{Now: func() time.Time { return earliestResetNow }}
	got, err := selector.Pick(context.Background(), "claude", model, cliproxyexecutor.Options{}, auths)
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	return got.ID
}

func TestEarliestResetPrefersSoonestWeeklyReset(t *testing.T) {
	soon := claudeAuthWithHeaders("soon", 0.5, 0.5, 0.1, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	later := claudeAuthWithHeaders("later", 0.1, 0.1, 0.1, earliestResetNow.Add(5*24*time.Hour), earliestResetNow.Add(5*24*time.Hour))
	if got := pickEarliestReset(t, "claude-opus-5-5", later, soon); got != "soon" {
		t.Fatalf("picked %s, want soon", got)
	}
}

func TestEarliestResetSkipsWindowAtThreshold(t *testing.T) {
	full := claudeAuthWithHeaders("full", 0.99, 0.5, 0.1, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	open := claudeAuthWithHeaders("open", 0.1, 0.1, 0.1, earliestResetNow.Add(5*24*time.Hour), earliestResetNow.Add(5*24*time.Hour))
	if got := pickEarliestReset(t, "claude-opus-5-5", full, open); got != "open" {
		t.Fatalf("picked %s, want open", got)
	}
}

func TestEarliestResetScopedWindowOnlyLimitsScopedModels(t *testing.T) {
	fableFull := claudeAuthWithHeaders("fable-full", 0.1, 0.5, 1, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	other := claudeAuthWithHeaders("other", 0.1, 0.1, 0.1, earliestResetNow.Add(5*24*time.Hour), earliestResetNow.Add(5*24*time.Hour))
	if got := pickEarliestReset(t, "claude-fable-5-1", fableFull, other); got != "other" {
		t.Fatalf("fable request picked %s, want other", got)
	}
	if got := pickEarliestReset(t, "claude-opus-5-5", fableFull, other); got != "fable-full" {
		t.Fatalf("opus request picked %s, want fable-full", got)
	}
}

func TestEarliestResetRanksUnknownAfterKnownButKeepsIt(t *testing.T) {
	unknown := &Auth{ID: "unknown", Provider: "claude"}
	known := claudeAuthWithHeaders("known", 0.1, 0.1, 0.1, earliestResetNow.Add(5*24*time.Hour), earliestResetNow.Add(5*24*time.Hour))
	if got := pickEarliestReset(t, "claude-opus-5-5", unknown, known); got != "known" {
		t.Fatalf("picked %s, want known", got)
	}
	if got := pickEarliestReset(t, "claude-opus-5-5", unknown); got != "unknown" {
		t.Fatalf("picked %s, want unknown", got)
	}
}

func TestEarliestResetNeverEmptiesThePool(t *testing.T) {
	a := claudeAuthWithHeaders("a", 0.99, 0.99, 0.99, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	b := claudeAuthWithHeaders("b", 0.99, 0.6, 0.99, earliestResetNow.Add(2*24*time.Hour), earliestResetNow.Add(2*24*time.Hour))
	if got := pickEarliestReset(t, "claude-opus-5-5", a, b); got == "" {
		t.Fatal("no credential picked")
	}
}

func TestEarliestResetPassedResetCountsAsUnused(t *testing.T) {
	stale := claudeAuthWithHeaders("stale", 1, 0.5, 0.1, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	stale.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Reset"] = strconv.FormatInt(earliestResetNow.Add(-time.Minute).Unix(), 10)
	other := claudeAuthWithHeaders("other", 0.1, 0.1, 0.1, earliestResetNow.Add(5*24*time.Hour), earliestResetNow.Add(5*24*time.Hour))
	if got := pickEarliestReset(t, "claude-opus-5-5", stale, other); got != "stale" {
		t.Fatalf("picked %s, want stale (its full 5h window has reset)", got)
	}
	for _, w := range QuotaWindows(stale, earliestResetNow) {
		if w.Kind == QuotaWindowFiveHour && (w.Used != 0 || !w.ResetAt.After(earliestResetNow)) {
			t.Fatalf("passed 5h window = %+v, want unused with a future reset", w)
		}
	}
}

func TestQuotaWindowsPrefersNewerUsageReading(t *testing.T) {
	auth := claudeAuthWithHeaders("reading", 0.9, 0.5, 0.1, earliestResetNow.Add(24*time.Hour), earliestResetNow.Add(24*time.Hour))
	t.Cleanup(func() { ForgetUsageReading(auth.ID) })
	RecordUsageReading(auth.ID, []QuotaWindow{{Kind: QuotaWindowFiveHour, Used: 0.2, ResetAt: earliestResetNow.Add(time.Hour), Source: QuotaSourceUsage, ObservedAt: earliestResetNow}}, earliestResetNow)
	found := false
	for _, w := range QuotaWindows(auth, earliestResetNow) {
		if w.Kind == QuotaWindowFiveHour {
			found = true
			if w.Used != 0.2 || w.Source != QuotaSourceUsage {
				t.Fatalf("5h window = %+v, want the newer usage reading", w)
			}
		}
	}
	if !found {
		t.Fatal("5h window missing")
	}
	if got := QuotaObservedAt(auth); !got.Equal(earliestResetNow) {
		t.Fatalf("QuotaObservedAt = %s, want %s", got, earliestResetNow)
	}
}

func TestWindowsFromCodexSignals(t *testing.T) {
	signals := map[string]string{
		"X-Codex-Primary-Used-Percent":        "40",
		"X-Codex-Primary-Window-Minutes":      "300",
		"X-Codex-Primary-Reset-After-Seconds": "600",
		"X-Codex-Secondary-Used-Percent":      "11",
		"X-Codex-Secondary-Window-Minutes":    "10080",
		"X-Codex-Secondary-Reset-At":          strconv.FormatInt(earliestResetNow.Add(4*24*time.Hour).Unix(), 10),
	}
	windows := windowsFromSignals("codex", signals, earliestResetNow)
	if len(windows) != 2 {
		t.Fatalf("got %d windows, want 2: %+v", len(windows), windows)
	}
	if windows[0].Kind != QuotaWindowFiveHour || windows[0].Used != 0.4 || !windows[0].ResetAt.Equal(earliestResetNow.Add(10*time.Minute)) {
		t.Fatalf("primary = %+v", windows[0])
	}
	if windows[1].Kind != QuotaWindowWeekly || windows[1].Used != 0.11 {
		t.Fatalf("secondary = %+v", windows[1])
	}
}

func TestEarliestResetRunsThroughManagerWithSessionAffinity(t *testing.T) {
	now := time.Now()
	soon := claudeAuthWithHeaders("er-manager-soon", 0.1, 0.5, 0.1, now.Add(24*time.Hour), now.Add(24*time.Hour))
	later := claudeAuthWithHeaders("er-manager-later", 0.1, 0.1, 0.1, now.Add(5*24*time.Hour), now.Add(5*24*time.Hour))
	cooling := claudeAuthWithHeaders("er-manager-cooling", 0.1, 0.1, 0.1, now.Add(time.Hour), now.Add(time.Hour))
	cooling.Unavailable = true
	cooling.NextRetryAfter = now.Add(time.Hour)
	cooling.Status = StatusError
	for _, auth := range []*Auth{soon, later, cooling} {
		auth.Quota.ObservedAt = now
		registry.GetGlobalRegistry().RegisterClient(auth.ID, auth.Provider, []*registry.ModelInfo{{ID: "claude-opus-5-5"}})
		id := auth.ID
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(id) })
	}
	selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &EarliestResetSelector{}, TTL: time.Hour})
	manager := NewManager(nil, selector, nil)
	manager.RegisterExecutor(&refreshMockExecutor{id: "claude"})
	for _, auth := range []*Auth{later, soon, cooling} {
		if _, err := manager.Register(context.Background(), auth); err != nil {
			t.Fatalf("Register %s: %v", auth.ID, err)
		}
	}
	picked, _, err := manager.pickNext(context.Background(), "claude", "claude-opus-5-5", cliproxyexecutor.Options{}, nil)
	if err != nil {
		t.Fatalf("pickNext: %v", err)
	}
	if picked.ID != soon.ID {
		t.Fatalf("picked %s, want %s (soonest weekly reset among available credentials)", picked.ID, soon.ID)
	}
}
