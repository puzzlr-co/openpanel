import { ShareEnterPassword } from '@/components/auth/share-enter-password';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { LiveCounter } from '@/components/overview/live-counter';
import { OverviewControls } from '@/components/overview/overview-controls';
import { OverviewGrid } from '@/components/overview/overview-grid';
import { useTRPC } from '@/integrations/trpc/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useSearch } from '@tanstack/react-router';
import { z } from 'zod';

const shareSearchSchema = z.object({
  header: z.optional(z.number().or(z.string().or(z.boolean()))),
  range: z.optional(z.string()),
  start: z.optional(z.string()),
  end: z.optional(z.string()),
  overrideInterval: z.optional(z.string()),
  metric: z.optional(z.number()),
  f: z.optional(z.string()),
  events: z.optional(z.array(z.string())),
});

export const Route = createFileRoute('/share/overview/$shareId')({
  component: RouteComponent,
  validateSearch: shareSearchSchema,
  loader: async ({ context, params }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.share.overview.queryOptions({
        shareId: params.shareId,
      }),
    );
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
        <div className="mx-auto max-w-7xl row gap-4 p-4 pb-0">
          <div className="col gap-1">
            <span className="text-sm">{share.organization?.name}</span>
            <h1 className="text-xl font-medium">{share.project?.name}</h1>
          </div>
        </div>
      )}
      <div className="mx-auto max-w-7xl">
        <OverviewControls
          projectId={projectId}
          rightContent={<LiveCounter projectId={projectId} />}
        />
        <OverviewGrid projectId={projectId} />
      </div>
    </div>
  );
}
