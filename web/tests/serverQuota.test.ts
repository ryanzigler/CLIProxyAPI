import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { claudeWindowsFromServer, codexWindowsFromServer } from '@/features/quota/serverQuota';
import { apiCallApi } from '@/services/api';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as TFunction;

const claudeFile = {
  name: 'claude-a.json',
  type: 'claude',
  auth_index: 'a',
  quota_windows: [
    {
      kind: 'five_hour',
      used: 0.08,
      reset_at: '2026-10-09T17:30:00Z',
      source: 'response',
      observed_at: '2026-10-09T15:00:00Z',
    },
    {
      kind: 'weekly',
      used: 0.02,
      reset_at: '2026-10-15T21:00:00Z',
      source: 'usage',
      observed_at: '2026-10-09T15:00:00Z',
    },
    {
      kind: 'weekly_scoped',
      scope: 'fable',
      used: 0,
      reset_at: '2026-10-15T21:00:00Z',
      source: 'usage',
      observed_at: '2026-10-09T15:00:00Z',
    },
    {
      kind: 'weekly_scoped',
      scope: 'other',
      used: 0.5,
      reset_at: '2026-10-15T21:00:00Z',
      source: 'usage',
      observed_at: '2026-10-09T15:00:00Z',
    },
  ],
} as unknown as AuthFileItem;

describe('server quota windows', () => {
  test('maps Claude windows to the panel ids and percentages', () => {
    const windows = claudeWindowsFromServer(claudeFile, t);
    expect(windows.map((window) => window.id)).toEqual([
      'five-hour',
      'seven-day',
      'seven-day-fable',
    ]);
    expect(windows.map((window) => window.usedPercent)).toEqual([8, 2, 0]);
    expect(windows[0]?.resetAtMs).toBe(Date.parse('2026-10-09T17:30:00Z'));
    expect(windows[0]?.periodHours).toBe(5);
  });

  test('maps Codex windows and treats an unknown reset as missing', () => {
    const file = {
      name: 'codex-a.json',
      type: 'codex',
      quota_windows: [
        {
          kind: 'weekly',
          used: 0.11,
          reset_at: '0001-01-01T00:00:00Z',
          source: 'usage',
          observed_at: '2026-10-09T15:00:00Z',
        },
      ],
    } as unknown as AuthFileItem;
    const windows = codexWindowsFromServer(file, t);
    expect(windows.map((window) => window.id)).toEqual(['weekly']);
    expect(windows[0]?.usedPercent).toBe(11);
    expect(windows[0]?.resetAtMs).toBeNull();
  });

  test('loading quota never calls the provider', async () => {
    const original = apiCallApi.request;
    let calls = 0;
    apiCallApi.request = (async () => {
      calls += 1;
      throw new Error('unexpected provider call');
    }) as typeof apiCallApi.request;
    try {
      const claude = await CLAUDE_CONFIG.fetchQuota(claudeFile, t);
      expect(claude.windows).toHaveLength(3);
      await expect(
        CODEX_CONFIG.fetchQuota({ name: 'codex-b.json', type: 'codex' } as AuthFileItem, t)
      ).rejects.toThrow('codex_quota.empty_windows');
    } finally {
      apiCallApi.request = original;
    }
    expect(calls).toBe(0);
  });
});
