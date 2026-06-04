/**
 * Events widget with in-page property drill-down (fork-only).
 *
 * Replaces the upstream Top events widget. The Events / Conversions list works
 * exactly as before, but clicking an event now drills *within the card* instead
 * of navigating out to the events explorer:
 *
 *   events  ->  property keys for that event  ->  value distribution for a key
 *
 * Each level reuses the shared overview table (volume bars, sortable columns),
 * so it reads as native Openpanel. Property data is range- and filter-scoped via
 * overview.topEventPropertyKeys / topEventPropertyValues (share-safe). An
 * "open in explorer" escape hatch in the breadcrumb preserves the old behavior
 * (dashboard only — not available in the public share context).
 *
 * The header also carries a compact "All games" Combobox (right of the
 * Events/Conversions tabs) that filters this card — and its drill-down — by a
 * single game. The game list comes from overview.topGames; the chosen game is
 * merged into the queries as a `properties.game_id` filter (widget-local React
 * state, not the global overview filter). Requires 'properties.game_id' on
 * WHITELISTED_FILTERS in overview.service.ts, otherwise the filter is dropped.
 *
 * Drill-down was chosen (2026-06-03) over inline-expand and popover-peek
 * variants — it reuses the real overview table so it reads as native, and maps
 * 1:1 to the data model (event -> property key -> values). Fork-safe: upstream
 * overview/overview-top-events.tsx is untouched; this file is swapped into the
 * top-events slot in config/overview-widgets.fork.ts.
 */
