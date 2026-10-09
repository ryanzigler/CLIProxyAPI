/**
 * Provider-agnostic quota windows for the ledger view and provider summaries.
 *
 * The timeline model reads each provider's shape structurally because it only
 * needs one anchor per lane. The ledger needs every comparable window with its
 * reset instant, so this flattens each provider into the same row shape and
 * classifies it as a session, shared weekly, or model-scoped weekly window.
 */

import type { QuotaProviderType } from './providers/types';

export type QuotaWindowKind = 'session' | 'weekly' | 'model';

export interface LedgerWindow {
  id: string;
  kind: QuotaWindowKind;
  /** Pre-translated label, used when no labelKey exists. */
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Percent remaining, 0–100; null when the provider reported no usable figure. */
  remaining: number | null;
  /** Provider-baked absolute reset label, if any. */
  resetLabel?: string | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** Windows of at most a day count as session windows (5-hour, Devin daily). */
const SESSION_MAX_HOURS = 24;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - value);
};

const kindForPeriod = (periodHours: number | null): QuotaWindowKind =>
  periodHours !== null && periodHours <= SESSION_MAX_HOURS ? 'session' : 'weekly';

interface UsedWindowLike {
  id: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetLabel?: string;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const CLAUDE_KINDS: Record<string, QuotaWindowKind> = {
  'five-hour': 'session',
  'seven-day': 'weekly',
  'seven-day-opus': 'model',
  'seven-day-sonnet': 'model',
  'seven-day-fable': 'model',
};

const classifyCodexWindow = (window: UsedWindowLike): QuotaWindowKind | null => {
  if (window.id.startsWith('code-review-')) return null;
  if (window.id === 'five-hour') return 'session';
  if (window.id === 'weekly' || window.id === 'monthly') return 'weekly';
  // Model-scoped limits (for example GPT-5.3-Codex-Spark): only their weekly
  // half competes with the account window; the 5-hour half adds noise.
  const periodHours = finiteOrNull(window.periodHours);
  return periodHours !== null && periodHours <= SESSION_MAX_HOURS ? null : 'model';
};

const fromUsedWindow = (window: UsedWindowLike, kind: QuotaWindowKind): LedgerWindow => ({
  id: window.id,
  kind,
  label: window.label ?? window.id,
  labelKey: window.labelKey,
  labelParams: window.labelParams,
  remaining: remainingFromUsed(window.usedPercent),
  resetLabel: window.resetLabel ?? null,
  resetAtMs: finiteOrNull(window.resetAtMs),
  periodHours: finiteOrNull(window.periodHours),
});

/**
 * Flatten one credential's loaded quota into ledger windows.
 * Returns an empty list for anything not successfully loaded.
 */
export function toQuotaWindows(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined
): LedgerWindow[] {
  if (!quota || quota.status !== 'success') return [];

  if (provider === 'claude') {
    const windows = (quota as { windows?: UsedWindowLike[] }).windows ?? [];
    return windows.flatMap((window) => {
      const kind = CLAUDE_KINDS[window.id];
      return kind ? [fromUsedWindow(window, kind)] : [];
    });
  }

  if (provider === 'codex') {
    const windows = (quota as { windows?: UsedWindowLike[] }).windows ?? [];
    return windows.flatMap((window) => {
      const kind = classifyCodexWindow(window);
      return kind ? [fromUsedWindow(window, kind)] : [];
    });
  }

  if (provider === 'devin') {
    const windows =
      (
        quota as {
          windows?: {
            id: string;
            label?: string;
            remainingPercent: number | null;
            resetAtMs: number | null;
            periodHours: number;
          }[];
        }
      ).windows ?? [];
    return windows.map((window) => ({
      id: window.id,
      kind: kindForPeriod(finiteOrNull(window.periodHours)),
      label: window.label ?? window.id,
      labelKey: `devin_quota.${window.id}`,
      remaining:
        finiteOrNull(window.remainingPercent) === null
          ? null
          : clampPercent(window.remainingPercent as number),
      resetAtMs: finiteOrNull(window.resetAtMs),
      periodHours: finiteOrNull(window.periodHours),
    }));
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          periodType?: string;
          usagePercent?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
        } | null;
      }
    ).billing;
    // Only the weekly figure is a quota window; monthly is a billing cycle.
    if (!billing || billing.periodType !== 'weekly') return [];
    return [
      {
        id: 'weekly',
        kind: 'weekly',
        label: 'Weekly limit',
        labelKey: 'quota_management.ledger_weekly_limit',
        remaining: remainingFromUsed(billing.usagePercent),
        resetAtMs: finiteOrNull(billing.resetAtMs),
        periodHours: finiteOrNull(billing.periodHours) ?? 24 * 7,
      },
    ];
  }

  if (provider === 'antigravity') {
    const buckets = (
      (
        quota as {
          groups?: {
            buckets?: {
              id: string;
              label?: string;
              remainingFraction?: number | null;
              resetAtMs?: number | null;
              periodHours?: number | null;
            }[];
          }[];
        }
      ).groups ?? []
    ).flatMap((group) => group.buckets ?? []);
    return buckets.map((bucket) => {
      const periodHours = finiteOrNull(bucket.periodHours);
      const fraction = finiteOrNull(bucket.remainingFraction);
      return {
        id: bucket.id,
        // Antigravity buckets are per model; the period decides the column.
        kind: kindForPeriod(periodHours),
        label: bucket.label ?? bucket.id,
        remaining: fraction === null ? null : clampPercent(Math.round(fraction * 100)),
        resetAtMs: finiteOrNull(bucket.resetAtMs),
        periodHours,
      };
    });
  }

  if (provider === 'kimi') {
    const rows =
      (
        quota as {
          rows?: {
            id?: string;
            label?: string;
            labelKey?: string;
            labelParams?: Record<string, string | number>;
            used: number;
            limit: number;
            resetAtMs?: number | null;
            periodHours?: number | null;
          }[];
        }
      ).rows ?? [];
    return rows.map((row, index) => {
      const periodHours = finiteOrNull(row.periodHours);
      return {
        id: row.id ?? `kimi-${index}`,
        kind: kindForPeriod(periodHours),
        label: row.label ?? '',
        labelKey: row.labelKey,
        labelParams: row.labelParams,
        remaining:
          row.limit > 0
            ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100))
            : null,
        resetAtMs: finiteOrNull(row.resetAtMs),
        periodHours,
      };
    });
  }

  if (provider === 'meta') {
    const windows =
      (
        quota as {
          data?: {
            windows?: {
              id: 'window' | 'weekly';
              usedPercent: number | null;
              resetAt?: number;
              durationMinutes?: number;
            }[];
          };
        }
      ).data?.windows ?? [];
    return windows.map((window) => {
      const periodHours =
        window.id === 'weekly'
          ? 24 * 7
          : finiteOrNull(window.durationMinutes) === null
            ? null
            : (window.durationMinutes as number) / 60;
      const resetAt = finiteOrNull(window.resetAt);
      return {
        id: window.id,
        kind: window.id === 'weekly' ? 'weekly' : kindForPeriod(periodHours),
        label: window.id,
        labelKey: `meta_quota.${window.id}`,
        remaining: remainingFromUsed(window.usedPercent),
        resetAtMs: resetAt === null ? null : resetAt * 1000,
        periodHours,
      };
    });
  }

  return [];
}

