import {
  DEFAULT_WIDGETS,
  type OverviewWidgetDef,
} from './overview-widgets';

// === Widget customization ===
// Hide Revenue / Pageviews / Pages-per-session / Bounce Rate metrics, remove Insights widget
const HIDDEN_METRIC_KEYS = ['total_revenue', 'total_screen_views', 'views_per_session', 'bounce_rate'];
const FORK_WIDGETS: OverviewWidgetDef[] = DEFAULT_WIDGETS
  .map(w => (w.key === 'metrics' || w.key === 'weekly-trends')
    ? { ...w, props: { excludeMetricKeys: HIDDEN_METRIC_KEYS } }
    : w)
  .filter(w => w.key !== 'insights');

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return FORK_WIDGETS.filter(w => w.contexts.includes(context));
}
