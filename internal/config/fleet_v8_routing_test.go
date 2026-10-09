package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFleetV8RoutingKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	raw := "config-version: 8\nserver:\n  host: \"127.0.0.1\"\n  port: 8317\nrouting:\n  strategy: earliest-reset\n  quota-threshold: 0.95\n  session-affinity: true\n  session-affinity-ttl: \"24h\"\n  retry:\n    request-retry: 0\n    max-retry-credentials: 2\n  cooldown:\n    save-cooldown-status: true\n"
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Routing.Strategy != "earliest-reset" || cfg.Routing.QuotaThreshold != 0.95 || !cfg.Routing.SessionAffinity || cfg.MaxRetryCredentials != 2 {
		t.Fatalf("routing = %+v, max-retry-credentials = %d", cfg.Routing, cfg.MaxRetryCredentials)
	}
}