/** Stable grouping key: two windows with the same key are the same limit on different accounts. */
export const windowKey = (window: Pick<LedgerWindow, 'kind' | 'id' | 'labelKey' | 'label'>) =>
  window.kind === 'model' ? `model:${window.labelKey ?? ''}:${window.label}` : window.kind;

/** Column order in a ledger row: model-scoped weekly, session, then shared weekly. */
const KIND_ORDER: readonly QuotaWindowKind[] = ['model', 'session', 'weekly'];

/**
 * Pick the windows a ledger row shows, one per kind. For the model column the
 * provider's headline model wins so every row in a section lines up.
 */
export function pickLedgerColumns(
  windows: readonly LedgerWindow[],
  headlineModelKey: string | null
): LedgerWindow[] {
  return KIND_ORDER.flatMap((kind) => {
    const candidates = windows.filter((window) => window.kind === kind);
    if (candidates.length === 0) return [];
    if (kind === 'model' && headlineModelKey) {
      const match = candidates.find((window) => windowKey(window) === headlineModelKey);
      return [match ?? candidates[0]];
    }
    return [candidates[0]];
  });
}

export interface ProviderSummaryLine {
  key: string;
  /** A representative window, for its label. */
  sample: LedgerWindow;
  /** Sum of remaining percentages across accounts that reported this window. */
  sum: number;
  /** Accounts that reported a usable figure; the denominator is 100 × this. */
  known: number;
  /** One entry per account in input order; null when that account lacks the window. */
  segments: (number | null)[];
  /** Earliest future reset among accounts, or null. */
  soonestResetMs: number | null;
}

