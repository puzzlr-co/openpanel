import OverviewRetention from '@/components/custom/overview-retention';
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
  .flatMap(w => w.key === 'metrics' ? [w, RETENTION] : [w]);

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return FORK_WIDGETS.filter(w => w.contexts.includes(context));
}
