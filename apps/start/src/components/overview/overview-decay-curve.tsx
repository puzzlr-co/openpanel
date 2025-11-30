import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useTRPC } from '@/integrations/trpc/react';
import { getChartColor } from '@/utils/theme';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Widget, WidgetBody } from '../widget';
import { WidgetFooter, WidgetHead } from './overview-widget';
import { useOverviewOptions } from './useOverviewOptions';

export interface OverviewDecayCurveProps {
  projectId: string;
}

export default function OverviewDecayCurve({
  projectId,
}: OverviewDecayCurveProps) {
  const { interval, range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const trpc = useTRPC();

  const query = useQuery(
    trpc.chart.chart.queryOptions(
      {
        projectId,
        startDate,
        endDate,
        events: [
          {
            segment: 'event',
            filters: [...filters],
            id: 'A',
            name: 'session_started',
          },
        ],
        breakdowns: [
          {
            id: 'A',
            name: 'properties.days_since_first_visit',
          },
        ],
        chartType: 'bar',
        interval,
        range,
        previous: false,
        metric: 'sum',
        limit: 31,
      },
      {
        placeholderData: keepPreviousData,
        staleTime: 1000 * 60 * 1,
      },
    ),
  );

  // Transform to retention curve data
  const retentionData = useMemo(() => {
    if (!query.data?.series || query.data.series.length === 0) {
      return [];
    }

    // Find D0 baseline count (total new users)
    const d0Serie = query.data.series.find((s) => s.names[0] === '0');
    const d0Count = d0Serie?.metrics.sum ?? 0;

    if (d0Count === 0) {
      return [];
    }

    // Calculate retention % for each day
    return query.data.series
      .map((serie) => {
        const day = parseInt(serie.names[0] ?? '', 10);
        if (isNaN(day) || day < 0 || day > 30) {
          return null;
        }
        const count = serie.metrics.sum ?? 0;
        const percentage = (count / d0Count) * 100;

        return {
          day,
          percentage: Math.round(percentage * 10) / 10,
          sessions: count,
          total: d0Count,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => a.day - b.day);
  }, [query.data]);

  const isEmpty = retentionData.length === 0;

  return (
    <Widget className="col-span-6 md:col-span-3">
      <WidgetHead>
        <div className="title">Retention</div>
      </WidgetHead>
      <WidgetBody className="p-3">
        <div className="h-[200px] w-full">
          {query.isLoading ? (
            <div className="h-full w-full animate-pulse rounded bg-def-200" />
          ) : isEmpty ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Not enough data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={retentionData}>
                <defs>
                  <linearGradient id="retentionGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={getChartColor(0)}
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="100%"
                      stopColor={getChartColor(0)}
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal={true}
                  vertical={false}
                  className="stroke-border"
                />
                <XAxis
                  dataKey="day"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `D${value}`}
                  interval="preserveStartEnd"
                />
                <YAxis
                  domain={[0, 100]}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${value}%`}
                  width={35}
                />
                <Tooltip content={<RetentionTooltip />} />
                <Area
                  type="monotone"
                  dataKey="percentage"
                  stroke={getChartColor(0)}
                  strokeWidth={2}
                  fill="url(#retentionGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </WidgetBody>
      <WidgetFooter>
        <div className="px-2 text-xs text-muted-foreground">
          Retention curve based on anonymous cohorts
        </div>
      </WidgetFooter>
    </Widget>
  );
}

interface RetentionTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: {
      day: number;
      percentage: number;
      sessions: number;
      total: number;
    };
  }>;
}

function RetentionTooltip({ active, payload }: RetentionTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const data = payload[0]?.payload;
  if (!data) {
    return null;
  }

  return (
    <div className="rounded-md border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
      <div className="mb-1 text-xs font-medium">Day {data.day}</div>
      <div className="text-sm font-semibold" style={{ color: getChartColor(0) }}>
        {data.percentage.toFixed(1)}% retention
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {data.sessions.toLocaleString()} / {data.total.toLocaleString()} sessions
      </div>
    </div>
  );
}
