# Runbook: Deploy local changes to production

**Production:** `activity.puzzlr.net` — VPS `root@91.98.228.238`, stack at `~/openpanel/self-hosting`
(docker compose: caddy + postgres + redis + clickhouse + op-api + op-dashboard + op-worker×4).
Live multi-tenant traffic. Zero data-loss tolerance.

Routine code-release process, aligned with the official update flow
(`apps/public/content/docs/self-hosting/deploy-docker-compose.mdx`, "Update OpenPanel").
Validated end-to-end 2026-06-04 (v2.0.1). The one-time v1→v2 upgrade
(`docs/plans/2026-03-17-001-...`) is history, not this process.

## Happy path

```bash
# 0. local: gate + push (tracked self-hosting/ files reach the VPS only via git)
pnpm typecheck && pnpm test && git push origin main

# 1. local: build + push images (~10–20 min; bump the patch version every deploy)
yes y | ./sh/docker-build all 2.0.x

# 2. VPS: backup + update + verify (~30 s outage during recreate)
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > /root/backup-$(date +%F).sql && cd ~/openpanel/self-hosting && ./update && ./verify-deploy'

# 3. babysit 15 min (exit 0 = all rounds clean)
ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy --watch 15'
```

Details, rollback, and gotchas below.

## 0. Preconditions (local)

- All changes **committed on `main` and pushed** to the fork. Build only after the
  final commit — images bake the checked-out tree (June 2 incident: stale code).
- `pnpm typecheck && pnpm test` pass.
- Changelog announces no heavy/destructive ClickHouse migrations (else see §6).
- `docker login` active — the build script pushes to Docker Hub.

## 1. Build & push images

`yes y | ./sh/docker-build all 2.0.x`

- Builds `apps/{start,worker,api}` → pushes `keiwanmosaddegh/openpanel-{dashboard,worker,api}`
  tagged `:2.0.x`, `:2.0`, `:2`, `:latest`, multi-arch (amd64+arm64) via buildx.
- Bump the patch every deploy: prod consumes the moving `:2`, but the immutable `:2.0.x`
  is the rollback target (§5) and the answer to "what does prod run".
- The script exits non-zero on any failed build — proceed only after all three pushes.

## 2. Backup + update (VPS)

```bash
ssh root@91.98.228.238 'docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > /root/backup-$(date +%F).sql && cd ~/openpanel/self-hosting && ./update'
```

- The `pg_dump` covers the only state a routine release can corrupt (Postgres, via
  auto-migrations); ClickHouse events are append-only and untouched.
- `./update` = `git pull` + `docker compose up -d --pull always --remove-orphans`.
  Non-interactive (public fork over HTTPS, fast-forward — the VPS tree must stay clean).
- `--pull always` re-resolves `:2`; compose recreates only services whose digest or
  config changed. No new digest (step 1 skipped) → safe no-op.
- Migrations run automatically when op-api starts; its `start_period: 600s` healthcheck
  absorbs them, and caddy only routes once api+dashboard are healthy.

**Downtime: ~30 s of full outage** (measured 2026-06-04: 1×502, then ~30 s
connection-refused). Not per-service blips: compose recreates `op-proxy` as a
dependent, and its `depends_on: service_healthy` keeps it down until both backends
pass healthchecks. SDK events sent in the window are lost at the HTTP layer, so
prefer 02:00–04:00 CET for riskier releases. db/kv/ch are never recreated by a
code release.

## 3. Verify

`ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy'` — all 7 checks must pass:
containers healthy · API healthcheck · root page · share-page SSR canary (log-grep,
see gotcha 5) · event freshness < 5 min · no restarts · no error logs.

The script ends by printing the running image digests — compare against what step 1
pushed:

```bash
docker buildx imagetools inspect keiwanmosaddegh/openpanel-dashboard:2 | head -3   # local
```

Finally, eyeball the release-specific change itself (browser or curl).

## 4. Babysit

