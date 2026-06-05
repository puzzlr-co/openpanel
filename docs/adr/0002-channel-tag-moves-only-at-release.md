# Channel tag moves only at release; rollback re-points it

`docker-build` used to push the `:2` channel tag as a side effect of building, and rollback meant `sed`-pinning the previous version into the gitignored VPS compose file — two pieces of state to reconcile, an un-pin chore to remember, and a rollback path the runbook admitted was never live-tested. We split build from release: building pushes only the immutable release tag (`main-<sha>`), and a separate explicit step (`sh/docker-release`) re-points `:2`. Rollback is now `docker-release <previous release tag>` + the same `./update` as a forward deploy — the rollback machinery *is* the validated forward machinery.

## Considered options

- **Keep pushing `:2` at build time** — simpler happy path, but an aborted deploy leaves `:2` ahead of prod, and rollback still needs the sed-pin special case.
- **sed-pin on the VPS compose file (status quo)** — works, but breaks the invariant "`:2` points at what prod should run", diverges a gitignored file from its template, and is a second mechanism to validate and remember.

## Consequences

- Invariant: **`:2` always points at what prod should run.** A failed build or abandoned deploy leaves nothing dangling.
- The VPS compose file is never edited for rollback; gotcha 2 (template/VPS drift) shrinks to config changes only.
- Roll-forward after a rollback is just a normal deploy — no tag restoration step.
