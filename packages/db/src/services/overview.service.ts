import { average, sum } from '@openpanel/common';
import { chartColors } from '@openpanel/constants';
import { type IChartEventFilter, zTimeInterval } from '@openpanel/validation';
import sqlstring from 'sqlstring';
import { z } from 'zod';
import {
  ch,
  convertClickhouseDateToJs,
  isClickhouseDefaultMinDate,
  TABLE_NAMES,
} from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import {
  getEventFiltersWhereClause,
  getSelectPropertyKey,
} from './chart.service';

// Constants
const ROLLUP_DATE_PREFIX = '1970-01-01';

// Toggle revenue tracking in overview queries
const INCLUDE_REVENUE = true; // TODO: Make this configurable later

// Maximum number of records to return (for detail modals)
const MAX_RECORDS_LIMIT = 1000;

// Cohort-retention look-back: how far before endDate getCohortRetention scans for
// first-visit cohorts, decoupled from the display window so each shown cohort's
// full week-0 denominator is counted, but bounded so the scan never walks full
// project history on large projects.
const DAY_MS = 24 * 60 * 60 * 1000;
const COHORT_LOOKBACK_DAYS = 180;

const COLUMN_PREFIX_MAP: Record<string, string> = {
  region: 'country',
  city: 'country',
  browser_version: 'browser',
  os_version: 'os',
};

const WHITELISTED_FILTERS = [
  'os',
  'path',
  'city',
  'brand',
  'model',
  'origin',
  'region',
  'device',
  'revenue',
  'country',
  'browser',
  'referrer',
  'os_version',
  'referrer_name',
  'browser_version',
  'referrer_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  // fork: allow overview widgets to be filtered by game. Property filters are
  // otherwise dropped here; this routes properties.game_id through
  // getEventFiltersWhereClause's properties.* path -> properties['game_id'].
  'properties.game_id',
];

// Columns that exist on the sessions table but not on events — on events
// they're stored inside the properties map under __query.utm_*.
const UTM_COLUMNS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];

// Types
type MetricsRow = {
  bounce_rate: number;
  unique_visitors: number;
  total_sessions: number;
  avg_session_duration: number;
  total_screen_views: number;
  views_per_session: number;
};

type MetricsSeriesRow = MetricsRow & { date: string; total_revenue: number };

export const zGetMetricsInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  interval: zTimeInterval,
});

export type IGetMetricsInput = z.infer<typeof zGetMetricsInput> & {
  timezone: string;
};

export const zGetTopPagesInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  limit: z.number().min(1).max(1000).optional(),
});

export type IGetTopPagesInput = z.infer<typeof zGetTopPagesInput> & {
  timezone: string;
};

export const zGetTopEntryExitInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  mode: z.enum(['entry', 'exit']),
  limit: z.number().min(1).max(1000).optional(),
});

export type IGetTopEntryExitInput = z.infer<typeof zGetTopEntryExitInput> & {
  timezone: string;
};

export const zGetTopGenericInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  column: z.enum([
    // Referrers
    'referrer',
    'referrer_name',
    'referrer_type',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    // Geo
    'region',
    'country',
    'city',
    // Device
    'device',
    'brand',
    'model',
    'browser',
    'browser_version',
    'os',
    'os_version',
  ]),
});

export type IGetTopGenericInput = z.infer<typeof zGetTopGenericInput> & {
  timezone: string;
};

export const zGetTopGenericSeriesInput = zGetTopGenericInput.extend({
  interval: zTimeInterval,
});

export type IGetTopGenericSeriesInput = z.infer<
  typeof zGetTopGenericSeriesInput
> & {
  timezone: string;
};

export const zGetUserJourneyInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  steps: z.number().min(2).max(10).default(5),
});

export type IGetUserJourneyInput = z.infer<typeof zGetUserJourneyInput> & {
  timezone: string;
};

export const zGetTopEventsInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
  excludeEvents: z.array(z.string()).optional(),
});

export type IGetTopEventsInput = z.infer<typeof zGetTopEventsInput> & {
  timezone: string;
};

export const zGetTopLinkOutInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
});

export type IGetTopLinkOutInput = z.infer<typeof zGetTopLinkOutInput> & {
  timezone: string;
};

export const zGetMapDataInput = z.object({
  projectId: z.string(),
  filters: z.array(z.any()),
  startDate: z.string(),
  endDate: z.string(),
});

export type IGetMapDataInput = z.infer<typeof zGetMapDataInput> & {
  timezone: string;
};

export class OverviewService {
  constructor(private client: typeof ch) {}

  private getFillConfig(interval: string, startDate: string, endDate: string) {
    const useDateOnly = ['month', 'week'].includes(interval);
    return {
      from: clix.toStartOf(
        clix.datetime(startDate, useDateOnly ? 'toDate' : 'toDateTime'),
        interval as any
      ),
      to: clix.datetime(endDate, useDateOnly ? 'toDate' : 'toDateTime'),
      step: clix.toInterval('1', interval as any),
    };
  }

  private createRevenueQuery({
    projectId,
    startDate,
    endDate,
    interval,
    timezone,
    filters,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    interval: string;
    timezone: string;
    filters: IChartEventFilter[];
  }) {
    return clix(this.client, timezone)
      .select<{ date: string; total_revenue: number }>([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        'sum(revenue) AS total_revenue',
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'revenue')
      .where('revenue', '>', 0)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['date'])
      .rollup()
      .transform({
        date: (item) => convertClickhouseDateToJs(item.date).toISOString(),
      });
  }

  private mergeRevenueIntoSeries<T extends { date: string }>(
    series: T[],
    revenueData: { date: string; total_revenue: number }[]
  ): (T & { total_revenue: number })[] {
    const revenueByDate = new Map(
      revenueData
        .filter((r) => !isClickhouseDefaultMinDate(r.date))
        .map((r) => [r.date, r.total_revenue])
    );
    return series.map((row) => ({
      ...row,
      total_revenue: revenueByDate.get(row.date) ?? 0,
    }));
  }

  private getOverallRevenue(
    revenueData: { date: string; total_revenue: number }[]
  ): number {
    return (
      revenueData.find((r) => isClickhouseDefaultMinDate(r.date))
        ?.total_revenue ?? 0
    );
  }

  private withDistinctSessionsIfNeeded<T>(
    query: ReturnType<typeof clix>,
    params: {
      filters: IChartEventFilter[];
      projectId: string;
      startDate: string;
      endDate: string;
      timezone: string;
    }
  ): ReturnType<typeof clix> {
    if (!this.isPageFilter(params.filters)) {
      query.rawWhere(this.getRawWhereClause('sessions', params.filters));
      return query;
    }

    return clix(this.client, params.timezone)
      .with('distinct_sessions', this.getDistinctSessions(params))
      .merge(query)
      .where(
        'id',
        'IN',
        clix.exp('(SELECT session_id FROM distinct_sessions)')
      );
  }

