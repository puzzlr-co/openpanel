import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { Widget, WidgetBody, WidgetHead, WidgetTitle } from '@/components/widget';

export default function PlaceholderWidget({
  projectId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range } = useOverviewOptions();

  return (
    <Widget className="col-span-6 md:col-span-3">
      <WidgetHead>
        <WidgetTitle>Custom Widget</WidgetTitle>
      </WidgetHead>
      <WidgetBody>
        <p className="text-sm text-muted-foreground">
          Placeholder for fork-specific widgets. Project: {projectId}, Range: {range}
        </p>
      </WidgetBody>
    </Widget>
  );
}
