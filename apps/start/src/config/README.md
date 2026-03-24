# Overview Widget Config

This repo is a fork of [OpenPanel](https://github.com/Openpanel-dev/openpanel). This config layer lets us customize the overview page without editing upstream files — fork-specific changes live in separate files that don't exist upstream, so pulls merge cleanly.

## Files

```
config/
  overview-widgets.ts        # Defaults. All 9 upstream widgets + types. DON'T EDIT for fork customization.
  overview-widgets.fork.ts   # Fork overrides. Routes import from here. Edit this.
components/
  custom/                    # Fork-only widget components. Never exists upstream.
    placeholder-widget.tsx   # Template — copy this to make a new widget.
```

Both routes (`_app.$organizationId.$projectId.index.tsx`, `share.overview.$shareId.tsx`) import `getWidgets` from the fork file.

## How it works

`getWidgets(context)` returns an `OverviewWidgetDef[]`. Each def has:

| Field | Purpose |
|-------|---------|
| `key` | Unique ID, used as React key |
| `component` | React component. Must accept `{ projectId: string; shareId?: string }` |
| `contexts` | `['dashboard']`, `['share']`, or both. Controls which page renders it |
| `lazyViewport?` | Wraps in `LazyComponent` (viewport-based lazy load) |
| `props?` | Extra props spread onto the component |

Routes render the list in a `grid-cols-6` container. Each widget controls its own sizing: `col-span-3` = half width, `col-span-6` = full width.

## Common tasks

**Hide a widget:**
```ts
// overview-widgets.fork.ts
.filter(w => w.key !== 'insights')
```

**Hide a metric (within the metrics widget):**
```ts
.map(w => w.key === 'metrics' ? { ...w, props: { excludeMetricKeys: ['total_revenue'] } } : w)
```
Valid keys: `unique_visitors`, `total_sessions`, `total_screen_views`, `views_per_session`, `bounce_rate`, `avg_session_duration`, `total_revenue`

**Add a custom widget:**
1. Create component in `components/custom/` (copy `placeholder-widget.tsx`)
2. Must accept `{ projectId: string; shareId?: string }`
3. Use `useOverviewOptions()` for range/interval/dates, `useEventQueryFilters()` for filters
4. Use `Widget`/`WidgetHead`/`WidgetBody` from `@/components/widget`
5. Set own grid size via `col-span-*` class on root element
6. Add to fork config:
```ts
import MyWidget from '@/components/custom/my-widget';

const FORK_WIDGETS: OverviewWidgetDef[] = [
  ...DEFAULT_WIDGETS.filter(w => w.key !== 'insights'),
  { key: 'my-widget', component: MyWidget, contexts: ['dashboard'] },
];
```

**Reorder widgets:** Rebuild the array in desired order instead of using `DEFAULT_WIDGETS` spread.

**Switch back to upstream defaults:** Change route imports from `overview-widgets.fork` to `overview-widgets`.

## Two contexts

Dashboard page has toolbar (range, interval, filters, live counter, share button). Share page is public, may be password-protected, has no Insights. Set `contexts: ['dashboard']` for widgets that need auth or dashboard-only features.

## Custom widget data sources

Prefer existing tRPC endpoints:
- `overview.topGeneric` — top-N by any column
- `overview.topGenericSeries` — time series for any breakdown
- `overview.stats` — the 7 standard metrics + series

See `components/overview/overview-top-sources.tsx` for full widget lifecycle pattern.
