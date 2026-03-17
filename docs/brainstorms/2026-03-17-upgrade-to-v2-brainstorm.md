# Brainstorm: Upgrade Self-Hosted OpenPanel to v2

**Date:** 2026-03-17
**Status:** Ready for planning

---

## What We're Building

Upgrade the production self-hosted OpenPanel instance (`activity.puzzlr.net`) from v1 (forked 2025-11-15, 27 custom commits) to upstream v2.0.0 (255 commits ahead). The upgrade must preserve live client data, apply breaking changes correctly, and minimize downtime.

## Why This Approach

### Strategy: Fresh Start + Rebuild

**Chosen over** merge (too many conflicts across 255 commits) and official-images-only (need custom code for org secret auth).

**Rationale:**
- 255 upstream commits vs 27 custom commits — rebasing custom work onto upstream is far simpler than merging upstream into the fork
- Most custom commits (games analytics UI, branding, bug fixes) are either obsolete or will be rebuilt from scratch on v2
- The org secret feature is entirely custom (NOT in upstream) — needs full rebuild on v2 with improvements
- v2 switched dashboard from Next.js to Tanstack — old React components are incompatible

### Custom Changes Disposition

| Custom Change | Decision | Reason |
|---|---|---|
| **Org secret auth** | Rebuild on v2 with improvements | Not in upstream at all. Rebuild with SHA-256 cache keys, cache flush on rotation, confirmation dialog |
| **Org secret migration** | Carry forward | Migration file must exist — already recorded in production `_prisma_migrations` |
| **Games analytics UI** | Rebuild later on v2 | v2 switched Next.js → Tanstack; old components incompatible |
| **Decay curve / retention** | Rebuild later or use v2 widgets | v2 has Grafana-style customizable dashboards |
| **Health monitor / KPIs** | Rebuild later or use v2 widgets | Same as above |
| **"Powered by" removal** | Redo on v2 (trivial) | 1-line change |
| **Docker Hub refs** | Redo on v2 | Update build script to `keiwanmosaddegh/*` |
| **Bug fixes** | Drop | Likely fixed upstream in 255 commits |
| **DragonflyDB** | Drop | Dev-only; not in production |
| **Memory tuning** | Re-evaluate | May need re-tuning for v2 |

## Key Decisions

### 1. Fresh start from upstream/main, not merge
Start a new branch from `upstream/main`, rebuild the org secret feature on top. This gives us a clean v2 codebase with minimal, well-understood diff.

### 2. Keep custom Docker images
Continue building `keiwanmosaddegh/openpanel-{api,worker,start}` images. Required for the org secret feature and any future customizations.

### 3. Rebuild org secret with improvements (not cherry-pick)
The org secret is entirely custom — upstream has NO org-level secret concept. Rebuild on v2 with 3 improvements:

**Files to create/modify:**
- `packages/db/prisma/schema.prisma` — add `secret` field to Organization model
- `packages/db/prisma/migrations/20251116134230_add_organization_secret/migration.sql` — carry forward (already in prod DB)
- `apps/api/src/utils/auth.ts` — add org secret fallback in client auth path
- `packages/db/src/services/clients.service.ts` — include organization relation in queries
- `packages/trpc/src/routers/organization.ts` — generateSecret/regenerateSecret endpoints
- `apps/start/src/modals/show-organization-secret.tsx` — rebuild UI modal on Tanstack

**3 improvements over original implementation:**

| # | Fix | Why |
|---|---|---|
| 1 | **SHA-256 hash in Redis cache keys** instead of base64-encoded plaintext | Currently `org:auth:${orgId}:${base64(secret)}` leaks the secret as a Redis key. Use `createHash('sha256').update(secret).digest('hex')` instead |
| 2 | **Flush org auth cache on secret regeneration** | Old secret continues working for 5 min after rotation due to cache TTL. Delete `org:auth:${orgId}:*` keys on regeneration |
| 3 | **Confirmation dialog for regeneration** | Regenerating breaks all server-side integrations instantly. Require typing "REGENERATE" to confirm |