import {
  eventQueryFiltersParser,
  useEventQueryFilters,
} from '@/hooks/use-event-query-filters';
import { useAppParams } from '@/hooks/use-app-params';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { Combobox } from '@/components/ui/combobox';
import { Widget, WidgetBody } from '@/components/widget';
import { WidgetFooter } from '@/components/overview/overview-widget';
import {
  type EventTableItem,
  OverviewWidgetTable,
  OverviewWidgetTableEvents,
  OverviewWidgetTableLoading,
} from '@/components/overview/overview-widget-table';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { useOverviewWidgetV2 } from '@/components/overview/useOverviewWidget';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@/utils/cn';
import {
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GamepadIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';

type PropertyKeyRow = RouterOutputs['overview']['topEventPropertyKeys'][number];
type PropertyValueRow =
  RouterOutputs['overview']['topEventPropertyValues'][number];

type DrillView =
  | { level: 'events' }
  | { level: 'props'; event: EventTableItem }
  | { level: 'values'; event: EventTableItem; propertyKey: string };

// Property filter that scopes this card (and its drill-down) to one game.
const GAME_FILTER = 'properties.game_id';

export default function OverviewTopEventsProperties({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const { organizationId } = useAppParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<DrillView>({ level: 'events' });
  const [game, setGame] = useState('');

  // Global overview filters minus any game filter — the widget owns game
  // scoping locally, so we always start from the un-gamed set.
  const baseFilters = useMemo(
    () => filters.filter((f) => f.name !== GAME_FILTER),
    [filters],
  );

  // Games for the picker. Built from baseFilters so the list never collapses
  // to the selected game (which would make it impossible to switch).
  const gamesQuery = useQuery(
    trpc.overview.topGames.queryOptions({
      projectId,
      shareId,
      range,
      startDate,
      endDate,
      filters: baseFilters,
    }),
  );

  const gameItems = useMemo(
    () => [
      { value: '', label: 'All games' },
      ...(gamesQuery.data ?? []).map((g) => ({
        value: g.game_id,
        label: g.game_id,
      })),
    ],
    [gamesQuery.data],
  );

  // Scope this card (and its drill-down) to the selected game, if any.
  const eventFilters = useMemo(
    () =>
      game
        ? [
            ...baseFilters,
            {
              id: GAME_FILTER,
              name: GAME_FILTER,
              operator: 'is' as const,
              value: [game],
            },
          ]
        : baseFilters,
    [baseFilters, game],
  );

  const { data: conversions } = useQuery(
    trpc.overview.topConversions.queryOptions({ projectId, shareId }),
  );

  const [widget, setWidget, widgets] = useOverviewWidgetV2('ev', {
    your: {
      title: 'Events',
      btn: 'Events',
      meta: { type: 'events' as const },
    },
    conversions: {
      title: 'Conversions',
      btn: 'Conversions',
      hide: !conversions || conversions.length === 0,
      meta: { type: 'conversions' as const },
    },
  });

  const eventsQuery = useQuery(
    trpc.overview.topEvents.queryOptions({
      projectId,
      shareId,
      range,
      startDate,
      endDate,
      filters: eventFilters,
      excludeEvents:
        widget.meta?.type === 'events'
          ? ['session_start', 'session_end', 'screen_view']
          : undefined,
    }),
  );

  const drillEvent = view.level === 'events' ? null : view.event;

  const propsQuery = useQuery({
    ...trpc.overview.topEventPropertyKeys.queryOptions({
      projectId,
      shareId,
      eventName: drillEvent?.name ?? '',
      range,
      startDate,
      endDate,
      filters: eventFilters,
    }),
    enabled: !!drillEvent,
  });

  const valuesQuery = useQuery({
    ...trpc.overview.topEventPropertyValues.queryOptions({
      projectId,
      shareId,
      eventName: drillEvent?.name ?? '',
      propertyKey: view.level === 'values' ? view.propertyKey : '',
      range,
      startDate,
      endDate,
      filters: eventFilters,
    }),
    enabled: view.level === 'values',
  });

  const tableData: EventTableItem[] = useMemo(() => {
    if (!eventsQuery.data) {
      return [];
    }

    let items = eventsQuery.data;
    if (widget.meta?.type === 'conversions' && conversions) {
      const conversionNames = new Set(conversions.map((c) => c.name));
      items = items.filter((item) => conversionNames.has(item.name));
    }

    return items.map((item) => ({
      id: item.name,
      name: item.name,
      count: item.count,
    }));
  }, [eventsQuery.data, widget.meta?.type, conversions]);

  const filteredData = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return tableData;
    }
    return tableData.filter((item) => item.name?.toLowerCase().includes(q));
  }, [tableData, searchQuery]);

  const tabs = useMemo(
    () =>
      widgets
        .filter((item) => item.hide !== true)
        .map((w) => ({ key: w.key, label: w.btn })),
    [widgets],
  );

  return (
    <Widget className="col-span-6 md:col-span-3">
      {view.level === 'events' ? (
        // Custom head matching WidgetHeadSearchable, plus a game picker on the
        // right (WidgetHeadSearchable has no right-side slot for it).
        <div className="border-border border-b pb-2">
          <div className="row items-center justify-between gap-2 px-2 pt-2">
            <div className="row min-w-0 gap-1 overflow-x-auto hide-scrollbar">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setWidget(tab.key)}
                  className={cn(
                    'shrink-0 rounded-md px-2 py-1.5 font-medium text-sm transition-colors',
                    widget.key === tab.key
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-def-100 hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <Combobox
              searchable
              size="sm"
              align="end"
              icon={GamepadIcon}
              placeholder="All games"
              className="h-7 shrink-0 text-xs"
              items={gameItems}
              value={game || null}
              onChange={setGame}
            />
          </div>
          <div className="relative mt-2">
            <input
              type="search"
              placeholder={`Search ${widget.btn.toLowerCase()}`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full border-y bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
            />
          </div>
        </div>
      ) : (
        <div className="row items-center gap-2 border-border border-b p-3">
          <button
            type="button"
            onClick={() =>
              setView(
                view.level === 'values'
                  ? { level: 'props', event: view.event }
                  : { level: 'events' },
              )
            }
            className="row shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted-foreground text-sm hover:bg-def-100 hover:text-foreground"
          >
            <ChevronLeftIcon className="size-4" />
            Back
          </button>
          <div className="row min-w-0 flex-1 items-center gap-1.5 truncate text-sm">
            <SerieIcon name={view.event.name} />
            <span className="truncate font-medium">{view.event.name}</span>
            {view.level === 'values' && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="truncate font-mono text-muted-foreground">
                  {view.propertyKey}
                </span>
              </>
            )}
          </div>
          {!shareId && (
            <button
              type="button"
              title="Open in events explorer"
              onClick={() =>
                navigate({
                  to: '/$organizationId/$projectId/events/events',
                  params: { organizationId, projectId },
                  search: {
                    f: eventQueryFiltersParser.serialize([
                      {
                        id: 'name',
                        name: 'name',
                        operator: 'is',
                        value: [view.event.name],
                      },
                    ]),
                  },
                })
              }
              className="row shrink-0 items-center rounded-md p-1 text-muted-foreground hover:bg-def-100 hover:text-foreground"
            >
              <ExternalLinkIcon className="size-4" />
            </button>
          )}
        </div>
      )}

      <WidgetBody className="p-0">
        {view.level === 'events' ? (
          eventsQuery.isLoading ? (
            <OverviewWidgetTableLoading />
          ) : (
            <OverviewWidgetTableEvents
              data={filteredData}
              onItemClick={(name) => {
                const event = tableData.find((e) => e.name === name);
                if (event) {
                  setView({ level: 'props', event });
                }
              }}
            />
          )
        ) : view.level === 'props' ? (
          <DistributionTable
            isLoading={propsQuery.isLoading}
            data={propsQuery.data ?? []}
            emptyText="No properties"
            labelHeader="Property"
            countHeader="Events"
            labelOf={(p: PropertyKeyRow) => p.key}
            countOf={(p: PropertyKeyRow) => p.count}
            renderLabel={(p: PropertyKeyRow) => (
              <div className="row min-w-0 items-center gap-2">
                <BracesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="row min-w-0 items-center gap-1 truncate font-mono"
                  onClick={() =>
                    setView({
                      level: 'values',
                      event: view.event,
                      propertyKey: p.key,
                    })
                  }
                >
                  <span className="truncate">{p.key}</span>
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </div>
            )}
          />
        ) : (
          <DistributionTable
            isLoading={valuesQuery.isLoading}
            data={valuesQuery.data ?? []}
            emptyText="No values"
            labelHeader="Value"
            countHeader="Count"
            labelOf={(v: PropertyValueRow) => v.value}
            countOf={(v: PropertyValueRow) => v.count}
            renderLabel={(v: PropertyValueRow) => (
              <span className="truncate">{v.value}</span>
            )}
          />
        )}
      </WidgetBody>
      <WidgetFooter>
        <div className="flex-1" />
      </WidgetFooter>
    </Widget>
  );
}

