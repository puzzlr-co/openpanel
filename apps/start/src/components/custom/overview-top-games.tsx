/**
 * Top games (fork-only) — lists games by levels started, with levels completed
 * and the play-through rate (completed / started). Built to match the Top events
 * widget: searchable head, the shared overview table, plain numbers, no extra
 * styling. Grouped by game_tag, falling back to game_id when an event has no
 * tag (game_id is present on ~100% of level events); aliases like quiz/quizr
 * stay as separate rows on purpose (merging is a
 * manual data decision, not a display concern). Low rates can be real: quiz
 * fires level_completed only on a perfect run (fail-state game), so its ~6%
 * is honest and not comparable to puzzle games.
 *
 * Data: overview.topGames. Fork-safe (fork-only file, appended endpoints).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { Widget, WidgetBody } from '@/components/widget';
import {
  WidgetFooter,
  WidgetHeadSearchable,
} from '@/components/overview/overview-widget';
import {
  OverviewWidgetTable,
  OverviewWidgetTableLoading,
} from '@/components/overview/overview-widget-table';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';

type GameRow = RouterOutputs['overview']['topGames'][number];

// completed / started, capped at 100%. Some games have instrumentation seams
// where level_completed outran level_started for a while (e.g. shiftr early
// 2026), so within a window completed can exceed started — a >100% rate would
// read as a bug. Same honesty cap the retention widget uses.
const playThroughRate = (g: GameRow) =>
  g.started > 0 ? Math.min(1, g.completed / g.started) : 0;

export default function OverviewTopGames({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const [search, setSearch] = useState('');
  const number = useNumber();
  const trpc = useTRPC();

  const query = useQuery(
    trpc.overview.topGames.queryOptions({
      projectId,
      shareId,
      range,
      startDate,
      endDate,
      filters,
    }),
  );

  // Tiny dataset (≤1000 rows, 15 shown), so plain derivation beats memoization.
  const data = query.data ?? [];
  const maxStarted = Math.max(1, ...data.map((g) => g.started));
  const q = search.trim().toLowerCase();
  const filtered = q
    ? data.filter((g) => g.game_id.toLowerCase().includes(q))
    : data;

  return (
    <Widget className="col-span-6 md:col-span-3">
      <WidgetHeadSearchable
        tabs={[{ key: 'games', label: 'Games' }]}
        activeTab="games"
        onTabChange={() => {}}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search games"
        className="border-b-0 pb-2"
      />
      <WidgetBody className="p-0">
        {query.isLoading ? (
          <OverviewWidgetTableLoading />
        ) : (
          <OverviewWidgetTable
            data={filtered}
            keyExtractor={(g) => g.game_id}
            getColumnPercentage={(g) => g.started / maxStarted}
            columns={[
              {
                name: 'Game',
                width: 'w-full',
                responsive: { priority: 1 },
                getSortValue: (g: GameRow) => g.game_id,
                render(g: GameRow) {
                  return (
                    <div className="row min-w-0 items-center gap-2">
                      <SerieIcon name={g.game_id} />
                      <span className="truncate">{g.game_id}</span>
                    </div>
                  );
                },
              },
              {
                name: 'Started',
                width: '84px',
                responsive: { priority: 2 },
                getSortValue: (g: GameRow) => g.started,
                render: (g: GameRow) => (
                  <span className="font-semibold">
                    {number.short(g.started)}
                  </span>
                ),
              },
              {
                name: 'Completed',
                width: '96px',
                responsive: { priority: 3 },
                getSortValue: (g: GameRow) => g.completed,
                render: (g: GameRow) => (
                  <span className="font-semibold">
                    {number.short(g.completed)}
                  </span>
                ),
              },
              {
                name: 'Completion rate',
                width: '120px',
                responsive: { priority: 2 },
                getSortValue: (g: GameRow) => playThroughRate(g),
                render: (g: GameRow) => (
                  <span className="font-semibold">
                    {Math.round(playThroughRate(g) * 100)}%
                  </span>
                ),
              },
            ]}
          />
        )}
      </WidgetBody>
      <WidgetFooter>
        <div className="flex-1" />
      </WidgetFooter>
    </Widget>
  );
}