**Validation of the approach:** Industry research confirms single-secret-on-org-table is appropriate for self-hosted analytics at this scale. PostHog uses project-level keys + personal API keys. Mixpanel uses service accounts. Both are heavier than needed here. An API keys table would be over-engineering — only needed if multiple keys per org, per-key scoping, or audit trails are required (they're not).

### 4. Full backup before VPS upgrade
Take complete dumps of Postgres and ClickHouse before any changes. Keep old Docker images available for rollback.

### 5. Clean env var cutover
Remove deprecated `VITE_SELF_HOSTED`, `BATCH_SIZE`, `BATCH_INTERVAL`. Use only v2 env vars. No transition period.

### 6. Games analytics UI deferred
Rebuild from scratch on v2's Tanstack dashboard, or use v2's built-in Grafana-style widget system. Decision deferred until v2 is stable in production.

## v1 → v2 Breaking Changes (Checklist)

### Environment Variables
```diff
- VITE_SELF_HOSTED=true
+ SELF_HOSTED=true

- NEXT_PUBLIC_DASHBOARD_URL=https://activity.puzzlr.net
+ DASHBOARD_URL=https://activity.puzzlr.net

- NEXT_PUBLIC_API_URL=https://activity.puzzlr.net/api
+ API_URL=https://activity.puzzlr.net/api
```

Also remove (no longer needed in v2):
```diff
- BATCH_SIZE=5000
- BATCH_INTERVAL=10000
```

Keep unchanged:
```
NODE_ENV=production
ALLOW_REGISTRATION=false
ALLOW_INVITATION=true
REDIS_URL=redis://op-kv:6379
CLICKHOUSE_URL=http://op-ch:8123/openpanel
DATABASE_URL=postgresql://postgres:postgres@op-db:5432/postgres?schema=public
DATABASE_URL_DIRECT=postgresql://postgres:postgres@op-db:5432/postgres?schema=public
COOKIE_SECRET=<existing value>
RESEND_API_KEY=<existing value>
EMAIL_SENDER=noreply@activity.puzzlr.net
```

### ClickHouse Upgrade (24 → 25)
```diff
- image: clickhouse/clickhouse-server:24.3.2-alpine
+ image: clickhouse/clickhouse-server:25.10.2.65

# Add to op-ch environment:
+ CLICKHOUSE_SKIP_USER_SETUP=1
```

### Docker Images
```diff
- keiwanmosaddegh/openpanel-api:latest
+ keiwanmosaddegh/openpanel-api:2.0.0

- keiwanmosaddegh/openpanel-start:latest
+ keiwanmosaddegh/openpanel-start:2.0.0

- keiwanmosaddegh/openpanel-worker:latest
+ keiwanmosaddegh/openpanel-worker:2.0.0
```

## Database Migrations

### Prisma (Postgres) — 11 new migrations, all additive
1. `add_revenue_tracking_setting_on_project` — adds column to projects
2. `insights` — creates project_insights + insight_events tables
3. `insight_payload_default` — schema refinement
4. `insights` (2nd) — refactors insight columns
5. `report_options` — adds JSONB options to reports + sankey chart type
6. `add_share_dashboard_and_report` — sharing tables
7. `add_share_widget` — widget sharing
8. `onboarding_to_organization` — adds onboarding column
9. `add_unsubscribe_email` — email preferences table
10. `nullable_onboarding` — makes onboarding nullable
11. `gsc` — Google Search Console integration

All additive (new tables/columns). No destructive changes. Auto-run on API startup.

**Special case:** Migration `20251116134230_add_organization_secret` is already recorded in production `_prisma_migrations` table. The migration file MUST exist in the migrations folder or Prisma will error.

### ClickHouse Code Migrations — 7 remaining (5 of 12 already run)

Already completed on VPS: `1-settings`, `2-accounts`, `3-init-ch`, `4-add-sessions`, `5-add-imports-table`

| Migration | Risk | Notes |
|---|---|---|
| **#6** add-revenue-column | Safe | `ADD COLUMN IF NOT EXISTS revenue` on events |
| **#7** migrate-events-to-series | Safe | Postgres-only (report JSON format) |
| **#8 order-keys** | **Medium** | Copies all events (5.7M rows, 212 MB) and sessions (478K rows, 60 MB) to new tables with changed ORDER BY keys. Temporarily doubles disk usage (~350 MB). With 96 GB free, this is fine. Estimated time: **5-15 minutes**. Old tables preserved as backup (`events_20251123`, `sessions_20251123`). |
| **#9** migrate-options | Safe | Postgres-only |
| **#10** add-session-replay | Safe | Creates `session_replay_chunks` table |
| **#12** add-gsc | Safe | Creates 3 GSC tables |

All migrations run automatically on API container startup via `pnpm -r run migrate:deploy`. The migration runner checks the `codeMigration` Postgres table and skips already-completed migrations.

## Migration Procedure (High-Level)

### Phase 1: Local Preparation
1. Create new branch from `upstream/main` (e.g., `v2-upgrade`)
2. Add org secret migration file to `packages/db/prisma/migrations/20251116134230_add_organization_secret/`
3. Add `secret` field to Organization in `schema.prisma`
4. Rebuild org secret auth in `auth.ts` with SHA-256 cache keys
5. Add generateSecret/regenerateSecret to organization tRPC router
6. Rebuild org secret UI modal on Tanstack
7. Update `sh/docker-build` to use `keiwanmosaddegh/*` Docker Hub
8. Build and push v2 Docker images tagged `2.0.0`
9. Test locally with docker-compose

### Phase 2: VPS Backup (READ-ONLY until approved)
1. Postgres dump: `docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > /root/backup-pre-v2.sql`
2. ClickHouse backup: `docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT * FROM openpanel.events FORMAT Native" > /root/backup-events.native` (and sessions, profiles)
3. Copy current `.env` and `docker-compose.yml`: `cp .env .env.backup-pre-v2 && cp docker-compose.yml docker-compose.yml.backup-pre-v2`
4. Record current Docker image IDs: `docker images | grep keiwanmosaddegh > /root/backup-image-ids.txt`

### Phase 3: VPS Upgrade
1. Update `.env` (rename vars, remove deprecated ones, keep secrets)
2. Update `docker-compose.yml`:
   - ClickHouse `24.3.2-alpine` → `25.10.2.65`
   - Add `CLICKHOUSE_SKIP_USER_SETUP=1`
   - Image tags `latest` → `2.0.0`
3. `./stop` all services
4. `docker compose pull` new images
5. `./start` — Prisma + ClickHouse code migrations auto-run
6. Monitor logs: `docker compose logs -f op-api` for migration progress
7. Expect migration #8 to take 5-15 minutes (copies events + sessions tables)

### Phase 4: Verification
1. Dashboard loads at `https://activity.puzzlr.net`
2. API healthcheck: `curl https://activity.puzzlr.net/api/healthcheck`
3. Verify existing data is visible (events, sessions, profiles)
4. Test SDK event ingestion from a client
5. Verify org secret auth still works (test with org secret + project ID)
6. Check ClickHouse tables: `SELECT count() FROM events` matches pre-upgrade count

### Rollback Plan
If anything fails:
1. `./stop`
2. `cp .env.backup-pre-v2 .env && cp docker-compose.yml.backup-pre-v2 docker-compose.yml`
3. If Postgres migrations failed: `docker exec self-hosting-op-db-1 psql -U postgres postgres < /root/backup-pre-v2.sql`
4. If ClickHouse is corrupted: restore from Native format backups
5. `./start` (will use old images referenced in backup docker-compose.yml)

## Production Environment Reference

| Component | Current | Target |
|---|---|---|
| Domain | `activity.puzzlr.net` | Same |
| ClickHouse | 24.3.2-alpine | 25.10.2.65 |
| PostgreSQL | 14-alpine | 14-alpine (no change) |
| Redis | 7.2.5-alpine | 7.2.5-alpine (no change) |
| Caddy | 2-alpine | 2-alpine (no change) |
| Workers | 4 replicas | 4 replicas |
| API images | keiwanmosaddegh/*:latest | keiwanmosaddegh/*:2.0.0 |
| Events | 5.7M rows, 212 MB | Same (migrated to new ORDER BY) |
| Sessions | 478K rows, 60 MB | Same (migrated to new ORDER BY) |
| Disk free | 96 GB | 96 GB (migration needs ~350 MB temp) |

## Resolved Questions

1. **ClickHouse schema migrations in v2** — Resolved. 7 remaining code migrations will run automatically. Migration #8 (order-keys) is the heaviest — copies all events/sessions to new tables. With 5.7M events and 96 GB free disk, estimated 5-15 minutes. Low risk.

2. **Org secret approach validation** — Resolved. Single-secret-on-org-table is appropriate for self-hosted analytics at this scale. Industry research confirms this (PostHog, Mixpanel, Stripe use similar patterns). Over-engineering with API keys table not justified.

3. **Org secret in upstream** — Resolved. It is NOT in upstream v2 at all. Full rebuild required: schema, migration, auth logic, tRPC endpoints, UI modal.

## Open Questions

1. **v2 Grafana-style dashboards vs custom games UI** — Can v2's built-in widget system reproduce the decay curve, health monitor, and game filter functionality? Needs hands-on evaluation after upgrade is complete.