/**
 * A label + count table with volume bars — the drill-down levels (property keys
 * and property values) are the same shape, only the labels and the cell render
 * differ.
 */
function DistributionTable<T>({
  isLoading,
  data,
  emptyText,
  labelHeader,
  countHeader,
  labelOf,
  countOf,
  renderLabel,
}: {
  isLoading: boolean;
  data: T[];
  emptyText: string;
  labelHeader: string;
  countHeader: string;
  labelOf: (item: T) => string;
  countOf: (item: T) => number;
  renderLabel: (item: T) => React.ReactNode;
}) {
  const number = useNumber();

  if (isLoading) {
    return <OverviewWidgetTableLoading />;
  }
  if (data.length === 0) {
    return (
      <div className="flex min-h-[358px] items-center justify-center text-muted-foreground text-sm">
        {emptyText}
      </div>
    );
  }

  const maxCount = Math.max(1, ...data.map(countOf));

  return (
    <OverviewWidgetTable
      data={data}
      keyExtractor={labelOf}
      getColumnPercentage={(item) => countOf(item) / maxCount}
      columns={[
        {
          name: labelHeader,
          width: 'w-full',
          responsive: { priority: 1 },
          getSortValue: labelOf,
          render: renderLabel,
        },
        {
          name: countHeader,
          width: '84px',
          responsive: { priority: 2 },
          getSortValue: countOf,
          render: (item) => (
            <span className="font-semibold">{number.short(countOf(item))}</span>
          ),
        },
      ]}
    />
  );
}
