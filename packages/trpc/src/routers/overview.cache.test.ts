import { describe, expect, it } from 'vitest';
import {
  PREVIOUS_PERIOD_TTL,
  REALTIME_RANGES,
  previousPeriodCacheKey,
} from './overview.cache';

// The resolved previous-window bounds a stats sub-call would be keyed on.
const base = {
  projectId: 'daily-mail',
  range: '30d',
  interval: 'day',
  filters: [],
  timezone: 'Europe/Stockholm',
  startDate: '2026-04-24 00:00:00',
  endDate: '2026-05-24 00:00:00',
};

describe('previousPeriodCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(previousPeriodCacheKey('metrics', base)).toBe(
      previousPeriodCacheKey('metrics', base),
    );
  });

  it('changes when the resolved previous-window bounds advance (day-boundary rollover)', () => {
    // Same 30d range, but a day later: getChartPrevStartEndDate yields a window
    // shifted by one day. Keying on resolved bounds (not the "30d" string) MUST
    // miss the prior day's entry instead of serving a stale previous period.
    const nextDay = {
      ...base,
      startDate: '2026-04-25 00:00:00',
      endDate: '2026-05-25 00:00:00',
    };
    expect(previousPeriodCacheKey('metrics', nextDay)).not.toBe(
      previousPeriodCacheKey('metrics', base),
    );
  });

  it('separates metric fns that share an identical previousInput', () => {
    // getMetrics / getEventMetrics / getMultiGameSessions are called with the
    // same previousInput but return different shapes — the label must split them.
    expect(previousPeriodCacheKey('metrics', base)).not.toBe(
      previousPeriodCacheKey('eventMetrics', base),
    );
    expect(previousPeriodCacheKey('eventMetrics', base)).not.toBe(
      previousPeriodCacheKey('multiGameSessions', base),
    );
  });

  it('changes when interval or filters differ', () => {
    expect(previousPeriodCacheKey('metrics', { ...base, interval: 'hour' })).not.toBe(
      previousPeriodCacheKey('metrics', base),
    );
    expect(
      previousPeriodCacheKey('metrics', {
        ...base,
        filters: [{ name: 'country', operator: 'is', value: ['SE'] }],
      }),
    ).not.toBe(previousPeriodCacheKey('metrics', base));
  });

  it('is namespaced and redis-safe (no raw double quotes)', () => {
    const key = previousPeriodCacheKey('metrics', base);
    expect(key.startsWith('trpc:overview.prev:metrics:')).toBe(true);
    expect(key).not.toContain('"');
  });
});

describe('REALTIME_RANGES', () => {
  it('excludes exactly the four moving-window ranges from the long TTL', () => {
    expect([...REALTIME_RANGES].sort()).toEqual([
      '30min',
      'last24h',
      'lastHour',
      'today',
    ]);
  });

  it('does not exclude non-realtime ranges like 30d', () => {
    expect(REALTIME_RANGES.has('30d')).toBe(false);
  });
});

describe('PREVIOUS_PERIOD_TTL', () => {
  it('is at least one hour per the issue acceptance criteria', () => {
    expect(PREVIOUS_PERIOD_TTL).toBeGreaterThanOrEqual(60 * 60);
  });
});
