---
title: "feat: Upgrade Self-Hosted OpenPanel v1 to v2"
type: feat
status: active
date: 2026-03-17
origin: docs/brainstorms/2026-03-17-upgrade-to-v2-brainstorm.md
---

# Upgrade Self-Hosted OpenPanel v1 to v2

## Overview

Upgrade the production self-hosted OpenPanel instance (`activity.puzzlr.net`) from a v1 fork (27 custom commits, diverged 2025-11-15) to upstream v2.0.0 (255 commits ahead). Strategy: fresh start from `upstream/main`, rebuild the org secret auth feature with improvements, build custom Docker images, deploy to production VPS with full backup and rollback capability.

**Production constraints:** Live clients sending events. 5.7M events, 478K sessions, 416K profiles. 96 GB free disk. Zero data loss tolerance on existing data.

## Problem Statement / Motivation

The fork is 255 commits behind upstream. v2 brings a redesigned Tanstack dashboard, revenue tracking, session replay, customizable Grafana-style dashboards, Google Search Console integration, and significant bug fixes. Staying on v1 means missing these features and accumulating drift that makes future upgrades harder.

(see brainstorm: docs/brainstorms/2026-03-17-upgrade-to-v2-brainstorm.md — Strategy: Fresh Start + Rebuild)

## Technical Approach

### Architecture

No architectural changes — same 6-service Docker Compose stack. Key version bumps:

| Component | v1 (current) | v2 (target) |
|---|---|---|
| ClickHouse | 24.3.2-alpine | 25.10.2.65 |
| Dashboard framework | Next.js | TanStack Start |
| Docker images | `keiwanmosaddegh/*:latest` | `keiwanmosaddegh/*:2.0.0` |

### Implementation Phases

---

#### Phase 1: Local Preparation

##### 1.1 Create v2 branch from upstream [x]

```bash
cd /Users/keiwanmosaddegh/development/experiments/openpanel
git fetch upstream
git checkout -b v2-upgrade upstream/main
```

##### 1.2 Carry forward org secret Prisma migration [x]

The migration `20251116134230_add_organization_secret` is already recorded in the production `_prisma_migrations` table. Prisma will error if the file doesn't exist.

**Verified:** All pre-existing migration file checksums match between fork and upstream — no conflicts.

```bash
# Copy migration file from current branch
mkdir -p packages/db/prisma/migrations/20251116134230_add_organization_secret
git show main:packages/db/prisma/migrations/20251116134230_add_organization_secret/migration.sql > \
  packages/db/prisma/migrations/20251116134230_add_organization_secret/migration.sql
```

##### 1.3 Add `secret` field to Organization in schema.prisma [x]

`packages/db/prisma/schema.prisma` — add to Organization model:

```prisma
model Organization {
  // ... existing fields ...
  secret          String?   // Bcrypt hashed secret for org-level server-side auth
}
```

##### 1.4 Rebuild org secret auth in auth.ts (with improvements) [x]

`apps/api/src/utils/auth.ts` — add org secret fallback after client secret verification.

