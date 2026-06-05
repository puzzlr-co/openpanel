# Runbook: Deploy local changes to production

**Production:** `activity.puzzlr.net` — VPS `root@91.98.228.238`, stack at `~/openpanel/self-hosting`
(docker compose: caddy + postgres + redis + clickhouse + op-api + op-dashboard + op-worker×4).
Live multi-tenant traffic. Zero data-loss tolerance.

**Execution model:** written for an AI agent deploying autonomously while the operator is
passively available (other tabs open, reachable in-session). The task "deploy the current
state of main" carries the authorization — no GO approval at any step. Stop and ask **only**
at the ⛔ points; they are objective blockers, not courtesy check-ins. Midday deploys are
fine; the cost is ~30 s of full outage during the update (§4).

**Versioning is hands-off** (ADR-0001, ADR-0002): nobody picks version numbers. The build
derives the immutable release tag `main-<7-char-sha>` from HEAD; prod tracks the `:2`
channel tag, which only `sh/docker-release` moves. Terms per `CONTEXT.md`.

## Happy path

```bash
# 0. preflight — §1 (gates, deployed revision, migration classification, acceptance check)

# 1. build + push the release tag (~10–20 min — run in background, exceeds 10-min exec caps)
./sh/docker-build all                      # refuses dirty/unpushed trees; non-interactive

# 2. release: re-point the :2 channel tag (instant; prod untouched until update)
./sh/docker-release main-<7-char-sha>      # tag = main-$(git rev-parse --short=7 HEAD); the build prints it ("Tagged as:")

# 3. VPS: backup + update (~30 s outage)
ssh root@91.98.228.238 'set -e; f=/root/backup-$(date +%F-%H%M).sql; docker exec self-hosting-op-db-1 pg_dump -U postgres postgres > "$f"; test -s "$f"; head -3 "$f" | grep -q "PostgreSQL database dump"; cd ~/openpanel/self-hosting && ./update'

# 4. verify — all checks must pass, revision-pinned to <full-sha> = git rev-parse HEAD (recorded in §1.1)
ssh root@91.98.228.238 'OP_EXPECTED_REVISION=<full-sha> ~/openpanel/self-hosting/verify-deploy'

# 5. babysit 15 min — launch detached on the VPS and poll the log; don't hold a 15-min ssh
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && OP_EXPECTED_REVISION=<full-sha> nohup ./verify-deploy --watch 15 </dev/null >/root/babysit.log 2>&1 & echo babysit started'
# poll: ssh root@91.98.228.238 'tail -3 /root/babysit.log' — finished when a "BABYSIT RESULT" line appears

# 6. run the acceptance check from §1.4 and report
```

## 1. Preflight (local)

In order; each is stop-and-fix unless marked ⛔ (stop-and-ask):

1. **Gates.** Working tree clean, HEAD == `origin/main` (pushed), `pnpm typecheck && pnpm test`
   pass. `docker-build` re-enforces the git state — images bake the checked-out tree
   (June 2 incident: stale code). Dirty or unpushed tree → stop and ask; never commit or
   push on your own initiative. Record `<full-sha>` = `git rev-parse HEAD` — every
   `<full-sha>`/`<7-char-sha>` placeholder below substitutes from this commit, **literally**
   (shell variables do not survive between separately-executed commands).
2. **Deployed revision.** Ask prod what it runs:
   ```bash
   PREV=$(ssh root@91.98.228.238 "docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' self-hosting-op-api-1")
   ```
   Record the printed value: it is `<PREV-full-sha>` below, and its first 7 chars form
   the rollback tag `main-<PREV-7-char>` (§7). Substitute it **literally** in later
   steps — an empty `$PREV` makes the §1.3 diff silently return nothing.
   **Bootstrap:** empty label = prod still on the pre-ADR-0001 `2.0.1` images → use
   `2e54094d` as `<PREV-full-sha>` (the 2.0.1 build commit; later commits changed only
   docs and code comments — the two `.tsx` diffs are JSDoc-only) and `2.0.1` as the
   rollback tag.
3. **Migration classification.**
   ```bash
   git diff --name-only <PREV-full-sha>..HEAD -- packages/db/prisma/migrations packages/db/code-migrations
   ```
   - empty → **code-only release**: auto-rollback armed (§6).
   - Prisma files only → proceed, auto-rollback **disarmed** (§6). Migrations auto-run on
     op-api start; its 600 s healthcheck `start_period` absorbs them, and caddy only routes
     once api+dashboard are healthy.
   - any `code-migrations/` file → ⛔ **read the migration, summarize what it does to the
     operator, and wait.** ClickHouse migrations can rewrite large tables; the operator
     decides routine flow vs supervised run (§8).
