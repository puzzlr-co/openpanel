import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { hashPassword } from '@openpanel/common/server';
import { db } from '@openpanel/db';
import { getRedisCache } from '@openpanel/redis';
import { getOrganizationAccess } from '../../access';
import { TRPCAccessError, TRPCBadRequestError } from '../../errors';
import { protectedProcedure } from '../../trpc';

export const orgSecretProcedures = {
  generateSecret: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw new TRPCAccessError(
          'You do not have access to this organization',
        );
      }

      const org = await db.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
        select: { secret: true },
      });

      if (org.secret) {
        throw new TRPCBadRequestError(
          'Organization already has a secret. Use regenerateSecret to replace it.',
        );
      }

      const plaintext = `sec_${randomBytes(20).toString('hex')}`;
      const hashed = await hashPassword(plaintext);

      await db.organization.update({
        where: { id: input.organizationId },
        data: { secret: hashed },
      });

      return { secret: plaintext };
    }),

  regenerateSecret: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw new TRPCAccessError(
          'You do not have access to this organization',
        );
      }

      const plaintext = `sec_${randomBytes(20).toString('hex')}`;
      const hashed = await hashPassword(plaintext);

      await db.organization.update({
        where: { id: input.organizationId },
        data: { secret: hashed },
      });

      // Flush old auth cache entries for this org
      const redis = getRedisCache();
      const keys = await redis.keys(`org:auth:${input.organizationId}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      return { secret: plaintext };
    }),

  hasSecret: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input }) => {
      const org = await db.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
        select: { secret: true },
      });
      return { hasSecret: !!org.secret };
    }),
};
