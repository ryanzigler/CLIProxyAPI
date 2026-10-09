/**
 * Provider summary strip: one card per provider with the headline window's
 * summed remaining capacity, a segment per credential, the soonest reset, and
 * the other windows' sums behind a Show toggle.
 *
 * Sums are account-equivalent capacity ("409% of 500%" = about four accounts'
 * worth left), not a token budget: plan tiers have different absolute limits.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ProviderSummary, ProviderSummaryLine } from '../quotaWindows';
import { formatLedgerReset, formatWindowLabel, meterLevel } from './ledgerFormat';
import styles from './ProviderSummaryCards.module.scss';

const LEVEL_CLASS = {
  high: styles.segmentHigh,
  medium: styles.segmentMedium,
  low: styles.segmentLow,
  unknown: '',
} as const;

export type ProviderSummaryCardsProps = {
  summaries: ProviderSummary[];
  resolvedTheme: ResolvedTheme;
};

export function ProviderSummaryCards({ summaries, resolvedTheme }: ProviderSummaryCardsProps) {
  if (summaries.length === 0) return null;
  return (
    <section className={styles.strip}>
      {summaries.map((summary) => (
        <SummaryCard key={summary.provider} summary={summary} resolvedTheme={resolvedTheme} />
      ))}
    </section>
  );
}

function SummaryCard({
  summary,
  resolvedTheme,
}: {
  summary: ProviderSummary;
  resolvedTheme: ResolvedTheme;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const { provider, credentialCount, headline, secondary } = summary;
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const typeLabel = getTypeLabel(t, provider);
  const reset = headline
    ? formatLedgerReset(headline.soonestResetMs, null, now, i18n.resolvedLanguage)
    : null;
  const visibleSecondary = expanded ? secondary : secondary.slice(0, 1);

  return (
    <article className={styles.card}>
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.name}>{typeLabel}</span>
        <span className={styles.count}>
          {t('quota_management.summary_credentials', { count: credentialCount })}
        </span>
      </header>

      <div className={styles.windowLabel}>
        {headline ? formatWindowLabel(t, headline.sample) : t('quota_management.summary_no_data')}
      </div>
      <div className={styles.figure}>
        <span className={styles.figureValue}>
          {headline && headline.known > 0 ? `${headline.sum}%` : '--'}
        </span>
        <span className={styles.figureOf}>
          {t('quota_management.summary_of', { total: `${credentialCount * 100}%` })}
        </span>
      </div>
      <Segments line={headline} count={credentialCount} />
      <div className={styles.reset}>
        {reset ? (
          <>
            {reset.relative && <span className={styles.resetRelative}>{reset.relative}</span>}
            <span>{reset.absolute}</span>
          </>
        ) : (
          <span>{t('quota_management.no_reset_pending')}</span>
        )}
      </div>

      {secondary.length > 0 && (
        <footer className={styles.footer}>
          <div className={styles.secondaryList}>
            {visibleSecondary.map((line) => (
              <div key={line.key} className={styles.secondary}>
                <span>{formatWindowLabel(t, line.sample)}</span>
                <span className={styles.secondaryValue}>
                  {line.known > 0 ? `${line.sum}%` : '--'}
                </span>
              </div>
            ))}
          </div>
          {secondary.length > 1 && (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('quota_management.summary_hide') : t('quota_management.summary_show')}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function Segments({ line, count }: { line: ProviderSummaryLine | null; count: number }) {
  const segments = line?.segments ?? Array.from({ length: count }, () => null);
  return (
    <div className={styles.segments} aria-hidden="true">
      {segments.map((value, index) => (
        <span key={index} className={styles.segment}>
          <span
            className={`${styles.segmentFill} ${LEVEL_CLASS[meterLevel(value)]}`}
            style={{ width: `${value ?? 0}%` }}
          />
        </span>
      ))}
    </div>
  );
}