4. **Acceptance check.** From `git log <PREV-full-sha>..HEAD`, derive one concrete post-deploy
   assertion proving the release-specific change is live (a curl, a page, a query). If the
   release has no observable change (pure refactor), say so explicitly in the report instead.
5. **Docker Hub auth.** The push happens ~10 min into the build; stale `docker login` fails
   late. No reliable offline check — know that this failure mode is benign: fix auth, rerun.

## 2. Build

`./sh/docker-build all` — builds `apps/{start,worker,api}` → pushes
`keiwanmosaddegh/openpanel-{dashboard,worker,api}:main-<7-char-sha>` multi-arch (amd64+arm64),
with `org.opencontainers.image.revision=<full-sha>` baked in. Exits non-zero on any failed
build — proceed only after all three pushes. Same commit rebuilt → same tag,
content-equivalent: safe.

## 3. Release

`./sh/docker-release main-<7-char-sha>` — re-points `:2` for all three images (validates
all three exist before moving any; if a transient Hub error interrupts it midway, rerun —
the operation is idempotent). This is the **only** thing that moves `:2`; prod is
unaffected until §4.

## 4. Backup + update (VPS)

Happy-path step 3 above.

- The `pg_dump` covers the only state a routine release can corrupt (Postgres, via
  auto-migrations); ClickHouse events are append-only and untouched. The chained `test -s`
  + header grep abort the deploy on an empty/failed dump.
- `./update` = `git pull` (non-interactive fast-forward — the VPS tree must stay clean) +
  `docker compose up -d --pull always --remove-orphans`. Re-resolves `:2`; recreates only
  services whose digest or config changed. No new digest → safe no-op.
- **Downtime: ~30 s of full outage** (measured 2026-06-04: 1×502, then ~30 s
  connection-refused). Compose recreates `op-proxy` as a dependent and its
  `depends_on: service_healthy` keeps it down until both backends pass healthchecks.
  SDK events sent in the window are lost at the HTTP layer — the accepted cost of a midday
  deploy. db/kv/ch are never recreated by a code release.
- `self-hosting-op-*-1` container names derive from the compose project name (= the stack
  directory, `self-hosting`); proven live 2026-06-04. If a name doesn't resolve, list the
  real ones with `docker compose ps` — don't guess.

## 5. Verify + babysit

`OP_EXPECTED_REVISION=<full-sha> verify-deploy` — all checks must pass: containers
healthy · **revision** (every app container's image label == the sha shipped — replaces
manual digest comparison) · API healthcheck · root page · share-page SSR canary (log-grep,
gotcha 4) · event freshness < 5 min · no restart deltas · no error logs.

Then `--watch 15` (in background). Highest-signal failures: freshness going stale
(ingestion broke), restart deltas (crash-loop), new error lines. Finally run the §1.4
acceptance check.

## 6. On failure — decision policy

| Signal | Action |
|---|---|
| One check fails once (curl timeout, single odd log line) | Re-run `verify-deploy` once. Clean → transient; continue babysit. |
| Hard failure on 2 consecutive runs (containers unhealthy, API health down, freshness stale, restart deltas climbing, wrong revision) — **code-only release** | **Auto-rollback** (§7), re-verify, then report what happened. |
| Same hard failure — **release ran any migration** | ⛔ **Freeze.** Don't roll back: code rollback against a migrated schema is an informed human judgment, and a pg restore drops post-backup writes. Report state + the prepared §7 commands, wait. |
| Unknown error-log lines as the *only* red signal | ⛔ Report the lines, keep babysitting. Never roll back on logs alone — known noise exists (gotcha 8). |
| Any red signal matching no row above | ⛔ Report and wait. |

The step-4 one-shot verify follows row 1: one hard failure earns exactly one re-run, and a
failed re-run counts as the second consecutive run.

## 7. Rollback

Same machinery as a forward deploy — release the previous tag, update:

```bash
./sh/docker-release main-<PREV-7-char>        # bootstrap: ./sh/docker-release 2.0.1
ssh root@91.98.228.238 'cd ~/openpanel/self-hosting && ./update && OP_EXPECTED_REVISION=<PREV-full-sha> ./verify-deploy'
# omit OP_EXPECTED_REVISION when rolling back to the unlabeled 2.0.1 images
```

