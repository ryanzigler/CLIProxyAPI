/**
 * Ledger view logic: flattening provider quota into comparable windows,
 * provider summaries ("409% of 500%"), and row column alignment.
 */

import { describe, expect, test } from 'bun:test';
import {
  pickHeadlineKey,
  pickLedgerColumns,
  summarizeProvider,
  toQuotaWindows,
  windowKey,
} from '@/features/quota/quotaWindows';
import { formatLedgerReset, meterLevel } from '@/features/quota/components/ledgerFormat';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const now = Date.UTC(2026, 9, 8, 12, 0, 0);

const claudeQuota = (fable: number | null, fiveHour: number, sevenDay: number, resetDays = 1) => ({
  status: 'success',
  planType: 'plan_max',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      labelKey: 'claude_quota.five_hour',
      usedPercent: 100 - fiveHour,
      resetLabel: '-',
      resetAtMs: null,
      periodHours: 5,
    },
    {
      id: 'seven-day',
      label: '7-day limit',
      labelKey: 'claude_quota.seven_day',
      usedPercent: 100 - sevenDay,
      resetLabel: '10/09 22:00',
      resetAtMs: now + resetDays * DAY_MS,
      periodHours: 168,
    },
    {
      id: 'seven-day-cowork',
      label: 'Cowork',
      usedPercent: 10,
      resetLabel: '-',
      resetAtMs: null,
      periodHours: 168,
    },
    ...(fable === null
      ? []
      : [
          {
            id: 'seven-day-fable',
            label: '7-day Fable 5',
            labelKey: 'claude_quota.seven_day_fable',
            usedPercent: 100 - fable,
            resetLabel: '10/09 22:00',
            resetAtMs: now + resetDays * DAY_MS,
            periodHours: 168,
          },
        ]),
  ],
});

describe('toQuotaWindows', () => {
  test('classifies Claude windows and drops unscoped extras', () => {
    const windows = toQuotaWindows('claude', claudeQuota(93, 100, 89));
    expect(windows.map((window) => [window.id, window.kind, window.remaining])).toEqual([
      ['five-hour', 'session', 100],
      ['seven-day', 'weekly', 89],
      ['seven-day-fable', 'model', 93],
    ]);
  });

  test('keeps Codex account windows, drops code review and model 5-hour halves', () => {
    const windows = toQuotaWindows('codex', {
      status: 'success',
      windows: [
        { id: 'weekly', label: 'Weekly limit', usedPercent: 11, periodHours: 168 },
        { id: 'code-review-weekly', label: 'Code review', usedPercent: 0, periodHours: 168 },
        { id: 'spark-five-hour-0', label: 'Spark 5h', usedPercent: 0, periodHours: 5 },
        { id: 'spark-weekly-0', label: 'Spark weekly', usedPercent: 40, periodHours: 168 },
      ],
    });
    expect(windows.map((window) => [window.id, window.kind, window.remaining])).toEqual([
      ['weekly', 'weekly', 89],
      ['spark-weekly-0', 'model', 60],
    ]);
  });

  test('returns nothing for credentials that have not loaded', () => {
    expect(toQuotaWindows('claude', { status: 'idle' })).toEqual([]);
    expect(toQuotaWindows('claude', undefined)).toEqual([]);
  });

  test('reads Antigravity remaining fractions and Kimi counts as remaining percent', () => {
    expect(
      toQuotaWindows('antigravity', {
        status: 'success',
        groups: [
          { buckets: [{ id: 'g', label: 'Gemini', remainingFraction: 0.42, periodHours: 5 }] },
        ],
      }).map((window) => [window.kind, window.remaining])
    ).toEqual([['session', 42]]);
    expect(
      toQuotaWindows('kimi', {
        status: 'success',
        rows: [{ id: 'weekly', label: 'Weekly', used: 25, limit: 100, periodHours: 168 }],
      }).map((window) => [window.kind, window.remaining])
    ).toEqual([['weekly', 75]]);
  });
});

