import { Fragment } from 'react';
import { ShareEnterPassword } from '@/components/auth/share-enter-password';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { LazyComponent } from '@/components/lazy-component';
import { LoginNavbar } from '@/components/login-navbar';
import { OverviewFiltersButtons } from '@/components/overview/filters/overview-filters-buttons';
import { LiveCounter } from '@/components/overview/live-counter';
import { OverviewRange } from '@/components/overview/overview-range';
import { getWidgets } from '@/config/overview-widgets.fork';
import { useTRPC } from '@/integrations/trpc/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useSearch } from '@tanstack/react-router';
import { z } from 'zod';

const shareSearchSchema = z.object({
  header: z.optional(z.number().or(z.string().or(z.boolean()))),
});

export const Route = createFileRoute('/share/overview/$shareId')({
  component: RouteComponent,
  validateSearch: shareSearchSchema,
  loader: async ({ context, params }) => {
    const share = await context.queryClient.ensureQueryData(
      context.trpc.share.overview.queryOptions({
        shareId: params.shareId,
      }),
    );

    return { share };
  },
  head: ({ loaderData }) => {
    if (!loaderData || !loaderData.share) {
      return {
        meta: [
          {
            title: 'Share not found - OpenPanel.dev',
          },
        ],
      };
    }

    return {
      meta: [
        {
          title: `${loaderData.share.project?.name} - ${loaderData.share.organization?.name} - OpenPanel.dev`,
        },
      ],
    };
  },
  pendingComponent: FullPageLoadingState,
  errorComponent: () => (
    <FullPageEmptyState
      title="Share not found"
      description="The overview you are looking for does not exist."
      className="min-h-[calc(100vh-theme(spacing.16))]"
    />
  ),
});

function RouteComponent() {
  const { shareId } = Route.useParams();
  const { header } = useSearch({ from: '/share/overview/$shareId' });
  const trpc = useTRPC();
  const shareQuery = useSuspenseQuery(
    trpc.share.overview.queryOptions({
      shareId,
    }),
  );

  const hasAccess = shareQuery.data?.hasAccess;
  // Check if share exists and is public
  if (shareQuery.isLoading) {
    return <div>Loading...</div>;
  }

  if (!shareQuery.data) {
    throw notFound();
  }

  if (!shareQuery.data.public) {
    throw notFound();
  }

  const share = shareQuery.data;
  const projectId = share.projectId;

  // Handle password protection
  if (share.password && !hasAccess) {
    return <ShareEnterPassword shareId={share.id} />;
  }

  const isHeaderVisible =
    header !== '0' && header !== 0 && header !== 'false' && header !== false;

  return (
    <div>
      {isHeaderVisible && (
        <div className="mx-auto max-w-7xl">
          <LoginNavbar className="relative p-4" />
        </div>
      )}
      <div className="sticky-header [animation-range:50px_100px]!">
        <div className="p-4 col gap-2 mx-auto max-w-7xl">
          <div className="row justify-between">
            <div className="flex gap-2">
              <OverviewRange />
            </div>
            <div className="flex gap-2">
              <LiveCounter projectId={projectId} shareId={shareId} />
            </div>
          </div>
          <OverviewFiltersButtons />
        </div>
      </div>
      <div className="mx-auto grid max-w-7xl grid-cols-6 gap-4 p-4">
        {getWidgets('share').map(widget => {
          const Widget = widget.component;
          const el = <Widget projectId={projectId} shareId={shareId} {...widget.props} />;
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