- No VPS file edits (ADR-0002): `:2` simply points at the verified release again;
  roll-forward later = a normal deploy. Expect the same ~30 s outage.
- If a Prisma migration ran, restoring the §4 `pg_dump` is a ⛔ human-driven decision (it
  drops data written since the backup):
  `docker exec -i self-hosting-op-db-1 psql -U postgres postgres < /root/backup-<...>.sql`
  — the operator runs or explicitly approves this, never the agent.

## 8. Exception: heavy ClickHouse migrations

When §1.3 hits ⛔ and the operator classifies the migration heavy/destructive: skip the
routine flow and run it supervised first — operator-driven (or explicitly approved), on
the VPS inside tmux (survives a dropped ssh):

```bash
# ssh root@91.98.228.238, then:
tmux new -s migrate
cd ~/openpanel/self-hosting
docker compose run --rm --no-deps op-api sh -c "CI=true pnpm -r run migrate:deploy"
```

Worked example: `docs/plans/2026-03-17-001-feat-upgrade-openpanel-v1-to-v2-plan.md` Phase 4.8.

## 9. Gotchas (encoded from incidents)

| # | Gotcha |
|---|--------|
| 1 | VPS `docker-compose.yml` + `.env` are gitignored (generated once by `./setup`). Template changes do **not** propagate — apply compose changes by hand on the VPS and mirror them in `docker-compose.template.yml`. (Rollback no longer touches this file — ADR-0002.) |
| 2 | Never gate on physical `count()` of `openpanel.sessions` (VersionedCollapsingMergeTree merge timing) — use `sum(sign)` or `count() FINAL`. |
| 3 | ClickHouse XML configs (`self-hosting/clickhouse/*.xml`) are git-tracked + bind-mounted: deploy via `git pull` + `SYSTEM RELOAD CONFIG` — zero downtime, no image build. |
| 4 | **SSR module-resolution bugs return HTTP 200** — TanStack Start streams a loading shell while the server logs `ERR_MODULE_NOT_FOUND`. Page checks must pair with a log grep (verify-deploy does). Root cause class: externalized deps with bare deep imports (`lodash/debounce`) or deps missed by nitro's tracer (`esm-env`); fix via `ssr.noExternal` in `apps/start/vite.config.ts`. |
| 5 | Never run `pnpm migrate:deploy` locally against prod; never run formatters. |
| 6 | VPS `.env` holds secrets — never print/commit. |
| 7 | Brief worker downtime loses nothing — events buffer in Redis through the recreate window. |
| 8 | Error-log noise is real. Known (2026-06-04): `overview.userJourney` "Query memory limit exceeded" — the 6 GB/query cap working as designed; disappears when that query is fixed upstream. Unknown lines → §6 last row. |
| 9 | `RestartCount` is cumulative since container creation (op-ch carries historical OOM restarts) — verify-deploy therefore reports restart *deltas*, not absolute counts. |
| 10 | Recreation wipes container log history: post-deploy log checks see only the new release (pure signal, but no view into pre-deploy errors). |

## 10. Agent harness notes

- The build (10–20 min) and babysit (15+ min) exceed typical 10-min foreground command
  caps — run the build in a local background shell; launch the babysit detached on the
  VPS (happy-path step 5) and poll its log.
- ssh is key-based and non-interactive; if anything prompts, stop and ask.
- Final report: shipped revision + release tag, verify/babysit results, acceptance-check
  outcome, backup filename, and — if anything went red — the exact failing output.
  Report faithfully; a failed check is reported as failed.

## Validation record

- **2026-06-04 (v2.0.0 → v2.0.1, semver-era):** non-interactive `git pull` ✔ ·
  `--pull always` re-resolved `:2` (running digests == pushed, all three images) ✔ ·
  recreate scope limited to op-api/op-dashboard/op-worker×4/op-proxy ✔ · 32 s outage
  measured ✔ · no-digest deploy degrades to no-op ✔ · canary sensitivity proven
  (pre-deploy run failed exactly on the live SSR bug; post-deploy 7/7 + 15/15 babysit
  rounds clean) ✔ · share page before/after: 135 KB shell → 190 KB fully server-rendered ✔.
- The SHA-tag scheme (ADR-0001/0002) replaced semver **after** that validation. Unchanged
  and still validated: `./update`, recreate scope, outage window, verify checks. Not yet
  live-tested: SHA-mode build, `docker-release`, the revision check, rollback-via-release.
  **First SHA deploy: treat it as the live test** — babysit attentively and confirm the
  revision check goes green.