describe('summarizeProvider', () => {
  const accounts = [
    toQuotaWindows('claude', claudeQuota(58, 100, 79, 1)),
    toQuotaWindows('claude', claudeQuota(100, 100, 100, 4)),
    toQuotaWindows('claude', claudeQuota(51, 99, 75, 2)),
    toQuotaWindows('claude', { status: 'idle' }),
  ];

  test('headlines the model window with an account-equivalent sum over every credential', () => {
    const summary = summarizeProvider('claude', accounts, now);
    expect(summary.credentialCount).toBe(4);
    expect(summary.headline?.sample.id).toBe('seven-day-fable');
    expect(summary.headline?.sum).toBe(209);
    expect(summary.headline?.known).toBe(3);
    // The unloaded credential keeps its segment, empty.
    expect(summary.headline?.segments).toEqual([58, 100, 51, null]);
    expect(summary.headline?.soonestResetMs).toBe(now + DAY_MS);
  });

  test('lists shared weekly before session as secondary lines', () => {
    const summary = summarizeProvider('claude', accounts, now);
    expect(summary.secondary.map((line) => [line.key, line.sum])).toEqual([
      ['weekly', 254],
      ['session', 299],
    ]);
  });

  test('falls back to the weekly window without a model window', () => {
    const codex = [
      toQuotaWindows('codex', {
        status: 'success',
        windows: [{ id: 'weekly', label: 'Weekly limit', usedPercent: 83, periodHours: 168 }],
      }),
    ];
    expect(pickHeadlineKey(codex)).toBe('weekly');
    const summary = summarizeProvider('codex', codex, now);
    expect(summary.headline?.sum).toBe(17);
    expect(summary.secondary).toEqual([]);
  });

  test('reports no headline when nothing has loaded', () => {
    const summary = summarizeProvider('xai', [[]], now);
    expect(summary.headline).toBeNull();
    expect(summary.credentialCount).toBe(1);
  });

  test('ignores resets that already passed when picking the soonest', () => {
    const stale = toQuotaWindows('claude', claudeQuota(50, 100, 50, -1));
    const fresh = toQuotaWindows('claude', claudeQuota(50, 100, 50, 3));
    expect(summarizeProvider('claude', [stale, fresh], now).headline?.soonestResetMs).toBe(
      now + 3 * DAY_MS
    );
  });
});

describe('pickLedgerColumns', () => {
  test('orders model, session, then weekly and aligns to the headline model', () => {
    const windows = [
      ...toQuotaWindows('claude', claudeQuota(93, 100, 89)),
      {
        id: 'seven-day-opus',
        kind: 'model' as const,
        label: 'Opus',
        remaining: 40,
        resetAtMs: null,
        periodHours: 168,
      },
    ];
    const fableKey = windowKey(windows.find((window) => window.id === 'seven-day-fable')!);
    expect(pickLedgerColumns(windows, fableKey).map((window) => window.id)).toEqual([
      'seven-day-fable',
      'five-hour',
      'seven-day',
    ]);
  });

  test('omits kinds a credential does not report', () => {
    const windows = toQuotaWindows('codex', {
      status: 'success',
      windows: [{ id: 'weekly', label: 'Weekly limit', usedPercent: 11, periodHours: 168 }],
    });
    expect(pickLedgerColumns(windows, 'weekly').map((window) => window.id)).toEqual(['weekly']);
  });
});

describe('formatLedgerReset', () => {
  test('pairs the countdown with the absolute instant', () => {
    const reset = formatLedgerReset(now + 26 * HOUR_MS, null, now, 'en');
    expect(reset?.relative).toBe('in 1 day');
    expect(reset?.absolute).toBeTruthy();
  });

  test('falls back to a baked label, then to nothing pending', () => {
    expect(formatLedgerReset(null, '10/09 22:00', now, 'en')).toEqual({
      relative: null,
      absolute: '10/09 22:00',
    });
    expect(formatLedgerReset(null, '-', now, 'en')).toBeNull();
    expect(formatLedgerReset(now - HOUR_MS, null, now, 'en')).toBeNull();
  });

  test('meter levels follow the bar thresholds', () => {
    expect([100, 70, 69, 30, 29, null].map(meterLevel)).toEqual([
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'unknown',
    ]);
  });
});
