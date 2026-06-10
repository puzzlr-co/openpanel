---
title: "feat: Upgrade Self-Hosted OpenPanel v1 to v2"
type: feat
status: done
date: 2026-03-17
completed: 2026-06-10
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

### Progress

| Phase | Status |
|-------|--------|
| 1. Local Preparation | Done (2026-03-17) |
| 2. Local Testing | Done (2026-03-18) |
| 2.4 Overview Customization Scaffold | Done (2026-03-24) |
| 2.5 Custom Widgets | Done (2026-06-02, images 2.0.0 pushed) |
| 3. VPS Backup | Done (2026-06-03) |
| 4. VPS Upgrade | Done (2026-06-03, downtime 18:03–18:17 UTC, ~13 min) |
| 5. Verification | Done (2026-06-03) |
| 5.4 Post-upgrade cleanup | Done (2026-06-10, +7 days) |

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

##### 1.10 Build and push Docker images [x]

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

##### 2.1 Get production Postgres dump [x]

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres --clean --if-exists postgres' > /tmp/prod-pg-dump.sql
```

##### 2.2 Load into local environment and test [x]

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

##### 2.3 Smoke test [x]

```bash
pnpm dev  # Start dev servers
# Test: dashboard loads, data visible, org secret auth works
```

**Phase 2 completed 2026-03-18.** All migration SQL valid. API, Worker, Dashboard all start and connect to all three databases.

---

#### Phase 2.4: Fork-Safe Overview Customization Scaffold [x]

**Completed 2026-03-24.** Extracted hardcoded overview widgets into config-driven rendering. Fork customizations in `apps/start/src/config/overview-widgets.fork.ts`, custom widget components in `apps/start/src/components/custom/`. See `apps/start/src/config/README.md` for usage guide.

---

#### Phase 2.5: Custom Widgets

**Goal:** Build fork-specific widgets for the overview page using the scaffold from Phase 2.4. Must be completed and Docker images rebuilt before Phase 3.

---

#### Phase 3: VPS Backup

**All commands are READ-ONLY or create new files. No modifications to running system.**

**Completed 2026-06-03 (~16:45 server time).** All artifacts verified on the VPS:
`/root/backup-pre-v2.sql` (86K, dump-complete marker + org secret column confirmed), `/root/backup-ch-counts.txt`, `/root/backup-{events,sessions,profiles,profile_aliases,events_bots}.csv` (18G / 2.0G / 809M / 47B / 671K), `/root/backup-image-ids.txt`, `/root/backup-container-state.txt`, and `.env.backup-pre-v2` + `docker-compose.yml.backup-pre-v2` in `~/openpanel/self-hosting`. 71 GB disk remains free.

> **⚠️ Data volume has grown ~6.4× since this plan was written:** production now holds **36.75M events, 2.79M sessions, 2.42M profiles** (plan assumed 5.7M/478K/416K). Despite the growth, the events table is only **1.38 GiB on disk** (sessions 365 MiB) — migration #8's copy is realistically **minutes** on the VPS's 8 cores (largest monthly chunk = 20.25M rows, vs a 1h/statement ClickHouse timeout). Keep `start_period: 600s`. Expected total downtime ~15–25 min.

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

**Superseded (2026-06-03):** the cold volume tars in Phase 4.3 dominate the CSV exports for rollback (byte-exact restore, 6.2 GB vs 18 GB of CSVs). Treat CSV exports as optional for future runs.

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

**Completed 2026-06-03.** Executed at ~18:00 UTC (user-approved daytime window). Actual downtime 18:03:33–18:16:30 UTC (~13 min). Notes from the run:
- The 4.1 drain check key `bull:events:wait` doesn't exist — the real queues are GroupMQ (`groupmq:group_events:*`, ~1k jobs at stop) and `event_buffer:queue`. v2 uses identical keys (`packages/queue/src/queues.ts`, `packages/db/src/buffers/event-buffer.ts:71`), so the backlog rode through the upgrade and v2 workers drained it within minutes of 4.10.
- 4.3 cold tars: CH 4.3 GB + PG 6 MB, both `gzip -t` verified before 4.7.
- 4.9 sessions gate: physical `count()` differed by 2,310 rows (new 2,792,086 vs old 2,794,396) — pure VersionedCollapsingMergeTree collapse-merge timing on freshly written parts. Logical equality was exact on all of `sum(sign)`, `count() FINAL`, and `uniqExact(id)` (2,791,740). **Future runs: gate sessions on `sum(sign)`, not physical `count()`.** Events matched exactly (36,789,649).

**Schedule during low-traffic window (02:00-04:00 CET recommended for Swiss news clients).**

Expected downtime: ~15–25 minutes (migration #8 copies ~1.4 GiB on disk — minutes, not hours; the migration client's 1h/statement timeout has ~12× headroom).

**Run the whole phase from an interactive SSH session inside `tmux` on the VPS** (`ssh -t root@91.98.228.238 tmux new -s upgrade`) — a dropped connection must not kill a step mid-flight.

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

# Gate: must print nothing before touching volumes (4.3)
ssh root@91.98.228.238 'docker ps --format "{{.Names}}"'
```

