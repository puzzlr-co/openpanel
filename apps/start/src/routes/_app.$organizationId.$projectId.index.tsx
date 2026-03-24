import { Fragment } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { LazyComponent } from '@/components/lazy-component';
import { useRangePageContext } from '@/hooks/use-page-context-helpers';
import {
  OverviewFilterButton,
  OverviewFiltersButtons,
} from '@/components/overview/filters/overview-filters-buttons';
import { OverviewAICommand } from '@/components/overview/overview-ai-command';
import { LiveCounter } from '@/components/overview/live-counter';
import { OverviewInterval } from '@/components/overview/overview-interval';
import { OverviewRange } from '@/components/overview/overview-range';
import { OverviewShare } from '@/components/overview/overview-share';
import { getWidgets } from '@/config/overview-widgets.fork';
import { createProjectTitle, PAGE_TITLES } from '@/utils/title';

export const Route = createFileRoute('/_app/$organizationId/$projectId/')({
  component: ProjectDashboard,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle(PAGE_TITLES.DASHBOARD),
        },
      ],
    };
  },
});

function ProjectDashboard() {
  const { projectId } = Route.useParams();
  useRangePageContext('overview');
  return (
    <div>
      <div className="sticky-header -top-px!">
        <div className="col gap-2 p-4">
          <div className="flex justify-between gap-2">
            <div className="flex gap-2">
              <OverviewRange />
              <OverviewInterval />
              <OverviewFilterButton mode="events" />
              <OverviewAICommand className="hidden w-[280px] md:block" />
            </div>
            <div className="flex gap-2">
              <LiveCounter projectId={projectId} />
              <OverviewShare projectId={projectId} />
            </div>
          </div>
          <OverviewFiltersButtons />
        </div>
      </div>
      <div className="grid grid-cols-6 gap-4 p-4 pt-0">
        {getWidgets('dashboard').map(widget => {
          const Widget = widget.component;
          const el = <Widget projectId={projectId} {...widget.props} />;
          return widget.lazyViewport ? (
            <LazyComponent key={widget.key} className="col-span-6">{el}</LazyComponent>
          ) : (
            <Fragment key={widget.key}>{el}</Fragment>
          );
        })}
      </div>
    </div>
  );
}
