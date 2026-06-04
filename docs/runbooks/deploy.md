# Runbook: Deploy local changes to production

**Production:** `activity.puzzlr.net` — VPS `root@91.98.228.238`, stack at `~/openpanel/self-hosting`
(docker compose: caddy + postgres + redis + clickhouse + op-api + op-dashboard + op-worker×4).
Live multi-tenant traffic. Zero data-loss tolerance.

This is the **routine** code-release process, aligned with the official update flow
(`apps/public/content/docs/self-hosting/deploy-docker-compose.mdx`, "Update OpenPanel").
The one-time v1→v2 upgrade (`docs/plans/2026-03-17-001-...`) is history, not this process.

Last validated end-to-end: 2026-06-04 (v2.0.1 release — share-page SSR fix).

---

## 0. Preconditions (local)

- All changes **committed** on `main`. Build only after the final commit — images bake the
  checked-out tree; building before a late commit ships stale code (June 2 incident).
- `pnpm typecheck && pnpm test` pass.
- **Pushed to fork `origin/main`.** This matters even for image-only changes: the VPS
  `./update` does `git pull`, and tracked `self-hosting/` files (ClickHouse XMLs,
  `verify-deploy`, Caddyfile) only reach the VPS via git.
- Check the release for **heavy/destructive ClickHouse migrations** (see §6 exception).
- Docker Hub login active locally (`docker login`) — `sh/docker-build` pushes.

```bash
git status                       # clean, on main
pnpm typecheck && pnpm test
git push origin main
```

## 1. Build & push images (local)

```bash
yes y | ./sh/docker-build all 2.0.x
```

- Builds `apps/{start,worker,api}` Dockerfiles → pushes
  `keiwanmosaddegh/openpanel-{dashboard,worker,api}` with tags `:2.0.x`, `:2.0`, `:2`, `:latest`.
- Multi-arch (amd64+arm64) via buildx `multi-arch-builder` (script recreates it each run).
- `yes y |` answers the per-image y/n prompts. Expect ~10–20 min for `all`.
- Version must be `x.y.z` (regex-enforced). Bump the patch for every prod deploy so the
  `:2.0.x` pin exists as a rollback target.
- Script exits non-zero on any failed build — do not proceed unless it printed all three pushes.

Record the new digest (used for verification in §3):

```bash
docker buildx imagetools inspect keiwanmosaddegh/openpanel-dashboard:2 | head -3
```

## 2. Backup + update (VPS)

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > /root/backup-$(date +%F).sql && cd ~/openpanel/self-hosting && ./update'
```

- `./update` = `git pull` + `docker compose up -d --pull always --remove-orphans`.
  Non-interactive: the clone tracks the public fork over HTTPS, fast-forward only
  (working tree on the VPS must stay clean — `git status` there if in doubt).
- `--pull always` re-resolves the moving `:2` tag, so a new digest is always picked up;
  compose recreates only services whose image digest (or config) changed.
- Postgres backup is the cheap insurance; ClickHouse events are append-only and not
  touched by a routine code release.
- Migrations run automatically when op-api starts (official position). op-api's
  healthcheck has `start_period: 600s` to absorb them; caddy waits for api+dashboard
  health before routing, limiting the blast radius of a failed migration.

**Downtime expectation: ~30 seconds of full outage** (measured 2026-06-04, v2.0.1:
1×502 then ~30 s connection-refused, recovered at 32 s). The window is NOT
per-service: compose recreates `op-proxy` (caddy) as a dependent of api/dashboard,
and caddy's `depends_on: service_healthy` keeps it down until both backends pass
their healthchecks. SDK events sent during the window are lost at the HTTP layer
(client-side retry only), so for riskier releases prefer the low-traffic window
02:00–04:00 CET. db/kv/ch are not recreated on a code release (image unchanged) —
they only gate startup ordering.

**If step 1 was skipped / no new digest:** `./update` degrades to a no-op pull +
no-op recreate (safe).

## 3. Verify (VPS, immediately after)

```bash
ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy'
```

Checks (all must pass):
1. All containers running & healthy
2. `https://activity.puzzlr.net/api/healthcheck` OK
3. Root page HTTP 200/307
4. Share-page SSR canary: requests `/share/overview/$SHARE_ID` and asserts no fresh
   `ERR_MODULE_NOT_FOUND` in op-dashboard logs (SSR failures still return HTTP 200,
   so a plain status check is NOT sufficient)
5. Event ingestion freshness: newest ClickHouse event < 5 min old
6. Zero container restarts
7. No error lines in op-api/op-worker/op-dashboard logs (last 10 m)

Then confirm the running digest matches what you pushed:

```bash
# local
docker buildx imagetools inspect keiwanmosaddegh/openpanel-dashboard:2 --format '{{json .Manifest.Digest}}'
# VPS — must print the same sha256
ssh root@91.98.228.238 'docker inspect --format "{{index .RepoDigests 0}}" keiwanmosaddegh/openpanel-dashboard:2'
```

Plus a release-specific functional check: whatever user-visible thing this release
changes, look at it (browser or curl).

## 4. Babysit (~15 min)

```bash
ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy --watch 15'
```

Re-runs the full check suite every minute for 15 minutes. Highest-signal failures:
event freshness going stale (worker/ingestion broke), restart counts rising
(crash-loop), new error-log lines. Exit code 0 = all rounds clean.

