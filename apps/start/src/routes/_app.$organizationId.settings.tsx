import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { pushModal } from '@/modals';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import DeleteOrganization from '@/components/settings/delete-organization';
import { Input } from '@/components/ui/input';
import { Widget, WidgetBody, WidgetHead } from '@/components/widget';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createOrganizationTitle } from '@/utils/title';
import { zEditOrganization } from '@openpanel/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

const validator = zEditOrganization;

type IForm = z.infer<typeof validator>;

export const Route = createFileRoute('/_app/$organizationId/settings')({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createOrganizationTitle(PAGE_TITLES.SETTINGS),
        },
      ],
    };
  },
});

function Component() {
  const { organizationId } = Route.useParams();
  const trpc = useTRPC();
  const {
    data: organization,
    isLoading,
    refetch,
  } = useQuery(
    trpc.organization.get.queryOptions({
      organizationId,
    }),
  );

  if (isLoading) {
    return <FullPageLoadingState />;
  }

  if (!organization) {
    return <FullPageEmptyState title="Organization not found" />;
  }

  const { register, handleSubmit, formState, reset, control } = useForm<IForm>({
    defaultValues: {
      id: organization.id,
      name: organization.name,
      timezone: organization.timezone ?? undefined,
    },
  });

  const mutation = useMutation(
    trpc.organization.update.mutationOptions({
      onSuccess(res) {
        toast('Organization updated', {
          description: 'Your organization has been updated.',
        });
        reset({
          ...res,
          timezone: res.timezone!,
        });
        refetch();
      },
      onError: handleError,
    }),
  );

  return (
    <div className="container p-8">
      <PageHeader
        title="Workspace settings"
        description="Manage your workspace settings here"
        className="mb-8"
      />

      <form
        onSubmit={handleSubmit((values) => {
          mutation.mutate(values);
        })}
      >
        <Widget>
          <WidgetHead className="flex items-center justify-between">
            <span className="title">Details</span>
          </WidgetHead>
          <WidgetBody className="gap-4 col">
            <InputWithLabel
              className="flex-1"
              label="Name"
              {...register('name')}
              defaultValue={organization?.name}
            />
            <Controller
              name="timezone"
              control={control}
              render={({ field }) => (
                <WithLabel label="Timezone">
                  <Combobox
                    placeholder="Select timezone"
                    items={Intl.supportedValuesOf('timeZone').map((item) => ({
                      value: item,
                      label: item,
                    }))}
                    value={field.value}
                    onChange={field.onChange}
                    className="w-full"
                  />
                </WithLabel>
              )}
            />
            <Button
              size="sm"
              type="submit"
              disabled={!formState.isDirty}
              className="self-end"
            >
              Save
            </Button>
          </WidgetBody>
        </Widget>
      </form>

      <OrganizationSecret organizationId={organizationId} />

      <div className="mt-8">
        <DeleteOrganization organization={organization} />
      </div>
    </div>
  );
}

function OrganizationSecret({
  organizationId,
}: {
  organizationId: string;
}) {
  const trpc = useTRPC();
  const { data, refetch } = useQuery(
    trpc.organization.hasSecret.queryOptions({ organizationId }),
  );
  const [confirmText, setConfirmText] = useState('');

  const generateMutation = useMutation(
    trpc.organization.generateSecret.mutationOptions({
      onSuccess(res) {
        pushModal('ShowOrganizationSecret', { secret: res.secret });
        refetch();
      },
      onError: handleError,
    }),
  );

  const regenerateMutation = useMutation(
    trpc.organization.regenerateSecret.mutationOptions({
      onSuccess(res) {
        pushModal('ShowOrganizationSecret', { secret: res.secret });
        refetch();
        setConfirmText('');
      },
      onError: handleError,
    }),
  );

  const hasSecret = data?.hasSecret ?? false;

  return (
    <Widget className="mt-8">
      <WidgetHead className="flex items-center justify-between">
        <span className="title">Organization Secret</span>
      </WidgetHead>
      <WidgetBody className="gap-4 col">
        <p className="text-sm text-muted-foreground">
          An organization secret allows server-side SDKs to authenticate using
          any project ID in this organization. Use it as the{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            openpanel-client-secret
          </code>{' '}
          header.
        </p>
        {!hasSecret ? (
          <Button
            size="sm"
            className="self-start"
            onClick={() => generateMutation.mutate({ organizationId })}
            loading={generateMutation.isPending}
          >
            Generate Secret
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              A secret has been generated for this organization.
            </p>
            <p className="text-sm text-muted-foreground">
              Type <strong>REGENERATE</strong> to confirm. This will
              immediately invalidate the current secret and break any
              integrations using it.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder='Type "REGENERATE" to confirm'
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="max-w-xs"
              />
              <Button
                size="sm"
                variant="destructive"
                disabled={confirmText !== 'REGENERATE'}
                onClick={() =>
                  regenerateMutation.mutate({ organizationId })
                }
                loading={regenerateMutation.isPending}
              >
                Regenerate Secret
              </Button>
            </div>
          </div>
        )}
      </WidgetBody>
    </Widget>
  );
}
