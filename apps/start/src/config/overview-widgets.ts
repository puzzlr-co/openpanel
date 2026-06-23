import type { ComponentType } from 'react';
import OverviewInsights from '@/components/overview/overview-insights';
import OverviewMetrics from '@/components/overview/overview-metrics';
import OverviewTopDevices from '@/components/overview/overview-top-devices';
import OverviewTopEvents from '@/components/overview/overview-top-events';
import OverviewTopGeo from '@/components/overview/overview-top-geo';
import OverviewTopPages from '@/components/overview/overview-top-pages';
import OverviewTopSources from '@/components/overview/overview-top-sources';
import OverviewUserJourney from '@/components/overview/overview-user-journey';
import OverviewWeeklyTrends from '@/components/overview/overview-weekly-trends';

export interface OverviewWidgetDef {
  key: string;
  component: ComponentType<{ projectId: string; shareId?: string }>;
  contexts: ('dashboard' | 'share')[];
  /** Wrap in LazyComponent for viewport-based lazy rendering */
  lazyViewport?: boolean;
  /**
   * Grid class for the LazyComponent wrapper (the grid item) when `lazyViewport`
   * is set. Defaults to `col-span-6`. Set this to match the inner widget's own
   * col-span (e.g. `col-span-6 md:col-span-3`) so deferring a half-width widget
   * doesn't force it full-width.
   */
  wrapperClassName?: string;
  /** Extra props spread onto the component */
  props?: Record<string, unknown>;
}

export const DEFAULT_WIDGETS: OverviewWidgetDef[] = [
  { key: 'metrics', component: OverviewMetrics, contexts: ['dashboard', 'share'] },
  { key: 'insights', component: OverviewInsights, contexts: ['dashboard'] },
  { key: 'top-sources', component: OverviewTopSources, contexts: ['dashboard', 'share'] },
  { key: 'top-pages', component: OverviewTopPages, contexts: ['dashboard', 'share'] },
  { key: 'top-devices', component: OverviewTopDevices, contexts: ['dashboard', 'share'] },
  { key: 'top-events', component: OverviewTopEvents, contexts: ['dashboard', 'share'] },
  { key: 'top-geo', component: OverviewTopGeo, contexts: ['dashboard', 'share'] },
  { key: 'weekly-trends', component: OverviewWeeklyTrends, contexts: ['dashboard', 'share'], lazyViewport: true },
  { key: 'user-journey', component: OverviewUserJourney, contexts: ['dashboard', 'share'], lazyViewport: true },
];

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return DEFAULT_WIDGETS.filter(w => w.contexts.includes(context));
}