  isPageFilter(filters: IChartEventFilter[]) {
    return filters.some((filter) => filter.name === 'path' && filter.value);
  }

  async getMetrics({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: {
      bounce_rate: number;
      unique_visitors: number;
      total_sessions: number;
      avg_session_duration: number;
      total_screen_views: number;
      views_per_session: number;
      total_revenue: number;
    };
    series: {
      date: string;
      bounce_rate: number;
      unique_visitors: number;
      total_sessions: number;
      avg_session_duration: number;
      total_screen_views: number;
      views_per_session: number;
      total_revenue: number;
    }[];
  }> {
    return this.isPageFilter(filters)
      ? this.getMetricsWithPageFilter({
          projectId,
          filters,
          startDate,
          endDate,
          interval,
          timezone,
        })
      : this.getMetricsFromSessions({
          projectId,
          filters,
          startDate,
          endDate,
          interval,
          timezone,
        });
  }

  private async getMetricsFromSessions({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: MetricsRow & { total_revenue: number };
    series: MetricsSeriesRow[];
  }> {
    const where = this.getRawWhereClause('sessions', filters);
    const fillConfig = this.getFillConfig(interval, startDate, endDate);

    // Session metrics query
    const sessionQuery = clix(this.client, timezone)
      .select<{
        date: string;
        bounce_rate: number;
        unique_visitors: number;
        total_sessions: number;
        avg_session_duration: number;
        total_screen_views: number;
        views_per_session: number;
      }>([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        'round(sum(sign * is_bounce) * 100.0 / sum(sign), 2) as bounce_rate',
        'uniqIf(profile_id, sign > 0) AS unique_visitors',
        'sum(sign) AS total_sessions',
        'round(avgIf(duration, duration > 0 AND sign > 0), 2) / 1000 AS _avg_session_duration',
        'if(isNaN(_avg_session_duration), 0, _avg_session_duration) AS avg_session_duration',
        'sum(sign * screen_view_count) AS total_screen_views',
        'round(sum(sign * screen_view_count) * 1.0 / sum(sign), 2) AS views_per_session',
      ])
      .from('sessions')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .where('project_id', '=', projectId)
      .rawWhere(where)
      .groupBy(['date'])
      .having('sum(sign)', '>', 0)
      .rollup()
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => new Date(item.date).toISOString(),
      });

    // Revenue query
    const revenueQuery = this.createRevenueQuery({
      projectId,
      startDate,
      endDate,
      interval,
      timezone,
      filters,
    });

    // Execute both queries in parallel and merge results
    const [sessionRes, revenueRes] = await Promise.all([
      sessionQuery.execute(),
      revenueQuery.execute(),
    ]);

    const overallRevenue = this.getOverallRevenue(revenueRes);
    const series = this.mergeRevenueIntoSeries(sessionRes.slice(1), revenueRes);

    return {
      metrics: {
        bounce_rate: sessionRes[0]?.bounce_rate ?? 0,
        unique_visitors: sessionRes[0]?.unique_visitors ?? 0,
        total_sessions: sessionRes[0]?.total_sessions ?? 0,
        avg_session_duration: sessionRes[0]?.avg_session_duration ?? 0,
        total_screen_views: sessionRes[0]?.total_screen_views ?? 0,
        views_per_session: sessionRes[0]?.views_per_session ?? 0,
        total_revenue: overallRevenue,
      },
      series,
    };
  }