**3 improvements over v1 implementation** (see brainstorm: docs/brainstorms/2026-03-17-upgrade-to-v2-brainstorm.md — Key Decision #3):

**Improvement 1: SHA-256 cache keys** (security fix)

```typescript
// BEFORE (v1 — leaks secret as Redis key):
const cacheKey = `org:auth:${orgId}:${Buffer.from(clientSecret).toString('base64')}`;

// AFTER (v2 — safe):
import { createHash } from 'node:crypto';
const secretHash = createHash('sha256').update(clientSecret).digest('hex');
const cacheKey = `org:auth:${orgId}:${secretHash}`;
```

**Improvement 2: Cache flush on secret regeneration**

In `packages/trpc/src/routers/organization.ts`, after regenerating the secret:

```typescript
// After storing new hashed secret, flush old auth cache entries
import { redis } from '@openpanel/redis';
const keys = await redis.keys(`org:auth:${organizationId}:*`);
if (keys.length > 0) {
  await redis.del(...keys);
}
```

**Improvement 3: Confirmation dialog for regeneration**

In the UI modal, require typing "REGENERATE" before allowing secret regeneration. This prevents accidental rotation that instantly breaks all server-side integrations.

##### 1.5 Modify client service to include organization [x]

`packages/db/src/services/clients.service.ts` — update the Prisma include:

```typescript
const client = await db.client.findUnique({
  where: { id: clientId },
  include: { project: true, organization: true },
});
```

##### 1.6 Add tRPC endpoints for secret management [x]

`packages/trpc/src/routers/organization.ts` — add two mutations:

- `generateSecret` — generates `sec_${randomBytes(20).toString('hex')}`, bcrypt hashes it, stores hash, returns plaintext once. Requires `org:admin` role. Prevents overwriting existing secret.
- `regenerateSecret` — same but allows overwriting. Flushes auth cache for the org (Improvement 2).

##### 1.7 Rebuild org secret UI on Tanstack [x]

Create/modify:
- `apps/start/src/modals/show-organization-secret.tsx` — show-once modal (Stripe pattern: "you won't see this again")
- `apps/start/src/routes/_app.$organizationId.settings.tsx` — add generate/regenerate buttons with confirmation dialog (Improvement 3)
- `apps/start/src/modals/index.tsx` — register the modal

##### 1.8 Update Docker build script [x]

`sh/docker-build` — two changes:

1. **Image naming**: The current script uses `build_image "dashboard"` in the `all` path, which looks for `apps/dashboard/Dockerfile` (doesn't exist). The upstream script maps `dashboard` → `apps/start/Dockerfile`. Add this mapping:

```bash
build_image() {
    local app=$1
    local image_name="keiwanmosaddegh/openpanel-$app"

    # Map app name to Dockerfile path (upstream convention)
    local dockerfile_dir="$app"
    if [ "$app" = "dashboard" ]; then
        dockerfile_dir="start"
    fi

    # ... rest of build logic using -f "apps/$dockerfile_dir/Dockerfile"
}
```

2. **Version tagging**: Tag with full version and `latest`:
```bash
-t "$image_name:$VERSION" \
-t "$image_name:latest" \
```

##### 1.9 Update self-hosting docker-compose template [x]

`self-hosting/docker-compose.template.yml` — align with upstream v2:

- ClickHouse: `24.3.2-alpine` → `25.10.2.65` + `CLICKHOUSE_SKIP_USER_SETUP=1`
- Images: `keiwanmosaddegh/openpanel-{api,dashboard,worker}:2`
- **CRITICAL: Add `start_period: 600s` to op-api healthcheck** (see System-Wide Impact below)

```yaml
op-api:
  healthcheck:
    test: ["CMD-SHELL", "curl -f http://localhost:3000/healthcheck || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 600s  # Allow 10 min for migrations before health checks begin
```

##### 1.10 Build and push Docker images

```bash
./sh/docker-build all 2.0.0
# Builds and pushes:
#   keiwanmosaddegh/openpanel-api:2.0.0
#   keiwanmosaddegh/openpanel-dashboard:2.0.0
#   keiwanmosaddegh/openpanel-worker:2.0.0
```

---

#### Phase 2: Local Testing Against Production Data Copy

Before deploying to the VPS, test the full migration path locally using production data.

##### 2.1 Get production Postgres dump

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres --clean --if-exists postgres' > /tmp/prod-pg-dump.sql
```

##### 2.2 Load into local environment and test

```bash
# Start local infra
docker compose up -d op-db op-ch op-kv

# Load Postgres dump (restores all tables including __code_migrations and _prisma_migrations)
docker exec -i op-db psql -U postgres postgres < /tmp/prod-pg-dump.sql

# Clear code migration records so all CH migrations run fresh
# (local ClickHouse is empty — needs tables created from scratch)
docker exec op-db psql -U postgres -c 'DELETE FROM "__code_migrations";'

# Run all migrations
CI=true pnpm -r run migrate:deploy
# Prisma: applies 11 new SQL migrations against restored prod data
# Code: runs 1-12 from scratch (creates CH tables, #8 copies 0 rows on empty tables)

# Verify:
# - All Prisma migrations applied without errors
# - All code migrations completed (check logs for errors)
# - Org secret column exists: psql -c "SELECT column_name FROM information_schema.columns WHERE table_name='organizations' AND column_name='secret';"
```

**Note:** This tests that all migration SQL is valid but doesn't test migration #8 with real data volume. That test happens on the VPS with the full backup safety net (Phase 3).

##### 2.3 Smoke test

```bash
pnpm dev  # Start dev servers
# Test: dashboard loads, data visible, org secret auth works
```

---

#### Phase 3: VPS Backup

**All commands are READ-ONLY or create new files. No modifications to running system.**

##### 3.1 Postgres backup (with --clean for restorability)

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres --clean --if-exists postgres > /root/backup-pre-v2.sql'
```

The `--clean --if-exists` flags ensure the dump can be restored by dropping and recreating tables.

##### 3.2 ClickHouse backup

```bash
# Record row counts for verification
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT table, total_rows FROM system.tables WHERE database='\''openpanel'\'' AND total_rows>0 ORDER BY total_rows DESC"' > /root/backup-ch-counts.txt

# Back up main tables (CSV format for schema-independent restoration)
for table in events sessions profiles profile_aliases events_bots; do
  ssh root@91.98.228.238 "docker exec self-hosting-op-ch-1 clickhouse-client --query 'SELECT * FROM openpanel.$table FORMAT CSVWithNames' > /root/backup-$table.csv"
done
```

**Note:** CSV format is used instead of Native because migration #8 changes the events/sessions table schema (different ORDER BY, added `revenue` column, dropped `properties` from sessions). CSV can be loaded into any schema.

##### 3.3 Config backup

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cp .env .env.backup-pre-v2 && cp docker-compose.yml docker-compose.yml.backup-pre-v2'
ssh root@91.98.228.238 'docker images | grep keiwanmosaddegh > /root/backup-image-ids.txt'
```

##### 3.4 Record current state

```bash
ssh root@91.98.228.238 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"' > /root/backup-container-state.txt
```

---

#### Phase 4: VPS Upgrade

**Schedule during low-traffic window (02:00-04:00 CET recommended for Swiss news clients).**

Expected downtime: 10-20 minutes (dominated by ClickHouse migration #8).

##### 4.1 Drain worker queues

```bash
# Stop workers first (graceful — finishes current jobs)
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose stop op-worker'

# Wait for queues to drain (check every 5s, timeout after 60s)
ssh root@91.98.228.238 'docker exec self-hosting-op-kv-1 redis-cli LLEN bull:events:wait'
# Repeat until 0 or near-0
```

##### 4.2 Stop all services

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./stop'
```

##### 4.3 Update .env

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cat .env'
# Then edit:
```

```diff
  NODE_ENV=production
- VITE_SELF_HOSTED=true
+ SELF_HOSTED=true
- BATCH_SIZE=5000
- BATCH_INTERVAL=10000
  ALLOW_REGISTRATION=false
  ALLOW_INVITATION=true
  REDIS_URL=redis://op-kv:6379
  CLICKHOUSE_URL=http://op-ch:8123/openpanel
  DATABASE_URL=postgresql://postgres:postgres@op-db:5432/postgres?schema=public
  DATABASE_URL_DIRECT=postgresql://postgres:postgres@op-db:5432/postgres?schema=public
  DASHBOARD_URL=https://activity.puzzlr.net
  API_URL=https://activity.puzzlr.net/api
  COOKIE_SECRET=<keep existing>
  RESEND_API_KEY=<keep existing>
  EMAIL_SENDER=noreply@activity.puzzlr.net
```

Changes: rename `VITE_SELF_HOSTED` → `SELF_HOSTED`, remove `BATCH_SIZE` and `BATCH_INTERVAL`. All other vars keep their existing values.

##### 4.4 Update docker-compose.yml

Key changes:

```yaml
# ClickHouse upgrade
op-ch:
  image: clickhouse/clickhouse-server:25.10.2.65  # was 24.3.2-alpine
  environment:
    - CLICKHOUSE_SKIP_USER_SETUP=1  # NEW — required for CH25

# Image tags
op-api:
  image: keiwanmosaddegh/openpanel-api:2.0.0  # was :latest
  healthcheck:
    start_period: 600s  # NEW — prevent restart during migrations

op-dashboard:
  image: keiwanmosaddegh/openpanel-dashboard:2.0.0  # was openpanel-start:latest

op-worker:
  image: keiwanmosaddegh/openpanel-worker:2.0.0  # was :latest
```

##### 4.5 Pull new images

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose pull'
```

##### 4.6 Start services

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./start'
```

##### 4.7 Monitor migrations

```bash
# Watch API logs for migration progress
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose logs -f op-api'

# Expected output:
# "Running migrations..."
# Prisma migrate deploy: 11 migrations applied
# Code migration 6-add-revenue-column: done
# Code migration 7-migrate-events-to-series: done
# Code migration 8-order-keys: copying events... (5-15 minutes)
# Code migration 9-migrate-options: done
# Code migration 10-add-session-replay: done
# Code migration 12-add-gsc: done
# "pnpm start" — API server listening
```

---

#### Phase 5: Verification

##### 5.1 Service health

```bash
# All containers healthy
ssh root@91.98.228.238 'docker ps --format "table {{.Names}}\t{{.Status}}"'

# API healthcheck
curl -f https://activity.puzzlr.net/api/healthcheck

# Dashboard loads
curl -s -o /dev/null -w "%{http_code}" https://activity.puzzlr.net
```

##### 5.2 Data integrity

```bash
# ClickHouse event count matches pre-upgrade
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT count() FROM openpanel.events"'
# Compare with backup-ch-counts.txt

# Postgres tables exist
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 psql -U postgres -c "\dt" | wc -l'
# Should be ~36 (25 existing + 11 new from migrations)
```

##### 5.3 Functional tests

- [ ] Dashboard loads and shows existing project data
- [ ] Events stream is visible in real-time view
- [ ] Historical data (events, sessions) is intact and queryable
- [ ] SDK event ingestion works (send test event from a client)
- [ ] Org secret auth works (test with project ID + org secret)
- [ ] Revenue tracking UI is available (new v2 feature)
- [ ] Customizable dashboards work (new v2 feature)

##### 5.4 Post-upgrade cleanup (after 7 days)

```bash
# Drop ClickHouse backup tables from migration #8
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "DROP TABLE IF EXISTS openpanel.events_20251123"'
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "DROP TABLE IF EXISTS openpanel.sessions_20251123"'

# Remove backup files
ssh root@91.98.228.238 'rm /root/backup-pre-v2.sql /root/backup-*.csv /root/backup-*.txt'
```

---

## System-Wide Impact

### Interaction Graph

1. **API startup** → runs `pnpm -r run migrate:deploy` → Prisma migrations (Postgres) → code migrations (ClickHouse) → `pnpm start` (Fastify server)
2. **Migration #8 (order-keys)** → renames `events` → `events_20251123` → creates `events_new_20251123` → copies data month-by-month → renames `events_new_20251123` → `events`. Same for sessions.
3. **Materialized views** (`dau_mv`, `cohort_events_mv`, etc.) → reference `events` table by name → automatically use new table after rename
4. **Worker startup** → connects to Redis queues → processes events → writes to ClickHouse `events` table
5. **Org secret auth** → SDK request → `validateSdkRequest()` → client lookup (cache/DB) → secret verification (bcrypt) → cache result (Redis, SHA-256 key)

### Error & Failure Propagation

- **Migration failure**: Code migration runner records completion in Postgres `__code_migrations` table only on success. Partial failures leave intermediate tables (e.g., `events_new_20251123`). On restart, `CREATE TABLE IF NOT EXISTS` prevents re-creation errors, but `INSERT INTO ... SELECT *` will re-copy partially copied data, causing duplicates.
- **Mitigation**: `start_period: 600s` on healthcheck prevents Docker from restarting during migrations.

### State Lifecycle Risks

- **ClickHouse table rename window**: During migration #8, there is a brief moment when `events` is renamed away but `events_new_20251123` hasn't been renamed to `events` yet. Any materialized view inserts during this window would fail silently. This is safe because the API isn't serving requests yet (still in migration phase).
- **Redis stale cache**: Old auth cache entries (base64 key format) will remain for up to 5 min after upgrade. They won't match the new SHA-256 key format, so they're just orphaned — no functional impact. They expire naturally.
- **Worker queue jobs**: Any v1 jobs remaining in Redis queues could have incompatible payload formats. Mitigated by draining queues before upgrade (Phase 4.1).

### API Surface Parity

- Org secret auth is not in upstream — it's an API surface extension. The auth endpoint behavior changes: in addition to `clientId + clientSecret`, it now accepts `projectId + orgSecret`. All other API surfaces are upstream v2 unchanged.

---

## Alternative Approaches Considered

1. **Merge upstream into fork** — Rejected. 255 upstream commits would create extensive merge conflicts in schema.prisma, auth.ts, dashboard components. (see brainstorm)
2. **Use official Docker images** — Rejected. Can't include org secret feature without custom code. (see brainstorm)
3. **Cherry-pick org secret as-is** — Rejected. Opportunity to fix cache key security issue and add missing cache invalidation. (see brainstorm — Key Decision #3)

## Acceptance Criteria

### Functional Requirements

- [ ] Dashboard loads at `https://activity.puzzlr.net` with v2 UI (Tanstack-based)
- [ ] All existing event data is intact and queryable
- [ ] SDK event ingestion works with existing client credentials
- [ ] Org secret auth works (project ID + org secret)
- [ ] Generate/regenerate org secret from organization settings UI
- [ ] v2 features available: revenue tracking, session replay, customizable dashboards, real-time view
- [ ] ClickHouse running v25.10.2.65

### Non-Functional Requirements

- [ ] Downtime < 20 minutes
- [ ] Zero data loss on existing events/sessions/profiles
- [ ] Full rollback capability tested before production upgrade
- [ ] Auth cache keys use SHA-256 (not base64 plaintext)

### Quality Gates

- [ ] Full migration tested locally against production data copy (Phase 2)
- [ ] All Prisma migrations applied without errors
- [ ] All ClickHouse code migrations completed successfully
- [ ] Event count matches pre-upgrade count
- [ ] Rollback procedure documented and tested

## Dependencies & Prerequisites

- [ ] Docker Hub access for `keiwanmosaddegh/*` image pushes
- [ ] VPS SSH access (`root@91.98.228.238`)
- [ ] Sufficient disk space on VPS (need ~350 MB temporary, have 96 GB)
- [ ] Low-traffic maintenance window coordinated

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Docker restarts API during migration #8 | High (without fix) | Critical — data duplication | Add `start_period: 600s` to healthcheck |
| ClickHouse 24→25 data incompatibility | Low | Critical | Test with prod data locally first |
| Prisma migration checksum mismatch | None (verified) | Critical | Already verified — all checksums match |
| Worker queue format incompatibility | Low | Medium | Drain queues before upgrade |
| Org secret bcrypt hash incompatibility | Very low | Medium | Same bcrypt library, same hash format |
| SDK ingestion during downtime | Certain | Low | Schedule low-traffic window; SDKs buffer/retry |

## Rollback Plan

### Before migration #8 completes

```bash
# Stop app services but keep databases running for restore
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose stop op-api op-dashboard op-worker op-proxy'

# Restore Postgres from backup (DB container still running)
ssh root@91.98.228.238 'docker exec -i self-hosting-op-db-1 psql -U postgres postgres < /root/backup-pre-v2.sql'

# Restore configs
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cp .env.backup-pre-v2 .env && cp docker-compose.yml.backup-pre-v2 docker-compose.yml'

# Restart everything with old config
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./stop && ./start'
```

### After migration #8 completes (ClickHouse tables renamed)

```bash
# Stop app services but keep databases running
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose stop op-api op-dashboard op-worker op-proxy'

# Reverse ClickHouse table renames
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "RENAME TABLE openpanel.events TO openpanel.events_v2_failed, openpanel.events_20251123 TO openpanel.events"'
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "RENAME TABLE openpanel.sessions TO openpanel.sessions_v2_failed, openpanel.sessions_20251123 TO openpanel.sessions"'

# Restore Postgres from backup (DB container still running)
ssh root@91.98.228.238 'docker exec -i self-hosting-op-db-1 psql -U postgres postgres < /root/backup-pre-v2.sql'

# Restore configs and restart with old images
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cp .env.backup-pre-v2 .env && cp docker-compose.yml.backup-pre-v2 docker-compose.yml'
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./stop && ./start'
```

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-17-upgrade-to-v2-brainstorm.md](docs/brainstorms/2026-03-17-upgrade-to-v2-brainstorm.md)
  - Key decisions carried forward: fresh start strategy, rebuild org secret with improvements, keep custom Docker images, full backup approach

### Internal References

- Build script: `sh/docker-build`
- Self-hosting template: `self-hosting/docker-compose.template.yml`
- Auth implementation: `apps/api/src/utils/auth.ts`
- Organization tRPC router: `packages/trpc/src/routers/organization.ts`
- Prisma schema: `packages/db/prisma/schema.prisma`
- Code migration runner: `packages/db/code-migrations/migrate.ts`
- Migration #8 (order-keys): `packages/db/code-migrations/8-order-keys.ts`
- Custom deployment guide: `self-hosting/README-SELF-HOSTING-KEIWAN.md`

### External References

- OpenPanel v1→v2 migration guide: `/Users/keiwanmosaddegh/Downloads/openpanel-docs/migration/migrate-v1-to-v2.mdx`
- OpenPanel environment variables: `/Users/keiwanmosaddegh/Downloads/openpanel-docs/self-hosting/environment-variables.mdx`
- OpenPanel changelog: `/Users/keiwanmosaddegh/Downloads/openpanel-docs/self-hosting/changelog.mdx`
- ClickHouse Docker tag verified: `clickhouse/clickhouse-server:25.10.2.65` (exists on Docker Hub)
