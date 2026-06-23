import OverviewRetention from '@/components/custom/overview-retention';
import OverviewTopEventsProperties from '@/components/custom/overview-top-events-properties';
import OverviewTopGames from '@/components/custom/overview-top-games';
import {
  DEFAULT_WIDGETS,
  type OverviewWidgetDef,
} from './overview-widgets';

// === Widget customization ===
// Hide Revenue / Pageviews / Pages-per-session / Bounce Rate metrics, remove
// Insights / Top Sources / Top Pages widgets
const HIDDEN_METRIC_KEYS = ['total_revenue', 'total_screen_views', 'views_per_session', 'bounce_rate'];

// Retention section (Tenure River + Cohort Quality) — honest stock + flow
// signals derived from days_since_first_visit. See
// components/custom/overview-retention.tsx.
const RETENTION: OverviewWidgetDef = {
  key: 'retention',
  component: OverviewRetention,
  contexts: ['dashboard', 'share'],
  lazyViewport: true,
};

// Top games (levels started / completed / play-through rate). Takes the
// top-devices slot so it sits side by side with Top events (see reordering
// below); top-devices moves down to pair with Top geo.
const TOP_GAMES: OverviewWidgetDef = {
  key: 'top-games',
  component: OverviewTopGames,
  contexts: ['dashboard', 'share'],
};

// The top-devices def, re-inserted after top-events. Deferred until it scrolls
// into view: it sits in the bottom content row (paired with Top geo), so on a
// typical viewport it's below the fold — keeping its overview.topGeneric query
// out of the cold-load burst that saturates the 8-core ClickHouse box. Half
// width, so the LazyComponent wrapper must keep its col-span (md:col-span-3).
const TOP_DEVICES: OverviewWidgetDef = {
  ...DEFAULT_WIDGETS.find(w => w.key === 'top-devices')!,
  lazyViewport: true,
  wrapperClassName: 'col-span-6 md:col-span-3',
};

// Widgets removed from the overview entirely:
// - insights (upstream dashboard-only widget)
// - top-sources (Refs/Urls/Types/Source/Medium/Campaign/Term/Content)
// - top-pages (Pages/Entries/Exits)
const REMOVED_WIDGET_KEYS = ['insights', 'top-sources', 'top-pages'];

const FORK_WIDGETS: OverviewWidgetDef[] = DEFAULT_WIDGETS
  .map(w => (w.key === 'metrics' || w.key === 'weekly-trends')
    ? { ...w, props: { excludeMetricKeys: HIDDEN_METRIC_KEYS } }
    : w)
  .filter(w => !REMOVED_WIDGET_KEYS.includes(w.key))
  // insert the retention section right after the metrics widget
  .flatMap(w => w.key === 'metrics' ? [w, RETENTION] : [w])
  // Swap Top games into the top-devices slot and move top-devices after
  // top-events, so Games + Events sit side by side and Devices pairs with Geo.
  .flatMap(w => {
    if (w.key === 'top-devices') return [TOP_GAMES];
    // Swap in the drill-down Events widget (event -> property keys -> values).
    if (w.key === 'top-events') {
      return [{ ...w, component: OverviewTopEventsProperties }, TOP_DEVICES];
    }
    // Top geo (the heaviest cold-load query, overview.map) pairs with Top
    // devices in the bottom row — defer it to viewport too so the heavy map
    // scan leaves the initial burst. Half width like devices.
    if (w.key === 'top-geo') {
      return [{ ...w, lazyViewport: true, wrapperClassName: 'col-span-6 md:col-span-3' }];
    }
    return [w];
  });

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return FORK_WIDGETS.filter(w => w.contexts.includes(context));
}