export interface ProviderSummary {
  provider: QuotaProviderType;
  credentialCount: number;
  headline: ProviderSummaryLine | null;
  secondary: ProviderSummaryLine[];
}

const summarizeKey = (
  key: string,
  accounts: readonly LedgerWindow[][],
  nowMs: number
): ProviderSummaryLine | null => {
  let sample: LedgerWindow | null = null;
  let sum = 0;
  let known = 0;
  let soonestResetMs: number | null = null;
  const segments = accounts.map((windows) => {
    const window = windows.find((candidate) => windowKey(candidate) === key);
    if (!window) return null;
    sample ??= window;
    if (window.resetAtMs !== null && window.resetAtMs > nowMs) {
      soonestResetMs =
        soonestResetMs === null ? window.resetAtMs : Math.min(soonestResetMs, window.resetAtMs);
    }
    if (window.remaining === null) return null;
    sum += window.remaining;
    known += 1;
    return window.remaining;
  });
  if (!sample) return null;
  return { key, sample, sum: Math.round(sum), known, segments, soonestResetMs };
};

/**
 * Most-reported model window wins the headline; ties keep first-seen order.
 * Without a model window the shared weekly leads, then the session window.
 */
export function pickHeadlineKey(accounts: readonly LedgerWindow[][]): string | null {
  const modelCounts = new Map<string, number>();
  accounts.forEach((windows) => {
    new Set(
      windows
        .filter((window) => window.kind === 'model' && window.remaining !== null)
        .map(windowKey)
    ).forEach((key) => modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1));
  });
  let best: string | null = null;
  modelCounts.forEach((count, key) => {
    if (best === null || count > (modelCounts.get(best) ?? 0)) best = key;
  });
  if (best) return best;
  const hasKind = (kind: QuotaWindowKind) =>
    accounts.some((windows) => windows.some((window) => window.kind === kind));
  if (hasKind('weekly')) return 'weekly';
  if (hasKind('session')) return 'session';
  return null;
}

/** Summarize one provider's accounts. `accounts` holds every credential, loaded or not. */
export function summarizeProvider(
  provider: QuotaProviderType,
  accounts: readonly LedgerWindow[][],
  nowMs: number
): ProviderSummary {
  const headlineKey = pickHeadlineKey(accounts);
  const headline = headlineKey ? summarizeKey(headlineKey, accounts, nowMs) : null;
  const secondary = (['weekly', 'session'] as const)
    .filter((key) => key !== headlineKey)
    .map((key) => summarizeKey(key, accounts, nowMs))
    .filter((line): line is ProviderSummaryLine => line !== null);
  return { provider, credentialCount: accounts.length, headline, secondary };
}
