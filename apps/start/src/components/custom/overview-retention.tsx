/**
 * Retention section (fork-only) — two honest, complementary signals derived
 * purely from `days_since_first_visit` (dsfv) on `session_started`. No stable
 * cross-day identity exists (the anon id rotates daily), so everything here is a
 * session-denominated *floor*, not people-retention — see `FloorNote`.
 *
 *   • Tenure River (stock)  — who is here now, by visitor age. countIf(age band)
 *                             per interval; no ratio, no denominator, no
 *                             censoring. Cannot manufacture a >100% spike.
 *   • Cohort Quality (flow) — do newer join-cohorts stick better than older
 *                             ones? week-N activity retention per cohort.
 *
 * Data: overview.tenureSeries (C) and overview.cohortRetention (F). The service
 * keeps the picture honest (decoupled full-history cohort denominators, a
 * bounded look-back, and a server-side right-censor); this file adds the
 * client-side honesty guards (min-cohort-size, 100% cap, a stable labelled
 * target week, and an explicit low-sample empty state).
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartTooltipHeader,
  ChartTooltipItem,
  createChartTooltip,
} from '@/components/charts/chart-tooltip';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useFormatDateInterval } from '@/hooks/use-format-date-interval';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { Widget, WidgetBody, WidgetHead, WidgetTitle } from '@/components/widget';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';

// blue (fresh) -> green (mature). A sequential ramp encodes the ordinal "age"
// meaning intuitively; new (spiky) sits on top, mature (stable) at the baseline.
const TENURE = [
  { key: 'bucket_30', label: 'Over 30 days', color: '#16a34a' },
  { key: 'bucket_8_30', label: '8 to 30 days', color: '#4ade80' },
  { key: 'bucket_1_7', label: '1 to 7 days', color: '#3b82f6' },
  { key: 'bucket_new', label: 'Brand new', color: '#93c5fd' },
] as const;

// The Cohort Quality line, fill, dots, and tooltip all share one green, so a
// theme tweak is a single edit.
const COHORT_GREEN = '#16a34a';

// Shared axis geometry for both charts. 52px axis minus the -8 left margin
// leaves 44px of label room — enough for the widest ticks ("100%" ≈ 32px,
// "8000" ≈ 30px). Anything tighter clips leading digits (44/-16 rendered
// "100%"/"75%"/"50%"/"25%" as "0%"/"5%"/"0%"/"5%").
const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: -8 } as const;
const Y_AXIS_WIDTH = 52;

// --- Honesty / stability guards -------------------------------------------

// Drop cohorts whose week-0 (first-7-days) denominator is below this. ~100 is the
// widely-cited floor below which a single cohort's retention point is noise
// rather than signal; it also excludes tiny launch-era / instrumentation-seam
// cohorts whose handful of sessions manufacture >100% retention. An absolute
// floor (not a fraction of the median) is deliberate: a huge client clears it
// trivially, a tiny client honestly falls back to the empty state instead of
// plotting noise.
const MIN_COHORT_SIZE = 100;

// Retention is noisy at the ±pp level, so only call a move a direction once it
// clears a meaningful band (statistical noise otherwise red/green-flags).
const TREND_EPS = 5;

// F's target life-week is pinned to a fixed, mature checkpoint so it does NOT
// silently drift as the date range changes (which is confusing in a recurring
// client report). We only step *down* from it when too few cohorts have aged
// that far — and the chosen week is always labelled prominently.
const PREFERRED_TARGET_WEEK = 4;

// Need at least this many qualifying cohorts before drawing a trend line; fewer
// than this renders the honest "not enough history" state, never a confident
// 2-point line.
const MIN_COHORTS_FOR_TREND = 3;

function dirOf(diff: number | null): 'up' | 'down' | 'flat' {
  if (diff == null) {
    return 'flat';
  }
  if (diff > TREND_EPS) {
    return 'up';
  }
  if (diff < -TREND_EPS) {
    return 'down';
  }
  return 'flat';
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function FloorNote({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      These are <span className="font-medium">minimum</span> numbers, not an exact
      count. Private windows, cleared cookies, and people who switch devices all
      pull them down, never up.
    </p>
  );
}

const TREND_VERDICT = {
  up: { cls: 'bg-emerald-500/10 text-emerald-600', icon: '↗', word: 'Improving' },
  down: { cls: 'bg-red-500/10 text-red-600', icon: '↘', word: 'Slipping' },
  flat: { cls: 'bg-muted text-muted-foreground', icon: '→', word: 'Steady' },
} as const;

function TrendVerdict({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  const map = TREND_VERDICT[direction];
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold',
        map.cls,
      )}
    >
      <span className="text-base">{map.icon}</span>
      {map.word}
    </div>
  );
}

function ChartState({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-56 items-center justify-center rounded-lg bg-muted/30 px-6 text-center text-sm text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cohort pivot (F) — flat (cohort_week, life_week, sessions) rows → per-cohort
// curves. retention(L) = sessions(L) / sessions(week 0). The service already
// decouples cohort history from the display window and drops right-censored
// life-weeks; here we drop tiny launch-era cohorts whose week-0 is too small to
// trust.
// ---------------------------------------------------------------------------

type CohortRow = { cohort_week: string; life_week: number; sessions: number };
type Cohort = {
  week: string;
  size: number;
  lifeMap: Map<number, number>;
};

function pivotCohorts(rows: CohortRow[]): Cohort[] {
  const map = new Map<string, Map<number, number>>();
  for (const r of rows) {
    let lifeMap = map.get(r.cohort_week);
    if (!lifeMap) {
      lifeMap = new Map();
      map.set(r.cohort_week, lifeMap);
    }
    lifeMap.set(r.life_week, r.sessions);
  }
  return [...map.entries()]
    .map(([week, lifeMap]) => ({
      week,
      lifeMap,
      size: lifeMap.get(0) ?? 0,
    }))
    .filter((c) => c.size >= MIN_COHORT_SIZE)
    .sort((a, b) => a.week.localeCompare(b.week));
}

function retentionAt(c: Cohort, L: number): number | null {
  const s = c.lifeMap.get(L);
  if (s == null || !c.size) return null;
  // Cap at 100%: this is a retention floor, so a survivors-more-active blip
  // shouldn't render as a >100% spike. With full-history denominators this is a
  // safety net, not the common case.
  return Math.min(100, (s / c.size) * 100);
}

// Prefer the fixed checkpoint week; step down only when too few cohorts have
// aged that far. Deterministic given the data → no silent drift.
function chooseTargetWeek(cohorts: Cohort[]): number | null {
  for (let L = PREFERRED_TARGET_WEEK; L >= 1; L--) {
    if (cohorts.filter((c) => c.lifeMap.has(L)).length >= MIN_COHORTS_FOR_TREND) {
      return L;
    }
  }
  return null;
}

// ===========================================================================
// Tenure River (C) — sessions by visitor age over time. The honest headline:
// no censored denominator, just composition.
// ===========================================================================

type TenureRow = {
  date: string;
  bucket_new: number;
  bucket_1_7: number;
  bucket_8_30: number;
  bucket_30: number;
};

// Openpanel's shared chart tooltip (glassy card), instead of recharts' default
// white box — matches the rest of the dashboard.
const { TooltipProvider: TenureTooltipProvider, Tooltip: TenureTooltip } =
  createChartTooltip<
    TenureRow & { label: string },
    { formatDate: (date: Date | string) => string }
  >(({ data, context }) => {
    const item = data[0];
    if (!item) return null;
    const total =
      item.bucket_new + item.bucket_1_7 + item.bucket_8_30 + item.bucket_30;
    return (
      <>
        <ChartTooltipHeader>
          <div className="font-medium">{context.formatDate(item.date)}</div>
          <div className="text-muted-foreground">
            {total.toLocaleString()} sessions
          </div>
        </ChartTooltipHeader>
        {TENURE.map((t) => (
          <ChartTooltipItem color={t.color} key={t.key}>
            <div className="flex justify-between gap-8 font-medium font-mono">
              <span>{t.label}</span>
              <span>{item[t.key].toLocaleString()}</span>
            </div>
          </ChartTooltipItem>
        ))}
      </>
    );
  });

function TenureRiver({ rows, loading }: { rows: TenureRow[]; loading: boolean }) {
  const { interval } = useOverviewOptions();
  const formatDate = useFormatDateInterval({ interval, short: false });
  const data = useMemo(
    () => rows.map((r) => ({ ...r, label: r.date.slice(5, 10) })),
    [rows],
  );
  return (
    <Widget className="col-span-6">
      <WidgetHead>
        <WidgetTitle>New and returning visitors over time</WidgetTitle>
      </WidgetHead>
      <WidgetBody>
        <p className="mb-4 text-sm text-muted-foreground">
          Sessions over time, split by how long the visitor has been coming back.
          The <span className="font-medium text-emerald-600">green</span> base at
          the bottom is your long-time, loyal audience. The{' '}
          <span className="font-medium text-blue-500">blue</span> on top is people
          showing up for the first time. When the green base grows, your audience
          is sticking around.
        </p>

        {loading ? (
          <ChartState className="h-64">Loading…</ChartState>
        ) : data.length === 0 ? (
          <ChartState className="h-64">No sessions in this date range.</ChartState>
        ) : (
          <div className="h-64 w-full">
            <TenureTooltipProvider formatDate={formatDate}>
              <ResponsiveContainer>
              <ComposedChart data={data} margin={CHART_MARGIN}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  className="stroke-border"
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  minTickGap={24}
                  className="text-muted-foreground"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  width={Y_AXIS_WIDTH}
                  className="text-muted-foreground"
                />
                <TenureTooltip cursor={{ stroke: 'var(--border)' }} />
                {TENURE.map((t) => (
                  <Area
                    key={t.key}
                    stackId="1"
                    dataKey={t.key}
                    name={t.label}
                    stroke={t.color}
                    fill={t.color}
                    fillOpacity={0.85}
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
              </ResponsiveContainer>
            </TenureTooltipProvider>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {TENURE.map((t) => (
            <div key={t.key} className="flex items-center gap-1.5 text-sm">
              <span
                className="size-3 rounded-sm"
                style={{ backgroundColor: t.color }}
              />
              <span className="text-muted-foreground">{t.label}</span>
            </div>
          ))}
        </div>
        <FloorNote className="mt-3" />
      </WidgetBody>
    </Widget>
  );
}

// ===========================================================================
// Cohort Quality (F) — week-N retention by join-cohort. The flow signal: is the
// experience itself getting stickier, independent of volume?
// ===========================================================================

const { TooltipProvider: CohortTooltipProvider, Tooltip: CohortTooltip } =
  createChartTooltip<{ cohort: string; wk: number }, { target: number }>(
    ({ data, context }) => {
      const item = data[0];
      if (!item) return null;
      const weeks = context.target === 1 ? 'week' : 'weeks';
      return (
        <>
          <ChartTooltipHeader>
            <div className="font-medium">Visitors from week of {item.cohort}</div>
          </ChartTooltipHeader>
          <ChartTooltipItem color={COHORT_GREEN}>
            <div className="flex justify-between gap-8 font-medium font-mono">
              <span>
                Still active {context.target} {weeks} later
              </span>
              <span>{item.wk}%</span>
            </div>
          </ChartTooltipItem>
        </>
      );
    },
  );

function CohortQuality({
  cohorts,
  loading,
}: {
  cohorts: Cohort[];
  loading: boolean;
}) {
  const { target, data } = useMemo(() => {
    const t = chooseTargetWeek(cohorts);
    if (t == null) return { target: null, data: [] as { cohort: string; wk: number }[] };
    const d = cohorts
      .filter((c) => c.lifeMap.has(t))
      .map((c) => ({ cohort: c.week.slice(5), wk: +retentionAt(c, t)!.toFixed(1) }));
    return { target: t, data: d };
  }, [cohorts]);

  const body = () => {
    if (loading) return <ChartState>Loading…</ChartState>;
    if (target == null || data.length < MIN_COHORTS_FOR_TREND) {
      return (
        <ChartState>
          Not enough history yet. This needs a few groups of visitors who have
          been around long enough to measure, each with at least {MIN_COHORT_SIZE}{' '}
          sessions in their first week. Check back as more visitors return, or try
          a wider date range.
        </ChartState>
      );
    }

    const first = data[0]!.wk;
    const last = data[data.length - 1]!.wk;
    return (
      <>
        <div className="mb-1 flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Each dot is a group of visitors who first showed up in the same week.
            It shows how many came back{' '}
            <span className="font-medium">{target} weeks later</span>, next to
            their first week. A line that rises to the right means newer visitors
            are sticking around better, not just that there are more of them.
          </p>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <TrendVerdict direction={dirOf(last - first)} />
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {first}% to {last}% by week {target}
            </span>
          </div>
        </div>

        <div className="mt-3 h-56 w-full">
          <CohortTooltipProvider target={target}>
            <ResponsiveContainer>
            <ComposedChart data={data} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="cqFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COHORT_GREEN} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={COHORT_GREEN} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                className="stroke-border"
              />
              <XAxis
                dataKey="cohort"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                className="text-muted-foreground"
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tickLine={false}
                axisLine={false}
                fontSize={12}
                width={Y_AXIS_WIDTH}
                className="text-muted-foreground"
              />
              <CohortTooltip cursor={{ stroke: 'var(--border)' }} />
              <Area
                dataKey="wk"
                type="monotone"
                stroke={COHORT_GREEN}
                strokeWidth={2.5}
                fill="url(#cqFill)"
                dot={{ r: 3, fill: COHORT_GREEN }}
                isAnimationActive={false}
              />
            </ComposedChart>
            </ResponsiveContainer>
          </CohortTooltipProvider>
        </div>
        <FloorNote className="mt-3" />
      </>
    );
  };

  return (
    <Widget className="col-span-6">
      <WidgetHead>
        <WidgetTitle>Are newer visitors sticking better?</WidgetTitle>
      </WidgetHead>
      <WidgetBody>{body()}</WidgetBody>
    </Widget>
  );
}

// ===========================================================================
// Section
// ===========================================================================

export default function OverviewRetention({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range, interval, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const trpc = useTRPC();

  const queryInput = {
    projectId,
    shareId,
    range,
    interval,
    filters,
    startDate,
    endDate,
  };

  const tenure = useQuery(trpc.overview.tenureSeries.queryOptions(queryInput));
  const cohort = useQuery(trpc.overview.cohortRetention.queryOptions(queryInput));

  const cohorts = useMemo(
    () => pivotCohorts(cohort.data ?? []),
    [cohort.data],
  );

  return (
    <div className="col-span-6 flex flex-col gap-4">
      <TenureRiver rows={tenure.data ?? []} loading={tenure.isLoading} />
      <CohortQuality cohorts={cohorts} loading={cohort.isLoading} />
    </div>
  );
}
