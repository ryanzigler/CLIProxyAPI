package cliproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/proxyutil"
	log "github.com/sirupsen/logrus"
)

// The usage reader fills in quota for credentials that are not carrying
// traffic. Busy credentials report their quota on every response, so the
// usage endpoints are read rarely, in the background, one call at a time.
const (
	usageReaderTick       = time.Minute
	usageReadStaleAfter   = 30 * time.Minute
	usageReadMinSpacing   = 5 * time.Minute
	usageReadErrorBackoff = 10 * time.Minute
	usageReadMaxBackoff   = 2 * time.Hour
	usageReadTimeout      = 20 * time.Second
)

var (
	claudeUsageURL = "https://api.anthropic.com/api/oauth/usage"
	codexUsageURL  = "https://chatgpt.com/backend-api/wham/usage"
)

type usageReadThrottled struct{ retryAfter time.Duration }

func (e *usageReadThrottled) Error() string { return "usage endpoint throttled" }

type usageReader struct {
	list      func() []*coreauth.Auth
	proxyURL  func() string
	client    func(proxyURL string) *http.Client
	now       func() time.Time
	attempted map[string]time.Time
	backoff   map[string]time.Time
}

func (s *Service) runQuotaUsageReader(ctx context.Context) {
	reader := &usageReader{
		list: s.coreManager.List,
		proxyURL: func() string {
			s.cfgMu.RLock()
			defer s.cfgMu.RUnlock()
			if s.cfg == nil {
				return ""
			}
			return s.cfg.ProxyURL
		},
		client:    usageHTTPClient,
		now:       time.Now,
		attempted: map[string]time.Time{},
		backoff:   map[string]time.Time{},
	}
	ticker := time.NewTicker(usageReaderTick)
	defer ticker.Stop()
	for {
		reader.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// tick reads the usage of at most one credential: the one whose quota is
// oldest among those that need a reading.
func (r *usageReader) tick(ctx context.Context) {
	now := r.now()
	var next *coreauth.Auth
	var nextObserved time.Time
	for _, auth := range r.list() {
		if !usageReadable(auth) {
			continue
		}
		observed := coreauth.QuotaObservedAt(auth)
		if !observed.IsZero() && now.Sub(observed) < usageReadStaleAfter {
			continue
		}
		if r.backoff[auth.ID].After(now) || now.Sub(r.attempted[auth.ID]) < usageReadMinSpacing {
			continue
		}
		if next == nil || observed.Before(nextObserved) {
			next, nextObserved = auth, observed
		}
	}
	if next == nil {
		return
	}
	r.attempted[next.ID] = now
	proxyURL := strings.TrimSpace(next.ProxyURL)
	if proxyURL == "" {
		proxyURL = strings.TrimSpace(r.proxyURL())
	}
	windows, err := readUsage(ctx, r.client(proxyURL), next, now)
	if err != nil {
		delay := usageReadErrorBackoff
		var throttled *usageReadThrottled
		if errors.As(err, &throttled) {
			delay = max(throttled.retryAfter, usageReadMinSpacing)
		}
		r.backoff[next.ID] = now.Add(min(delay, usageReadMaxBackoff))
		log.WithFields(log.Fields{"auth": next.ID, "retry_in": delay.String()}).Debugf("quota usage read failed: %v", err)
		return
	}
	delete(r.backoff, next.ID)
	coreauth.RecordUsageReading(next.ID, windows, now)
}

func usageReadable(auth *coreauth.Auth) bool {
	if auth == nil || auth.Disabled {
		return false
	}
	switch strings.ToLower(auth.Provider) {
	case "claude", "codex":
		return metadataString(auth.Metadata, "access_token") != ""
	}
	return false
}

func usageHTTPClient(proxyURL string) *http.Client {
	transport := proxyutil.NewDirectTransport()
	if proxyURL != "" {
		if built, _, err := proxyutil.BuildHTTPTransport(proxyURL); err == nil && built != nil {
			transport = built
		}
	}
	return &http.Client{Transport: transport, Timeout: usageReadTimeout}
}

func metadataString(metadata map[string]any, key string) string {
	if value, ok := metadata[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func readUsage(ctx context.Context, client *http.Client, auth *coreauth.Auth, now time.Time) ([]coreauth.QuotaWindow, error) {
	provider := strings.ToLower(auth.Provider)
	url := claudeUsageURL
	if provider == "codex" {
		url = codexUsageURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+metadataString(auth.Metadata, "access_token"))
	req.Header.Set("Accept", "application/json")
	if provider == "claude" {
		req.Header.Set("anthropic-beta", "oauth-2025-04-20")
		req.Header.Set("User-Agent", "claude-cli/2.1.289 (external, cli)")
	} else {
		accountID := metadataString(auth.Metadata, "account_id")
		if accountID == "" {
			return nil, errors.New("codex account id missing")
		}
		req.Header.Set("Chatgpt-Account-Id", accountID)
		req.Header.Set("User-Agent", "codex-tui/0.160.0")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		retryAfter := usageReadErrorBackoff
		if seconds, errParse := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); errParse == nil && seconds > 0 {
			retryAfter = time.Duration(seconds) * time.Second
		}
		return nil, &usageReadThrottled{retryAfter: retryAfter}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage endpoint returned %d", resp.StatusCode)
	}
	if provider == "claude" {
		return parseClaudeUsage(body, now)
	}
	return parseCodexUsage(body, now)
}

type claudeUsageWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

func parseClaudeUsage(body []byte, now time.Time) ([]coreauth.QuotaWindow, error) {
	var raw struct {
		FiveHour *claudeUsageWindow `json:"five_hour"`
		SevenDay *claudeUsageWindow `json:"seven_day"`
		Limits   []struct {
			Kind     string   `json:"kind"`
			Percent  *float64 `json:"percent"`
			ResetsAt string   `json:"resets_at"`
			Scope    struct {
				Model struct {
					ID          string `json:"id"`
					DisplayName string `json:"display_name"`
				} `json:"model"`
			} `json:"scope"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("invalid claude usage JSON: %w", err)
	}
	var windows []coreauth.QuotaWindow
	add := func(kind, scope string, percent *float64, resetsAt string, period time.Duration) {
		if percent == nil || *percent < 0 {
			return
		}
		reset, err := time.Parse(time.RFC3339, strings.TrimSpace(resetsAt))
		if err != nil {
			return
		}
		windows = append(windows, coreauth.QuotaWindow{Kind: kind, Scope: scope, Used: min(*percent/100, 1), ResetAt: reset, Period: period, Source: coreauth.QuotaSourceUsage, ObservedAt: now})
	}
	if raw.FiveHour != nil {
		add(coreauth.QuotaWindowFiveHour, "", raw.FiveHour.Utilization, raw.FiveHour.ResetsAt, 5*time.Hour)
	}
	if raw.SevenDay != nil {
		add(coreauth.QuotaWindowWeekly, "", raw.SevenDay.Utilization, raw.SevenDay.ResetsAt, 7*24*time.Hour)
	}
	for _, limit := range raw.Limits {
		if limit.Kind != "weekly_scoped" {
			continue
		}
		scope := limit.Scope.Model.DisplayName
		if scope == "" {
			scope = limit.Scope.Model.ID
		}
		fields := strings.Fields(strings.ToLower(scope))
		if len(fields) == 0 {
			continue
		}
		scope = fields[0]
		add(coreauth.QuotaWindowWeeklyScoped, scope, limit.Percent, limit.ResetsAt, 7*24*time.Hour)
	}
	if len(windows) == 0 {
		return nil, errors.New("claude usage has no windows")
	}
	return windows, nil
}

func parseCodexUsage(body []byte, now time.Time) ([]coreauth.QuotaWindow, error) {
	type codexWindow struct {
		UsedPercent *float64 `json:"used_percent"`
		ResetAt     *int64   `json:"reset_at"`
		Seconds     int64    `json:"limit_window_seconds"`
	}
	var raw struct {
		RateLimit struct {
			Primary   *codexWindow `json:"primary_window"`
			Secondary *codexWindow `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("invalid codex usage JSON: %w", err)
	}
	var windows []coreauth.QuotaWindow
	for _, w := range []*codexWindow{raw.RateLimit.Primary, raw.RateLimit.Secondary} {
		if w == nil || w.UsedPercent == nil || w.ResetAt == nil || w.Seconds <= 0 {
			continue
		}
		period := time.Duration(w.Seconds) * time.Second
		kind := coreauth.QuotaWindowWeekly
		if period <= 5*time.Hour {
			kind = coreauth.QuotaWindowFiveHour
		}
		windows = append(windows, coreauth.QuotaWindow{Kind: kind, Used: min(*w.UsedPercent/100, 1), ResetAt: time.Unix(*w.ResetAt, 0), Period: period, Source: coreauth.QuotaSourceUsage, ObservedAt: now})
	}
	if len(windows) == 0 {
		return nil, errors.New("codex usage has no windows")
	}
	return windows, nil
}
