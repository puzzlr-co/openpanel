import { ReportChart } from '@/components/report-chart';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';

import type { IChartType } from '@openpanel/validation';

import { Widget, WidgetBody } from '../widget';
import { WidgetFooter, WidgetHead } from './overview-widget';
import { useOverviewOptions } from './useOverviewOptions';

export interface OverviewHealthMonitorProps {
  projectId: string;
}

export default function OverviewHealthMonitor({
  projectId,
}: OverviewHealthMonitorProps) {
  const { interval, range, previous, startDate, endDate } =
    useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const chartType: IChartType = 'linear';

  return (
    <>
      <Widget className="col-span-6 md:col-span-3 flex flex-col self-stretch">
        <WidgetHead>
          <div className="title">Cohort Breakdown</div>
        </WidgetHead>
        <WidgetBody className="p-3 flex-1">
          <ReportChart
            options={{ hideID: true, columns: ['Day', 'Sessions'] }}
            report={{
              limit: 5,
              projectId,
              startDate,
              endDate,
              events: [
                {
                  segment: 'event',
                  filters: [
                    ...filters,
                    {
                      id: 'days_filter',
                      name: 'properties.days_since_first_visit',
                      operator: 'is',
                      value: ['0', '1', '3', '7', '28'],
                    },
                  ],
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
              chartType,
              lineType: 'monotone',
              interval: interval,
              name: 'Cohort Breakdown',
              range: range,
              previous: false,
              metric: 'sum',
            }}
          />
        </WidgetBody>
        <WidgetFooter>
          <div className="text-xs text-muted-foreground px-2">
            How is my retention funnel performing from the first install (D0)
            all the way to the monthly mark (D28)?
          </div>
        </WidgetFooter>
      </Widget>
    </>
  );
}