`ssh root@91.98.228.238 '~/openpanel/self-hosting/verify-deploy --watch 15'` — re-runs
all checks every minute for 15 min. Highest-signal failures: freshness going stale
(ingestion broke), restart deltas (crash-loop), new error lines.

## 5. Rollback (bad code-only release)

Re-pin the previous immutable tag and recreate — layers are still on Docker Hub:

```bash
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && sed -i "s|\(keiwanmosaddegh/openpanel-[a-z]*\):2$|\1:2.0.PREV|" docker-compose.yml && docker compose up -d'
```

- The VPS `docker-compose.yml` is gitignored — the edit survives `git pull`. Restore
  the `:2` tags + `./update` once a fixed release is published.
- Covers code only: if the bad release ran a schema migration, restore the §2 `pg_dump`.
- Verify with §3. *Not live-tested* (deliberate, 2026-06-04 — same compose-recreate
  machinery as the validated forward path; expect the same ~30 s outage).

## 6. Exception: heavy ClickHouse migrations

Releases whose changelog flags heavy/destructive CH migrations skip the routine flow —
run the migration supervised first (in tmux):

```bash
docker compose run --rm --no-deps op-api sh -c "CI=true pnpm -r run migrate:deploy"
```

Worked example: `docs/plans/2026-03-17-001-feat-upgrade-openpanel-v1-to-v2-plan.md` Phase 4.8.

## 7. Gotchas (encoded from incidents)

| # | Gotcha |
|---|--------|
| 1 | **Build after the final commit** — earlier builds ship stale code (June 2 incident). |
| 2 | VPS `docker-compose.yml` + `.env` are gitignored (generated once by `./setup`). Template changes do **not** propagate — apply compose changes by hand on the VPS and mirror them in `docker-compose.template.yml`. |
| 3 | Never gate on physical `count()` of `openpanel.sessions` (VersionedCollapsingMergeTree merge timing) — use `sum(sign)` or `count() FINAL`. |
| 4 | ClickHouse XML configs (`self-hosting/clickhouse/*.xml`) are git-tracked + bind-mounted: deploy via `git pull` + `SYSTEM RELOAD CONFIG` — zero downtime, no image build. |
| 5 | **SSR module-resolution bugs return HTTP 200** — TanStack Start streams a loading shell while the server logs `ERR_MODULE_NOT_FOUND`. Page checks must pair with a log grep (verify-deploy does). Root cause class: externalized deps with bare deep imports (`lodash/debounce`) or deps missed by nitro's tracer (`esm-env`); fix via `ssr.noExternal` in `apps/start/vite.config.ts`. |
| 6 | Never run `pnpm migrate:deploy` locally against prod; never run formatters. |
| 7 | VPS `.env` holds secrets — never print/commit. |
| 8 | Brief worker downtime loses nothing — events buffer in Redis through the recreate window. |
| 9 | Error-log check needs operator judgment. Known noise (2026-06-04): `overview.userJourney` "Query memory limit exceeded" — the 6 GB/query cap working as designed; disappears when that query is fixed upstream. |
| 10 | `RestartCount` is cumulative since container creation (op-ch carries historical OOM restarts) — verify-deploy therefore reports restart *deltas*, not absolute counts. |
| 11 | Recreation wipes container log history: post-deploy log checks see only the new release (pure signal, but no view into pre-deploy errors). |

## Validation record (2026-06-04, v2.0.0 → v2.0.1 dry-run)

All probed failure angles confirmed safe: non-interactive `git pull` ✔ · `--pull always`
re-resolved `:2` (running digests == pushed digests, all three images) ✔ · recreate scope
limited to op-api/op-dashboard/op-worker×4/op-proxy ✔ · 32 s outage measured ✔ ·
no-digest deploy degrades to no-op ✔ · canary sensitivity proven (pre-deploy run failed
exactly on the live SSR bug; post-deploy 7/7 + 15/15 babysit rounds clean) ✔ ·
share page before/after: 135 KB shell → 190 KB fully server-rendered ✔.
