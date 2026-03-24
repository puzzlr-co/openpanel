import {
  DEFAULT_WIDGETS,
  type OverviewWidgetDef,
} from './overview-widgets';

// === Widget customization ===
// Hide Revenue metric, remove Insights widget
const FORK_WIDGETS: OverviewWidgetDef[] = DEFAULT_WIDGETS
  .map(w => w.key === 'metrics' ? { ...w, props: { excludeMetricKeys: ['total_revenue'] } } : w)
  .filter(w => w.key !== 'insights');

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return FORK_WIDGETS.filter(w => w.contexts.includes(context));
}