  // Combined event-derived metrics (avg_dau series, returning_rate,
  // level_completion) computed in a SINGLE scan over the events table, instead
  // of three separate series+headline query pairs. All three share the same
  // date-grain GROUP BY and differ only by `name` filter, so they fold into one
  // scan using conditional aggregation. returning_rate and level_completion are
  // window-wide ratios, so WITH ROLLUP yields their headline exactly as the
  // totals row (the same trick getMetricsFromSessions uses). avg_dau's headline
  // is an average of daily DAU — a grain a rollup cannot express — so it keeps
  // a dedicated day-granularity query, computed at day grain regardless of the
  // selected interval. Puzzlr-specific: relies on the session_start /
  // session_started / level_started / level_completed events and the
  // days_since_first_visit property.
  async getEventMetrics({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: {
      avg_dau: number;
      returning_rate: number;
      level_completion: number;
    };
    series: {
      date: string;
      avg_dau: number;
      returning_rate: number;
      level_completion: number;
    }[];
  }> {
    const fillConfig = this.getFillConfig(interval, startDate, endDate);

    // Denominator/numerator are scoped per-metric via `name` so the broader
    // multi-name scan produces identical values to the old per-metric queries.
    const returningRateExpr =
      "round(countIf(name = 'session_started' AND toUInt32OrZero(properties['days_since_first_visit']) > 0) * 100.0 / nullIf(countIf(name = 'session_started'), 0), 1) AS returning_rate";
    const levelCompletionExpr =
      "round(countIf(name = 'level_completed') * 100.0 / nullIf(countIf(name = 'level_started'), 0), 1) AS level_completion";

    const combinedQuery = clix(this.client, timezone)
      .select<{
        date: string;
        avg_dau: number;
        returning_rate: number;
        level_completion: number;
      }>([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        "uniqIf(device_id, name = 'session_start') AS avg_dau",
        returningRateExpr,
        levelCompletionExpr,
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', 'IN', [
        'session_start',
        'session_started',
        'level_started',
        'level_completed',
      ])
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['date'])
      .rollup()
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => convertClickhouseDateToJs(item.date).toISOString(),
      });

    const dailyDauCte = clix(this.client, timezone)
      .select<{ day: string; dau: number }>([
        'toDate(created_at) AS day',
        'uniq(device_id) AS dau',
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'session_start')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['day']);

    const avgDauHeadlineQuery = clix(this.client, timezone)
      .with('daily_dau', dailyDauCte)
      .select<{ avg_dau: number }>(['round(avg(dau)) AS avg_dau'])
      .from('daily_dau');

    const [combinedRes, avgDauHeadlineRes] = await Promise.all([
      combinedQuery.execute(),
      avgDauHeadlineQuery.execute(),
    ]);

    // WITH ROLLUP appends a totals row whose date defaults to the epoch, so
    // ORDER BY date ASC sorts it first; the remaining rows are the FILL'd
    // series (identical pattern to getMetricsFromSessions).
    const headline = combinedRes[0];
    const series = combinedRes.slice(1);

    return {
      metrics: {
        avg_dau: avgDauHeadlineRes[0]?.avg_dau ?? 0,
        returning_rate: headline?.returning_rate ?? 0,
        level_completion: headline?.level_completion ?? 0,
      },
      series: series.map((row) => ({
        date: row.date,
        avg_dau: row.avg_dau ?? 0,
        returning_rate: row.returning_rate ?? 0,
        level_completion: row.level_completion ?? 0,
      })),
    };
  }

  // Multi-game sessions: % of sessions (with at least one level_started in the
  // window) that played 2+ distinct games. Puzzlr-specific — relies on the
  // `level_started` event and `game_id` property emitted by Puzzlr SDKs.
  // Headline is a period-wide ratio; series is a per-bucket ratio mirroring
  // the headline at the user's selected interval.
  async getMultiGameSessions({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: { multi_game_sessions: number };
    series: { date: string; multi_game_sessions: number }[];
  }> {
    const fillConfig = this.getFillConfig(interval, startDate, endDate);

    // Per (bucket, session) distinct game counts in a single scan. The
    // bucket-level ratio is the series; WITH ROLLUP yields the period headline
    // as the totals row, dropping what used to be a second session-grain scan
    // of the same level_started events. A session straddling a bucket boundary
    // is counted in each bucket it touches (~0.2% of sessions), so the rollup
    // headline can differ from a strict per-session figure by ~0.1pp — an
    // accepted trade-off for halving this metric's (game_id-Map) scan cost.
    const bucketedCte = clix(this.client, timezone)
      .select<{ bucket: string; session_id: string; games: number }>([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS bucket`,
        'session_id',
        "uniqExact(properties['game_id']) AS games",
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'level_started')
      .where('session_id', '!=', '')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['bucket', 'session_id']);

    const combinedQuery = clix(this.client, timezone)
      .with('bucketed', bucketedCte)
      .select<{ date: string; multi_game_sessions: number }>([
        'bucket AS date',
        'round(countIf(games >= 2) * 100.0 / nullIf(count(), 0), 1) AS multi_game_sessions',
      ])
      .from('bucketed')
      .groupBy(['bucket'])
      .rollup()
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => convertClickhouseDateToJs(item.date).toISOString(),
      });

    const res = await combinedQuery.execute();

    // WITH ROLLUP appends a totals row whose bucket defaults to the epoch, so
    // ORDER BY date ASC sorts it first; the rest are the FILL'd series.
    const headline = res[0];
    const series = res.slice(1);

    return {
      metrics: {
        multi_game_sessions: headline?.multi_game_sessions ?? 0,
      },
      series: series.map((row) => ({
        date: row.date,
        multi_game_sessions: row.multi_game_sessions ?? 0,
      })),
    };
  }

  // Tenure composition over time (the "tenure river"). Sessions per interval
  // split by visitor age, derived purely from days_since_first_visit. Single
  // GROUP BY scan over session_started, mirroring the returning_rate metric.
  // Puzzlr-specific (relies on the session_started event + its dsfv property).
  // A stock signal with no denominator, so it cannot manufacture a >100% spike.
  async getTenureSeries({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<
    {
      date: string;
      bucket_new: number;
      bucket_1_7: number;
      bucket_8_30: number;
      bucket_30: number;
    }[]
  > {
    const fillConfig = this.getFillConfig(interval, startDate, endDate);
    const dsfv = "toUInt32OrZero(properties['days_since_first_visit'])";

    const query = clix(this.client, timezone)
      .select<{
        date: string;
        bucket_new: number;
        bucket_1_7: number;
        bucket_8_30: number;
        bucket_30: number;
      }>([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        `countIf(${dsfv} = 0) AS bucket_new`,
        `countIf(${dsfv} >= 1 AND ${dsfv} <= 7) AS bucket_1_7`,
        `countIf(${dsfv} >= 8 AND ${dsfv} <= 30) AS bucket_8_30`,
        `countIf(${dsfv} > 30) AS bucket_30`,
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'session_started')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['date'])
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => convertClickhouseDateToJs(item.date).toISOString(),
      });

    const res = await query.execute();
    return res.map((row) => ({
      date: row.date,
      bucket_new: row.bucket_new ?? 0,
      bucket_1_7: row.bucket_1_7 ?? 0,
      bucket_8_30: row.bucket_8_30 ?? 0,
      bucket_30: row.bucket_30 ?? 0,
    }));
  }

  // Cohort activity retention from days_since_first_visit alone. Puzzlr-specific.
  // cohort_week = first-visit week = created_at - days_since_first_visit.
  // life_week   = days_since_first_visit / 7 (weeks since first visit).
  // Returns flat (cohort_week, life_week, sessions) rows; the client pivots into
  // a curve. No self-join, no cross-day identity — one scan over session_started.
  //
  // Cohort history is DECOUPLED from the display window to keep the picture
  // honest, while staying bounded for production-wide use:
  //   • The lower `created_at` bound is a fixed, generous look-back
  //     (COHORT_LOOKBACK_DAYS) rather than the display window — so each shown
  //     cohort's full week-0 (first 7 days) and life-weeks are counted, not just
  //     the slice inside the range. A windowed lower bound left-censors the
  //     denominator and manufactures >100% retention (e.g. a cohort whose true
  //     week-0 of 154 gets clipped to 34 → a fake 250%). Decoupling it from the
  //     display window but still bounding it keeps the scan from walking full
  //     project history on every uncached load. Decoupling does NOT remove the
  //     seam, only move it to lookbackStart — the HAVING below censors the one
  //     cohort still straddling that bound (see LEFT guard).
  //   • The HAVING censors BOTH boundaries so every point has a complete
  //     numerator and denominator: a LEFT guard (cohort_week >= lookbackStart)
  //     drops the straddling cohort whose week-0 would be truncated, and a RIGHT
  //     guard drops not-yet-elapsed life-weeks (recent cohorts show fewer points
  //     instead of a fake instant-churn cliff). dsfv already encodes age, one scan.
  // Tiny launch-era / instrumentation-seam cohorts (and their >100% noise) are
  // filtered client-side by a min-denominator threshold in pivotCohorts.
  async getCohortRetention({
    projectId,
    filters,
    endDate,
    timezone,
  }: IGetMetricsInput): Promise<
    { cohort_week: string; life_week: number; sessions: number }[]
  > {
    const dsfv = "toUInt32OrZero(properties['days_since_first_visit'])";
    const cohortWeek = `toStartOfWeek(subtractDays(toDate(created_at), ${dsfv}))`;
    const lifeWeek = `intDiv(${dsfv}, 7)`;

    // Generous fixed look-back, decoupled from the display window: long enough to
    // mature the deepest life-week the client plots (weekly cohorts at week ≤4
    // need ~5 weeks), short enough to bound the scan on large projects.
    const lookbackStart = new Date(
      new Date(endDate).getTime() - COHORT_LOOKBACK_DAYS * DAY_MS,
    );

    const query = clix(this.client, timezone)
      .select<{ cohort_week: string; life_week: number; sessions: number }>([
        `${cohortWeek} AS cohort_week`,
        `${lifeWeek} AS life_week`,
        'count() AS sessions',
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'session_started')
      .where('created_at', '>=', clix.datetime(lookbackStart, 'toDateTime'))
      .where('created_at', '<=', clix.datetime(endDate, 'toDateTime'))
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['cohort_week', 'life_week'])
      // Censor BOTH boundaries so every plotted retention point has a complete
      // numerator and denominator:
      //  • LEFT — drop the cohort straddling lookbackStart. The lower bound is on
      //    `created_at` (session date), so that cohort's week-0 denominator is
      //    truncated (its earliest week-0 sessions fall before lookbackStart) while
      //    its later-week numerators are fully counted → inflated retention at F's
      //    left-most point, biasing the trend verdict toward "Worsening". Requiring
      //    cohort_week >= lookbackStart keeps only cohorts whose first-visit week
      //    starts in-window, so their full week-0 is captured. (Decoupling the
      //    look-back from the display window does NOT remove this seam — it only
      //    moves it to lookbackStart; this guard closes it.)
      //  • RIGHT — keep a life-week only once it is fully observed for EVERY member
      //    of the cohort-week. cohort_week is the week start, but members join
      //    across the whole 7-day week, so the latest joiner (cohort_week + 6)
      //    finishes life-week L on cohort_week + L*7 + 6 + 6. Bounding on +12 (not
      //    +6) avoids partially censoring each cohort's most-recent point, which
      //    would otherwise depress the last point and fake a closing cliff.
      .rawHaving(
        `cohort_week >= toDate('${clix.date(lookbackStart)}') AND addDays(cohort_week, life_week * 7 + 12) <= toDate('${clix.date(endDate)}')`,
      )
      .orderBy('cohort_week', 'ASC')
      .orderBy('life_week', 'ASC');

    const res = await query.execute();
    return res.map((row) => ({
      cohort_week: String(row.cohort_week).slice(0, 10),
      life_week: Number(row.life_week) || 0,
      sessions: row.sessions ?? 0,
    }));
  }

  private async getMetricsWithPageFilter({
    projectId,
    filters,
    startDate,
    endDate,
    interval,
    timezone,
  }: IGetMetricsInput): Promise<{
    metrics: MetricsRow & { total_revenue: number };
    series: MetricsSeriesRow[];
  }> {
    const where = this.getRawWhereClause('sessions', filters);
    const fillConfig = this.getFillConfig(interval, startDate, endDate);

    // CTE: per-event screen_view durations via window function
    const rawScreenViewDurationsQuery = clix(this.client, timezone)
      .select([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        `dateDiff('millisecond', created_at, lead(created_at, 1, created_at) OVER (PARTITION BY session_id ORDER BY created_at)) AS duration`,
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'screen_view')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters));

    // CTE: avg duration per date bucket
    const avgDurationByDateQuery = clix(this.client, timezone)
      .select([
        'date',
        'round(avgIf(duration, duration > 0), 2) / 1000 AS avg_session_duration',
      ])
      .from('raw_screen_view_durations')
      .groupBy(['date']);

    // Session aggregation with bounce rates
    const sessionAggQuery = clix(this.client, timezone)
      .select([
        `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
        'round((countIf(is_bounce = 1 AND sign = 1) * 100.) / countIf(sign = 1), 2) AS bounce_rate',
      ])
      .from(TABLE_NAMES.sessions, true)
      .where('sign', '=', 1)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .groupBy(['date'])
      .rollup()
      .orderBy('date', 'ASC');

    // Overall unique visitors
    const overallUniqueVisitorsQuery = clix(this.client, timezone)
      .select([
        'uniq(profile_id) AS unique_visitors',
        'uniq(session_id) AS total_sessions',
      ])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'screen_view')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters));

    // Use toDate for month/week intervals, toDateTime for others
    const rollupDate =
      interval === 'month' || interval === 'week'
        ? clix.date(ROLLUP_DATE_PREFIX)
        : clix.datetime(`${ROLLUP_DATE_PREFIX} 00:00:00`);

    // Main metrics query (without revenue)
    const mainQuery = clix(this.client, timezone)
      .with('session_agg', sessionAggQuery)
      .with(
        'overall_bounce_rate',
        clix(this.client, timezone)
          .select(['bounce_rate'])
          .from('session_agg')
          .where('date', '=', rollupDate)
      )
      .with(
        'daily_session_stats',
        clix(this.client, timezone)
          .select(['date', 'bounce_rate'])
          .from('session_agg')
          .where('date', '!=', rollupDate)
      )
      .with('overall_unique_visitors', overallUniqueVisitorsQuery)
      .with('raw_screen_view_durations', rawScreenViewDurationsQuery)
      .with('avg_duration_by_date', avgDurationByDateQuery)
      .select<{
        date: string;
        bounce_rate: number;
        unique_visitors: number;
        total_sessions: number;
        avg_session_duration: number;
        total_screen_views: number;
        views_per_session: number;
        overall_unique_visitors: number;
        overall_total_sessions: number;
        overall_bounce_rate: number;
      }>([
        `${clix.toStartOf('e.created_at', interval as any)} AS date`,
        'dss.bounce_rate as bounce_rate',
        'uniq(e.profile_id) AS unique_visitors',
        'uniq(e.session_id) AS total_sessions',
        'coalesce(dur.avg_session_duration, 0) AS avg_session_duration',
        'count(*) AS total_screen_views',
        'round((count(*) * 1.) / uniq(e.session_id), 2) AS views_per_session',
        '(SELECT unique_visitors FROM overall_unique_visitors) AS overall_unique_visitors',
        '(SELECT total_sessions FROM overall_unique_visitors) AS overall_total_sessions',
        '(SELECT bounce_rate FROM overall_bounce_rate) AS overall_bounce_rate',
      ])
      .from(`${TABLE_NAMES.events} AS e`)
      .leftJoin(
        'daily_session_stats AS dss',
        `${clix.toStartOf('e.created_at', interval as any)} = dss.date`
      )
      .leftJoin(
        'avg_duration_by_date AS dur',
        `${clix.toStartOf('e.created_at', interval as any)} = dur.date`
      )
      .where('e.project_id', '=', projectId)
      .where('e.name', '=', 'screen_view')
      .where('e.created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['date', 'dss.bounce_rate', 'dur.avg_session_duration'])
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => new Date(item.date).toISOString(),
      });

    // Revenue query
    const revenueQuery = this.createRevenueQuery({
      projectId,
      startDate,
      endDate,
      interval,
      timezone,
      filters,
    });

    // Execute both queries in parallel and merge results
    const [mainRes, revenueRes] = await Promise.all([
      mainQuery.execute(),
      revenueQuery.execute(),
    ]);

    const overallRevenue = this.getOverallRevenue(revenueRes);
    const series = this.mergeRevenueIntoSeries(mainRes, revenueRes);

    const anyRowWithData = mainRes.find(
      (item) =>
        item.overall_bounce_rate !== null ||
        item.overall_total_sessions !== null ||
        item.overall_unique_visitors !== null
    );

    return {
      metrics: {
        bounce_rate: anyRowWithData?.overall_bounce_rate ?? 0,
        unique_visitors: anyRowWithData?.overall_unique_visitors ?? 0,
        total_sessions: anyRowWithData?.overall_total_sessions ?? 0,
        avg_session_duration: average(
          mainRes.map((item) => item.avg_session_duration)
        ),
        total_screen_views: sum(mainRes.map((item) => item.total_screen_views)),
        views_per_session: average(
          mainRes.map((item) => item.views_per_session)
        ),
        total_revenue: overallRevenue,
      },
      series,
    };
  }

  getRawWhereClause(type: 'events' | 'sessions', filters: IChartEventFilter[]) {
    const where = getEventFiltersWhereClause(
      filters.flatMap((item) => {
        if (!WHITELISTED_FILTERS.includes(item.name)) {
          return []
        }
        if (type === 'sessions') {
          if (item.name === 'path') {
            return [{ ...item, name: 'entry_path' }];
          }
          if (item.name === 'origin') {
            return [{ ...item, name: 'entry_origin' }];
          }
          if (item.name.startsWith('properties.__query.utm_')) {
            return [
              {
                ...item,
                name: item.name.replace('properties.__query.utm_', 'utm_'),
              },
            ];
          }
          // sessions table has no `properties` map for arbitrary keys —
          // drop them instead of generating an invalid WHERE clause.
          if (item.name.startsWith('properties.')) {
            return [];
          }
          return [item];
        }
        // events table has no top-level utm_* columns — those live in the
        // properties map under the __query.utm_* keys. Route them through
        // getEventFiltersWhereClause's properties.* path so we emit
        // `properties['__query.utm_source']` instead of the bare column.
        if (UTM_COLUMNS.includes(item.name)) {
          return [{ ...item, name: `properties.__query.${item.name}` }];
        }
        return [item];
      }),
      undefined,
      undefined,
      type,
    );

    return Object.values(where).join(' AND ');
  }

  async getTopPages({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    limit,
  }: IGetTopPagesInput) {
    const selectColumns: (string | null | undefined | false)[] = [
      'origin',
      'path',
      'uniq(session_id) as sessions',
      'count() as pageviews',
    ];

    if (INCLUDE_REVENUE) {
      selectColumns.push('sum(revenue) as revenue');
    }

    const query = clix(this.client, timezone)
      .select<{
        origin: string;
        path: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>(selectColumns)
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', '=', 'screen_view')
      .where('path', '!=', '')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .groupBy(['origin', 'path'])
      .orderBy('sessions', 'DESC')
      .limit(Math.min(limit ?? MAX_RECORDS_LIMIT, MAX_RECORDS_LIMIT));

    return query.execute();
  }

  async getTopEntryExit({
    projectId,
    filters,
    startDate,
    endDate,
    mode,
    timezone,
    limit,
  }: IGetTopEntryExitInput) {
    const selectColumns: (string | null | undefined | false)[] = [
      `${mode}_origin AS origin`,
      `${mode}_path AS path`,
      'sum(sign) as sessions',
      'sum(sign * screen_view_count) as pageviews',
    ];

    if (INCLUDE_REVENUE) {
      selectColumns.push('sum(revenue * sign) as revenue');
    }

    const query = clix(this.client, timezone)
      .select<{
        origin: string;
        path: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>(selectColumns)
      .from(TABLE_NAMES.sessions, true)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .groupBy([`${mode}_origin`, `${mode}_path`])
      .having('sum(sign)', '>', 0)
      .orderBy('sessions', 'DESC')
      .limit(Math.min(limit ?? MAX_RECORDS_LIMIT, MAX_RECORDS_LIMIT));

    const mainQuery = this.withDistinctSessionsIfNeeded(query, {
      projectId,
      filters,
      startDate,
      endDate,
      timezone,
    });

    return mainQuery.execute();
  }

  private getDistinctSessions({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }) {
    return clix(this.client, timezone)
      .select(['DISTINCT session_id'])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters));
  }

  async getTopGeneric({
    projectId,
    filters,
    startDate,
    endDate,
    column,
    timezone,
  }: IGetTopGenericInput) {
    if (!WHITELISTED_FILTERS.includes(column)) {
      return [];
    }
    
    const prefixColumn = COLUMN_PREFIX_MAP[column] ?? null;

    const selectColumns: (string | null | undefined | false)[] = [
      prefixColumn && `${prefixColumn} as prefix`,
      `nullIf(${column}, '') as name`,
      'sum(sign) as sessions',
      'sum(sign * screen_view_count) as pageviews',
    ];

    if (INCLUDE_REVENUE) {
      selectColumns.push('sum(revenue * sign) as revenue');
    }

    const query = clix(this.client, timezone)
      .select<{
        prefix?: string;
        name: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>(selectColumns)
      .from(TABLE_NAMES.sessions, true)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .groupBy([prefixColumn, column].filter(Boolean))
      .having('sum(sign)', '>', 0)
      .orderBy('sessions', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    const mainQuery = this.withDistinctSessionsIfNeeded(query, {
      projectId,
      filters,
      startDate,
      endDate,
      timezone,
    });

    return mainQuery.execute();
  }

  async getTopGenericSeries({
    projectId,
    filters,
    startDate,
    endDate,
    column,
    interval,
    timezone,
  }: IGetTopGenericSeriesInput): Promise<{
    items: Array<{
      name: string;
      prefix?: string;
      data: Array<{
        date: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>;
      total: { sessions: number; pageviews: number; revenue?: number };
    }>;
  }> {
    const prefixColumn = COLUMN_PREFIX_MAP[column] ?? null;
    const TOP_LIMIT = 500;
    const fillConfig = this.getFillConfig(interval, startDate, endDate);

    // Step 1: Get top 15 items
    const selectColumns: (string | null | undefined | false)[] = [
      prefixColumn && `${prefixColumn} as prefix`,
      `nullIf(${column}, '') as name`,
      'sum(sign) as sessions',
      'sum(sign * screen_view_count) as pageviews',
    ];

    if (INCLUDE_REVENUE) {
      selectColumns.push('sum(revenue * sign) as revenue');
    }

    const topItemsQuery = clix(this.client, timezone)
      .select<{
        prefix?: string;
        name: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>(selectColumns)
      .from(TABLE_NAMES.sessions, true)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .groupBy([prefixColumn, column].filter(Boolean))
      .having('sum(sign)', '>', 0)
      .orderBy('sessions', 'DESC')
      .limit(TOP_LIMIT);

    const mainTopItemsQuery = this.withDistinctSessionsIfNeeded(topItemsQuery, {
      projectId,
      filters,
      startDate,
      endDate,
      timezone,
    });

    const topItems = await mainTopItemsQuery.execute();

    if (topItems.length === 0) {
      return { items: [] };
    }

    // Step 2: Build time-series query for each top item
    const where = this.getRawWhereClause('sessions', filters);
    const timeSeriesSelectColumns: (string | null | undefined | false)[] = [
      `${clix.toStartOf('created_at', interval as any, timezone)} AS date`,
      prefixColumn && `${prefixColumn} as prefix`,
      `nullIf(${column}, '') as name`,
      'sum(sign) as sessions',
      'sum(sign * screen_view_count) as pageviews',
    ];

    if (INCLUDE_REVENUE) {
      timeSeriesSelectColumns.push('sum(revenue * sign) as revenue');
    }

    const timeSeriesQuery = clix(this.client, timezone)
      .select<{
        date: string;
        prefix?: string;
        name: string;
        sessions: number;
        pageviews: number;
        revenue?: number;
      }>(timeSeriesSelectColumns)
      .from(TABLE_NAMES.sessions, true)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .groupBy(['date', prefixColumn, column].filter(Boolean))
      .having('sum(sign)', '>', 0)
      .orderBy('date', 'ASC')
      .fill(fillConfig.from, fillConfig.to, fillConfig.step)
      .transform({
        date: (item) => new Date(item.date).toISOString(),
      });

    const mainTimeSeriesQuery = this.withDistinctSessionsIfNeeded(
      timeSeriesQuery,
      {
        projectId,
        filters,
        startDate,
        endDate,
        timezone,
      }
    );

    const timeSeriesData = await mainTimeSeriesQuery.execute();

    // Step 3: Group time-series data by item and calculate totals
    const itemsMap = new Map<
      string,
      {
        name: string;
        prefix?: string;
        data: Array<{
          date: string;
          sessions: number;
          pageviews: number;
          revenue?: number;
        }>;
        total: { sessions: number; pageviews: number; revenue?: number };
      }
    >();

    // Initialize items from topItems
    for (const item of topItems) {
      const key = `${item.prefix || ''}:${item.name}`;
      itemsMap.set(key, {
        name: item.name,
        prefix: item.prefix,
        data: [],
        total: {
          sessions: item.sessions,
          pageviews: item.pageviews,
          revenue: item.revenue ?? 0,
        },
      });
    }

    // Populate time-series data
    for (const row of timeSeriesData) {
      const key = `${row.prefix || ''}:${row.name}`;
      const item = itemsMap.get(key);
      if (item) {
        item.data.push({
          date: row.date,
          sessions: row.sessions,
          pageviews: row.pageviews,
          revenue: row.revenue,
        });
      }
    }

    return {
      items: Array.from(itemsMap.values()),
    };
  }

  async getUserJourney({
    projectId,
    filters,
    startDate,
    endDate,
    steps = 5,
    timezone,
  }: IGetUserJourneyInput): Promise<{
    nodes: Array<{
      id: string;
      label: string;
      nodeColor: string;
      percentage?: number;
      value?: number;
      step?: number;
    }>;
    links: Array<{ source: string; target: string; value: number }>;
  }> {
    // Config
    const TOP_ENTRIES = 3; // Only show top 3 entry pages
    const TOP_DESTINATIONS_PER_NODE = 3; // Top 3 destinations from each node

    // Color palette - each entry page gets a consistent color
    const COLORS = chartColors.map((color) => color.main);

    // Step 1: Get session paths (deduped consecutive pages)
    const orderedEventsQuery = clix(this.client, timezone)
      .select<{
        session_id: string;
        path: string;
        created_at: string;
      }>(['session_id', 'concat(origin, path) as path', 'created_at'])
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .where('name', '=', 'screen_view')
      .where('path', '!=', '')
      .where('path', 'IS NOT NULL')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(this.getRawWhereClause('events', filters))
      .orderBy('session_id', 'ASC')
      .orderBy('created_at', 'ASC');

    // Intermediate CTE to compute deduped paths
    const pathsDedupedCTE = clix(this.client, timezone)
      .with('ordered_events', orderedEventsQuery)
      .select<{
        session_id: string;
        paths_deduped: string[];
      }>([
        'session_id',
        `arraySlice(
          arrayFilter(
            (x, i) -> i = 1 OR x != paths_raw[i - 1],
            groupArray(path) as paths_raw,
            arrayEnumerate(paths_raw)
          ),
          1, ${steps}
        ) as paths_deduped`,
      ])
      .from('ordered_events')
      .groupBy(['session_id']);

    const sessionPathsQuery = clix(this.client, timezone)
      .with('paths_deduped_cte', pathsDedupedCTE)
      .select<{
        session_id: string;
        entry_page: string;
        paths: string[];
      }>([
        'session_id',
        // Truncate at first repeat
        `if(
          arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(paths_deduped)) = 0,
          paths_deduped,
          arraySlice(
            paths_deduped,
            1,
            arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(paths_deduped)) - 1
          )
        ) as paths`,
        // Entry page is first element
        'paths[1] as entry_page',
      ])
      .from('paths_deduped_cte')
      .having('length(paths)', '>=', 2);

    // Step 2: Find top 3 entry pages
    const topEntriesQuery = clix(this.client, timezone)
      .with('session_paths', sessionPathsQuery)
      .select<{ entry_page: string; count: number }>([
        'entry_page',
        'count() as count',
      ])
      .from('session_paths')
      .groupBy(['entry_page'])
      .orderBy('count', 'DESC')
      .limit(TOP_ENTRIES);

    const topEntries = await topEntriesQuery.execute();

    if (topEntries.length === 0) {
      return { nodes: [], links: [] };
    }

    const topEntryPages = topEntries.map((e) => e.entry_page);
    const totalSessions = topEntries.reduce((sum, e) => sum + e.count, 0);

    // Step 3: Get all transitions, but ONLY for sessions starting with top entries
    const transitionsQuery = clix(this.client, timezone)
      .with('paths_deduped_cte', pathsDedupedCTE)
      .with(
        'session_paths',
        clix(this.client, timezone)
          .select([
            'session_id',
            // Truncate at first repeat
            `if(
              arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(paths_deduped)) = 0,
              paths_deduped,
              arraySlice(
                paths_deduped,
                1,
                arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(paths_deduped)) - 1
              )
            ) as paths`,
          ])
          .from('paths_deduped_cte')
          .having('length(paths)', '>=', 2)
          // ONLY sessions starting with top entry pages
          .having('paths[1]', 'IN', topEntryPages)
      )
      .select<{
        source: string;
        target: string;
        step: number;
        value: number;
      }>([
        'pair.1 as source',
        'pair.2 as target',
        'pair.3 as step',
        'count() as value',
      ])
      .from(
        clix.exp(
          '(SELECT arrayJoin(arrayMap(i -> (paths[i], paths[i + 1], i), range(1, length(paths)))) as pair FROM session_paths WHERE length(paths) >= 2)'
        )
      )
      .groupBy(['source', 'target', 'step'])
      .orderBy('step', 'ASC')
      .orderBy('value', 'DESC');

    const transitions = await transitionsQuery.execute();

    if (transitions.length === 0) {
      return { nodes: [], links: [] };
    }

    // Step 4: Build the sankey progressively step by step
    // Start with entry nodes, then follow top destinations at each step
    // Use unique node IDs by combining path with step to prevent circular references
    const nodes = new Map<
      string,
      { path: string; value: number; step: number; color: string }
    >();
    const links: Array<{ source: string; target: string; value: number }> = [];

    // Helper to create unique node ID
    const getNodeId = (path: string, step: number) => `${path}::step${step}`;

    // Group transitions by step
    const transitionsByStep = new Map<number, typeof transitions>();
    for (const t of transitions) {
      if (!transitionsByStep.has(t.step)) {
        transitionsByStep.set(t.step, []);
      }
      transitionsByStep.get(t.step)!.push(t);
    }

    // Initialize with entry pages (step 1)
    const activeNodes = new Map<string, string>(); // path -> nodeId
    topEntries.forEach((entry, idx) => {
      const nodeId = getNodeId(entry.entry_page, 1);
      nodes.set(nodeId, {
        path: entry.entry_page,
        value: entry.count,
        step: 1,
        color: COLORS[idx % COLORS.length]!,
      });
      activeNodes.set(entry.entry_page, nodeId);
    });

    // Process each step: from active nodes, find top destinations
    for (let step = 1; step < steps; step++) {
      const stepTransitions = transitionsByStep.get(step) || [];
      const nextActiveNodes = new Map<string, string>();

      // For each currently active node, find its top destinations
      for (const [sourcePath, sourceNodeId] of activeNodes) {
        // Get transitions FROM this source path
        const fromSource = stepTransitions
          .filter((t) => t.source === sourcePath)
          .sort((a, b) => b.value - a.value)
          .slice(0, TOP_DESTINATIONS_PER_NODE);

        for (const t of fromSource) {
          // Skip self-loops
          if (t.source === t.target) {
            continue;
          }

          const targetNodeId = getNodeId(t.target, step + 1);

          // Add link using unique node IDs
          links.push({
            source: sourceNodeId,
            target: targetNodeId,
            value: t.value,
          });

          // Add/update target node
          const existing = nodes.get(targetNodeId);
          if (existing) {
            existing.value += t.value;
          } else {
            // Inherit color from source or assign new
            const sourceData = nodes.get(sourceNodeId);
            nodes.set(targetNodeId, {
              path: t.target,
              value: t.value,
              step: step + 1,
              color: sourceData?.color || COLORS[nodes.size % COLORS.length]!,
            });
          }

          nextActiveNodes.set(t.target, targetNodeId);
        }
      }

      // Update active nodes for next iteration
      activeNodes.clear();
      for (const [path, nodeId] of nextActiveNodes) {
        activeNodes.set(path, nodeId);
      }

      // Stop if no more nodes to process
      if (activeNodes.size === 0) {
        break;
      }
    }

    // Step 5: Filter links by threshold (0.25% of total sessions)
    const MIN_LINK_PERCENT = 0.25;
    const minLinkValue = Math.ceil((totalSessions * MIN_LINK_PERCENT) / 100);
    const filteredLinks = links.filter((link) => link.value >= minLinkValue);

    // Step 6: Find all nodes referenced by remaining links
    const referencedNodeIds = new Set<string>();
    filteredLinks.forEach((link) => {
      referencedNodeIds.add(link.source);
      referencedNodeIds.add(link.target);
    });

    // Step 7: Recompute node values from filtered links (sum of incoming links)
    const nodeValuesFromLinks = new Map<string, number>();
    filteredLinks.forEach((link) => {
      // Add to target node value
      const current = nodeValuesFromLinks.get(link.target) || 0;
      nodeValuesFromLinks.set(link.target, current + link.value);
    });

    // For entry nodes (step 1), only keep them if they have outgoing links after filtering
    nodes.forEach((nodeData, nodeId) => {
      if (nodeData.step === 1) {
        const hasOutgoing = filteredLinks.some((l) => l.source === nodeId);
        if (!hasOutgoing) {
          // No outgoing links, remove entry node
          referencedNodeIds.delete(nodeId);
        }
      }
    });

    // Step 8: Build final nodes array sorted by step then value
    // Only include nodes that are referenced by filtered links
    const finalNodes = Array.from(nodes.entries())
      .filter(([id]) => referencedNodeIds.has(id))
      .map(([id, data]) => {
        // Use value from links for non-entry nodes, or original value for entry nodes with outgoing links
        const value =
          data.step === 1
            ? data.value
            : nodeValuesFromLinks.get(id) || data.value;
        return {
          id,
          label: data.path, // Add label for display
          nodeColor: data.color,
          percentage: (value / totalSessions) * 100,
          value,
          step: data.step,
        };
      })
      .sort((a, b) => {
        // Sort by step first, then by value descending
        if (a.step !== b.step) {
          return a.step - b.step;
        }
        return b.value - a.value;
      });

    // Sanity check: Ensure all link endpoints exist in nodes
    const nodeIds = new Set(finalNodes.map((n) => n.id));
    const invalidLinks = filteredLinks.filter(
      (link) => !(nodeIds.has(link.source) && nodeIds.has(link.target))
    );
    if (invalidLinks.length > 0) {
      console.warn(
        `UserJourney: Found ${invalidLinks.length} links with missing nodes`
      );
      // Remove invalid links
      const validLinks = filteredLinks.filter(
        (link) => nodeIds.has(link.source) && nodeIds.has(link.target)
      );
      return {
        nodes: finalNodes,
        links: validLinks,
      };
    }

    // Sanity check: Ensure steps are monotonic (should always be true, but verify)
    const stepsValid = finalNodes.every((node, idx, arr) => {
      if (idx === 0) {
        return true;
      }
      return node.step! >= arr[idx - 1]!.step!;
    });
    if (!stepsValid) {
      console.warn('UserJourney: Steps are not monotonic');
    }

    return {
      nodes: finalNodes,
      links: filteredLinks,
    };
  }

  async getTopEvents({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    excludeEvents = ['session_start', 'session_end', 'screen_view'],
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
    excludeEvents?: string[];
  }): Promise<Array<{ name: string; count: number }>> {
    const where = this.getRawWhereClause('events', filters);
    const excludeWhere =
      excludeEvents.length > 0
        ? `name NOT IN (${excludeEvents.map((e) => sqlstring.escape(e)).join(',')})`
        : '';

    const query = clix(this.client, timezone)
      .select<{ name: string; count: number }>(['name', 'count() as count'])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .rawWhere(excludeWhere)
      .groupBy(['name'])
      .orderBy('count', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    return query.execute();
  }

  // Fork-only: per-game level funnel (started / completed) for the Top games
  // widget. game_id lives on ~100% of level_started/level_completed events, so a
  // single grouped scan with countIf gives both numbers. Aliases (quiz/quizr,
  // etc.) are intentionally left as separate rows.
  async getTopGames({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<Array<{ game_id: string; started: number; completed: number }>> {
    const where = this.getRawWhereClause('events', filters);
    const gameKey = getSelectPropertyKey('properties.game_id');

    const query = clix(this.client, timezone)
      .select<{ game_id: string; started: number; completed: number }>([
        `${gameKey} as game_id`,
        "countIf(name = 'level_started') as started",
        "countIf(name = 'level_completed') as completed",
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', 'IN', ['level_started', 'level_completed'])
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .rawWhere(`${gameKey} IS NOT NULL AND ${gameKey} != ''`)
      .groupBy(['game_id'])
      .orderBy('started', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    return query.execute();
  }

  async getTopLinkOut({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<Array<{ href: string; count: number }>> {
    const where = this.getRawWhereClause('events', filters);
    const hrefKey = getSelectPropertyKey('properties.href');

    const query = clix(this.client, timezone)
      .select<{ href: string; count: number }>([
        `${hrefKey} as href`,
        'count() as count',
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', '=', 'link_out')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .rawWhere(`${hrefKey} IS NOT NULL AND ${hrefKey} != ''`)
      .groupBy(['href'])
      .orderBy('count', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    return query.execute();
  }

  // Fork-only: distinct property keys carried by a single event (range-scoped),
  // with how many in-range events carry each key. Level 2 of the drill-down
  // Events widget (event -> property keys -> values). Internal `__*` keys are
  // excluded to match the event-details properties view.
  async getEventPropertyKeys({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    eventName,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
    eventName: string;
  }): Promise<Array<{ key: string; count: number }>> {
    const where = this.getRawWhereClause('events', filters);

    const query = clix(this.client, timezone)
      .select<{ key: string; count: number }>([
        "arrayJoin(arrayFilter(k -> NOT startsWith(k, '__'), mapKeys(properties))) as key",
        'count() as count',
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', '=', eventName)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .groupBy(['key'])
      .orderBy('count', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    return query.execute();
  }

  // Fork-only: value distribution (range-scoped) for one event + property key.
  // Level 3 of the drill-down Events widget. This is the generic form of
  // getTopLinkOut (which is just this for link_out / properties.href).
  async getEventPropertyValues({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
    eventName,
    propertyKey,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
    eventName: string;
    propertyKey: string;
  }): Promise<Array<{ value: string; count: number }>> {
    const where = this.getRawWhereClause('events', filters);
    // Escape the user-supplied key directly into the Map access — getSelectPropertyKey
    // interpolates the key without escaping, so we build the accessor ourselves.
    const valueExpr = `properties[${sqlstring.escape(propertyKey)}]`;

    const query = clix(this.client, timezone)
      .select<{ value: string; count: number }>([
        `${valueExpr} as value`,
        'count() as count',
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', '=', eventName)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .rawWhere(`${valueExpr} != ''`)
      .groupBy(['value'])
      .orderBy('count', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    return query.execute();
  }

  async getMapData({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    filters: IChartEventFilter[];
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<
    Array<{
      country: string;
      region?: string;
      city?: string;
      lat: number;
      lng: number;
      count: number;
    }>
  > {
    const where = this.getRawWhereClause('events', filters);

    // Note: ClickHouse doesn't have built-in lat/lng for countries/regions
    // This would typically require a lookup table or external service
    // For now, we'll return the data structure but lat/lng would need to be
    // resolved on the frontend or via a separate lookup
    const query = clix(this.client, timezone)
      .select<{
        country: string;
        region: string | null;
        city: string | null;
        count: number;
      }>([
        "nullIf(country, '') as country",
        "nullIf(region, '') as region",
        "nullIf(city, '') as city",
        'uniq(session_id) as count',
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(where)
      .rawWhere("country IS NOT NULL AND country != ''")
      .groupBy(['country', 'region', 'city'])
      .orderBy('count', 'DESC')
      .limit(MAX_RECORDS_LIMIT);

    const results = await query.execute();

    // Return with placeholder lat/lng - these should be resolved via geocoding
    // or a lookup table on the frontend/backend
    return results.map((row) => ({
      country: row.country,
      region: row.region ?? undefined,
      city: row.city ?? undefined,
      lat: 0, // Placeholder - needs geocoding
      lng: 0, // Placeholder - needs geocoding
      count: row.count,
    }));
  }
}

export const overviewService = new OverviewService(ch);

import { getSettingsForProject } from './organization.service';

export type TrafficColumn =
  | 'referrer'
  | 'referrer_name'
  | 'referrer_type'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'country'
  | 'region'
  | 'city'
  | 'device'
  | 'browser'
  | 'os';

export async function getTrafficBreakdownCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  column: TrafficColumn;
  filters?: IChartEventFilter[];
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  return overviewService.getTopGeneric({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    column: input.column,
    timezone,
  });
}

export interface GetAnalyticsOverviewInput {
  projectId: string;
  startDate: string;
  endDate: string;
  interval?: 'hour' | 'day' | 'week' | 'month';
  filters?: IChartEventFilter[];
}

export async function getAnalyticsOverviewCore(
  input: GetAnalyticsOverviewInput,
) {
  const { timezone } = await getSettingsForProject(input.projectId);
  const interval = input.interval ?? 'day';

  const result = await overviewService.getMetrics({
    projectId: input.projectId,
    filters: input.filters ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    interval,
    timezone,
  });

  return {
    summary: result.metrics,
    series: result.series,
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
  };
}