##### 4.3 Cold backup of data volumes (the rollback path)

ClickHouse 24.3 cannot read a data dir that 25.x has written to — 25.5 compact-part marks (ClickHouse PR #84171: "servers with version less than 25.5 won't be able to read new Compact parts") and 25.10 String serialization (2025 changelog: "downgrading to versions before 25.10 will not be possible"). Once CH 25 boots in 4.7, these tars are the **only** way back.

```bash
ssh root@91.98.228.238 'tar -C /var/lib/docker/volumes/self-hosting_op-ch-data -czf /root/backup-ch-datadir.tar.gz _data'  # 6.2 GB, ~3 min
ssh root@91.98.228.238 'tar -C /var/lib/docker/volumes/self-hosting_op-db-data -czf /root/backup-pg-datadir.tar.gz _data'  # 60 MB, seconds
```

##### 4.4 Update .env

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

##### 4.5 Update docker-compose.yml

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

##### 4.6 Pull new images

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose pull'
```

##### 4.7 Start databases and sanity-check ClickHouse 25

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose up -d op-db op-ch op-kv'

# CH 25 boots cleanly on the old data dir
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT version()"'

# Capture the migration baseline — authoritative for 4.9
# (Phase 3 counts are stale: taken while still ingesting)
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT count() FROM openpanel.events" | tee /root/baseline-events.txt'
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT count() FROM openpanel.sessions" | tee /root/baseline-sessions.txt'
```

##### 4.8 Supervised one-off migration

Run inside the tmux session on the VPS:

```bash
cd ~/openpanel/self-hosting
docker compose run --rm --no-deps op-api sh -c "CI=true pnpm -r run migrate:deploy"
```

Why `compose run` instead of `./start`: op-api's normal startup runs the same migrations under `restart: always` — a failed migration exits 1 and auto-re-runs from the beginning, and migration #8 (no checkpoint, no dedup; sessions' VersionedCollapsingMergeTree doesn't collapse re-inserted rows either) would duplicate data. `compose run --rm` applies no restart policy: **failure halts.** `--no-deps` is safe — db/ch/kv are already up from 4.7. The image has no ENTRYPOINT and ships the full pnpm workspace, so this runs exactly what startup would, minus `pnpm start`.

```text
# Expected output:
# Prisma migrate deploy: 11 migrations applied
# Code migrations 6→12 run in order; #8 (order-keys) copies events/sessions
# month-by-month (minutes), then renames tables
# exits 0
```

**If #8 fails**, check `SHOW TABLES FROM openpanel` and repair per this table. #8 ends with 4 sequential RENAME statements (`packages/db/code-migrations/8-order-keys.ts:250-283`), so the state tells you where it died:

| State | Meaning | Repair |
|---|---|---|
| `events` + `events_new_20251123` exist, no `events_20251123` | Failed during copy | `DROP TABLE openpanel.events_new_20251123` and `openpanel.sessions_new_20251123` → fix cause → re-run 4.8 |
| `events_20251123` exists, `events` missing | Died mid-rename | Finish the remaining renames by hand (statements are in the generated `8-order-keys.sql` next to the migration in the container) → verify counts (4.9) → record completion in Postgres: `INSERT INTO "__code_migrations" (name) VALUES ('8-order-keys.ts')` |
| All renames done but migration unrecorded | Died after last rename, before the Postgres record | Verify counts (4.9) → insert the record row as above. **Never re-run 4.8 in this state** — it would copy the new `events` into a fresh `_new_` table and fail on rename. |

##### 4.9 Verify counts

Exact equality required — nothing ingests while proxy/api are down:

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "SELECT (SELECT count() FROM openpanel.events) = (SELECT count() FROM openpanel.events_20251123) AS events_match, (SELECT count() FROM openpanel.sessions) = (SELECT count() FROM openpanel.sessions_20251123) AS sessions_match"'
# Expect: 1  1 — and events count must equal /root/baseline-events.txt from 4.7
```

##### 4.10 Start the full stack

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./start'
# op-api's in-container migrate:deploy no-ops (all migrations recorded) and the stack comes up in one shot

ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && docker compose logs -f op-api'
```

---

#### Phase 5: Verification

**Completed 2026-06-03 (~18:20 UTC).** All technical gates passed: 10/10 containers healthy on v2 images, API healthcheck `ready:true`, dashboard 307→/login→200, events ≥ baseline with live ingestion (max ts seconds old), MVs confirmed following renamed tables (dau_mv inner parts written seconds after fresh events — residual risk closed), v1 queue backlog (~1k jobs) fully processed by v2 workers, zero auth failures across all tenants. Dashboard visually verified via browser automation 2026-06-03 ~18:45 UTC: v2 TanStack UI, all 8 tenant projects with live data, custom fork widgets rendering (level completion, multi-game sessions, top games, retention curve, events-with-game-filter), realtime view live (489 visitors/30min, map + feed), events stream flowing with geo enrichment, dashboards feature present, zero console errors. Org secret auth test remains manual (needs plaintext secret). §5.4 cleanup deferred to 2026-06-10 per plan; backup tables `events_20251123`/`sessions_20251123` and `/root/backup-*`, `/root/baseline-*` remain until then.

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
# Must be ≥ /root/baseline-events.txt (the 4.7 baseline; grows once ingestion resumes)

# Postgres tables exist
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 psql -U postgres -c "\dt" | wc -l'
# Should be ~36 (25 existing + 11 new from migrations)
```

##### 5.3 Functional tests

- [x] Dashboard loads and shows existing project data (user visual check 2026-06-03)
- [x] Events stream is visible in real-time view (user visual check 2026-06-03)
- [x] Historical data (events, sessions) is intact and queryable (4.9 gate + dashboard check)
- [x] SDK event ingestion works (live multi-tenant traffic within seconds of 4.10)
- [x] Org secret auth works — verified empirically: live `org:auth:puzzlr:<sha256>` cache key in Redis (new SHA-256 format proves the rebuilt v2 path serves production integrations)
- [ ] Revenue tracking UI is available (new v2 feature) — not yet exercised
- [x] Customizable dashboards work (user visual check 2026-06-03)

##### 5.4 Post-upgrade cleanup (after 7 days) — Done (2026-06-10)

Executed after a full week of healthy v2 operation (all containers up 4–6 days, ingestion grown 36.79M→40.70M events). Dropped both frozen backup tables and removed the upgrade rollback artifacts.

```bash
# Drop ClickHouse backup tables from migration #8
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "DROP TABLE IF EXISTS openpanel.events_20251123"'
ssh root@91.98.228.238 'docker exec self-hosting-op-ch-1 clickhouse-client --query "DROP TABLE IF EXISTS openpanel.sessions_20251123"'

# Remove backup files — EXPLICIT paths only (the CSV exports were already gone).
# Do NOT use `rm /root/backup-*`: a daily PG-dump routine now writes /root/backup-YYYY-MM-DD*.sql
# which is live operational backup, NOT upgrade residue — the glob would destroy it.
ssh root@91.98.228.238 'rm -f /root/backup-pre-v2.sql /root/backup-ch-counts.txt /root/backup-container-state.txt /root/backup-image-ids.txt /root/backup-ch-datadir.tar.gz /root/backup-pg-datadir.tar.gz /root/baseline-events.txt /root/baseline-sessions.txt /root/migration-4.8.log'
```

**Preserved:** `/root/backup-2026-06-04.sql`, `/root/backup-2026-06-05-0901.sql` (daily PG dumps, unrelated to this upgrade).

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
- **Mitigation**: migrations run supervised via `docker compose run --rm` (no restart policy — failure halts; Phase 4.8). `start_period: 600s` remains as belt-and-braces for the subsequent `./start`.

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

- [x] Dashboard loads at `https://activity.puzzlr.net` with v2 UI (Tanstack-based)
- [x] All existing event data is intact and queryable (events exact: 36,789,649; sessions logically exact: 2,791,740)
- [x] SDK event ingestion works with existing client credentials (live multi-tenant traffic verified post-upgrade)
- [x] Org secret auth works (project ID + org secret) — verified empirically via live SHA-256 `org:auth` cache key in Redis (2026-06-03)
- [ ] Generate/regenerate org secret from organization settings UI — untested; existing secret works, exercise on next rotation
- [x] v2 features available: customizable dashboards + real-time view verified in browser 2026-06-03 (revenue/session replay UIs not yet exercised)
- [x] ClickHouse running v25.10.2.65

### Non-Functional Requirements

- [x] Downtime < 30 minutes (~13 min actual)
- [x] Zero data loss on existing events/sessions/profiles (4.9 gate + logical-equality reconciliation)
- [x] Full rollback capability in place (cold volume tars, gzip-verified; restore path documented — not exercised)
- [x] Auth cache keys use SHA-256 (not base64 plaintext)

### Quality Gates

- [x] Full migration tested locally against production data copy (Phase 2)
- [x] All Prisma migrations applied without errors
- [x] All ClickHouse code migrations completed successfully
- [x] Event count matches pre-upgrade count (exact)
- [x] Rollback procedure documented; backup artifacts verified (restore not exercised — superseded by successful upgrade)

## Dependencies & Prerequisites

- [ ] Docker Hub access for `keiwanmosaddegh/*` image pushes
- [ ] VPS SSH access (`root@91.98.228.238`)
- [ ] Sufficient disk space on VPS (need ~350 MB temporary, have 96 GB)
- [ ] Low-traffic maintenance window coordinated

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Docker restarts API during migration #8 | High (without fix) | Critical — data duplication | Supervised one-off migration via `compose run` (4.8) — no restart policy; `start_period: 600s` as belt-and-braces |
| ClickHouse 24→25 one-way door (no downgrade) | Certain once CH 25 writes parts | Critical | Cold volume tars before first CH 25 boot (4.3) |
| Prisma migration checksum mismatch | None (verified) | Critical | Already verified — all checksums match |
| Worker queue format incompatibility | Low | Medium | Drain queues before upgrade |
| Org secret bcrypt hash incompatibility | Very low | Medium | Same bcrypt library, same hash format |
| SDK ingestion during downtime | Certain | Low | Schedule low-traffic window; SDKs buffer/retry |

## Rollback Plan

> "Restart with old images" is **invalid once ClickHouse 25 has booted on the data dir** (Phase 4.7 onward) — 24.3 cannot read parts written by 25.x (ClickHouse PR #84171; 25.10 String serialization change). The cold volume tars from 4.3 are the rollback path. Migration-failure *recovery* (continue forward) is handled in 4.8 — this section is for *abandoning* the upgrade.

### Before 4.7 (CH 25 never booted)

Nothing has touched the data — only configs changed. Restore them and start the old stack:

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cp .env.backup-pre-v2 .env && cp docker-compose.yml.backup-pre-v2 docker-compose.yml && ./start'
```

### From 4.7 onward (CH 25 has written to the volume)

```bash
# Stop everything
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./stop'

# Restore both data volumes from the cold tars
ssh root@91.98.228.238 'rm -rf /var/lib/docker/volumes/self-hosting_op-ch-data/_data && tar -C /var/lib/docker/volumes/self-hosting_op-ch-data -xzf /root/backup-ch-datadir.tar.gz'
ssh root@91.98.228.238 'rm -rf /var/lib/docker/volumes/self-hosting_op-db-data/_data && tar -C /var/lib/docker/volumes/self-hosting_op-db-data -xzf /root/backup-pg-datadir.tar.gz'

# Restore configs and start the old stack
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && cp .env.backup-pre-v2 .env && cp docker-compose.yml.backup-pre-v2 docker-compose.yml && ./start'
```

Data loss on rollback = events ingested between the 4.3 tar and the rollback — none, since ingestion is down throughout the window.

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