## 5. Rollback (bad code-only release)

Re-pin the previous version tag and recreate — image layers are still on Docker Hub:

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && sed -i "s|\(keiwanmosaddegh/openpanel-[a-z]*\):2$|\1:2.0.PREV|" docker-compose.yml && docker compose up -d'
```

- `docker-compose.yml` on the VPS is **gitignored** — editing it is safe and survives `git pull`.
- After rolling back, **revert the pin** once a fixed `:2` is published: restore `:2` tags
  and `./update`.
- Rollback only covers code. If the bad release ran a schema migration, restore the §2
  `pg_dump` (and treat ClickHouse migrations per §6).
- Verify the rollback with §3.
- *Not live-tested* (deliberate call, 2026-06-04: the mechanism is the same compose-recreate
  machinery validated in the forward direction; expect the same ~30 s outage).

## 6. Exception path: heavy ClickHouse migrations

Releases whose changelog announces heavy/destructive ClickHouse migrations do **not**
use the routine flow. Run the migration supervised first (in tmux):

```bash
docker compose run --rm --no-deps op-api sh -c "CI=true pnpm -r run migrate:deploy"
```

See the June 3 execution in `docs/plans/2026-03-17-001-feat-upgrade-openpanel-v1-to-v2-plan.md`
(Phase 4.8) for the worked example. This is deliberately NOT part of the routine runbook.

## 7. Gotchas (encoded from incidents)

| # | Gotcha |
|---|--------|
| 1 | **Build after the final commit.** Images built before later commits ship stale code (June 2 incident). |
| 2 | `docker-compose.yml` and `.env` on the VPS are gitignored, generated once by `./setup`. Template changes (`self-hosting/docker-compose.template.yml`) do **not** propagate to the live file — apply intentional compose changes by hand on the VPS and mirror them in the template. |
| 3 | **Sessions table counts:** never gate on physical `count()` of `openpanel.sessions` (VersionedCollapsingMergeTree merge timing) — use `sum(sign)` or `count() FINAL`. |
| 4 | **ClickHouse XML configs** (`self-hosting/clickhouse/*.xml`) are git-tracked + bind-mounted. They deploy via `git pull` + `docker exec self-hosting-op-ch-1 clickhouse-client --query "SYSTEM RELOAD CONFIG"` — zero downtime, no restart, no image build needed. |
| 5 | **SSR module-resolution bugs return HTTP 200.** TanStack Start streams a loading shell even when the route's SSR chunk fails to link (`ERR_MODULE_NOT_FOUND`). Always pair page checks with a log grep (verify-deploy does). Root cause class: externalized deps with bare/extensionless deep imports (`lodash/debounce`) or deps missed by nitro's tracer (`esm-env`) — fix by adding to `ssr.noExternal` in `apps/start/vite.config.ts`. |
| 6 | `pnpm migrate:deploy` must never be run locally against prod; never run formatters (CLAUDE.md). |
| 7 | `.env` on the VPS holds secrets (COOKIE_SECRET, RESEND_API_KEY) — never print/commit. |
| 8 | Worker containers (`op-worker` ×4 replicas) recreate in parallel with api/dashboard; queued events buffer in Redis during the blip, so brief worker downtime loses nothing. |
| 9 | The error-log check needs operator judgment. Known noise (as of 2026-06-04): `overview.userJourney` ClickHouse "Query memory limit exceeded" rejections — that's the 6 GB/query cap working as designed (the alternative was CH getting OOM-killed; op-ch carries 9 historical OOM restarts from before the caps). Goes away when the userJourney query is fixed. |
| 10 | `RestartCount` is cumulative since container creation — verify-deploy uses delta-since-baseline semantics, not absolute zero. |
| 11 | **Container recreation wipes log history.** `docker compose logs --since 10m` after a deploy only sees the new containers' logs — pre-deploy error lines are gone, so a clean error-log check right after deploy says nothing about the old release. Conversely it makes the post-deploy signal pure. |

## Validation record (2026-06-04 dry-run, v2.0.0 → v2.0.1)

Probed failure angles, all confirmed safe:

- VPS `git pull` is non-interactive: public fork over HTTPS, fast-forward only. ✔
- `--pull always` re-resolved the moving `:2` tag: all three running `RepoDigests` matched
  the freshly pushed Docker Hub digests exactly. ✔
- Recreate scope: only op-api/op-dashboard/op-worker×4/op-proxy recreated; db/kv/ch untouched. ✔
- Downtime: 32 s total (see §2). ✔
- No-op deploy (no new digest): `./update` degrades to pull-nothing + recreate-nothing. ✔ (by design;
  observed pre-deploy that an unchanged digest produced no recreate)
- verify-deploy canary sensitivity proven: pre-deploy run failed exactly on the live SSR bug
  (2×ERR_MODULE_NOT_FOUND), post-deploy run 7/7 clean with the same checks. ✔
- Share page before/after: SSR shell-only 135 KB → fully server-rendered 190 KB. ✔

## Quick reference (happy path)

```bash
# local
pnpm typecheck && pnpm test && git push origin main
yes y | ./sh/docker-build all 2.0.x

# VPS (one line)
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > /root/backup-$(date +%F).sql && cd ~/openpanel/self-hosting && ./update && ./verify-deploy'

# babysit
ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy --watch 15'
```
