import type { TFunction } from 'i18next';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import type { LedgerWindow } from '../quotaWindows';

export const formatWindowLabel = (t: TFunction, window: LedgerWindow): string =>
  window.labelKey ? t(window.labelKey, window.labelParams) : window.label;

export const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${Math.round(value)}%`;

/**
 * `in 1 day · 09/12, 23:00` — countdown first, the way the ledger reads.
 * Falls back to the provider's baked label, then to null.
 */
export function formatLedgerReset(
  resetAtMs: number | null,
  resetLabel: string | null | undefined,
  nowMs: number,
  locale?: string
): { relative: string | null; absolute: string } | null {
  if (resetAtMs !== null && resetAtMs > nowMs) {
    return {
      relative: formatRelativeInstant(resetAtMs, nowMs, locale),
      absolute: formatInstantShort(resetAtMs),
    };
  }
  const label = resetLabel?.trim();
  return label && label !== '-' ? { relative: null, absolute: label } : null;
}

export type MeterLevel = 'high' | 'medium' | 'low' | 'unknown';

export const meterLevel = (percent: number | null): MeterLevel =>
  percent === null
    ? 'unknown'
    : percent >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? 'high'
      : percent >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? 'medium'
        : 'low';
