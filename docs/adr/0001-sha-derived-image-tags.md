# SHA-derived image tags instead of semver versions

The deploy runbook needed an agent-discoverable answer to "what version is this / what does prod run", and per-deploy semver (`2.0.x`, upstream's stable-channel convention from `d3300538` that the fork had been hand-running) required a human to pick a number — with a silent-overwrite-of-the-rollback-target catastrophe if the same patch was ever reused. We adopted the convention of upstream's *other* channel instead — their CI builds (`.github/workflows/docker-build.yml`): the release tag is derived from the commit (`main-<7-char-sha>`, longer than upstream's collision-prone 4 chars), prod keeps tracking the `:2` channel tag (also upstream's: their template ships `lindesvard/openpanel-*:2`, ours differs only in the account name), and the image bakes in `org.opencontainers.image.revision` so the deployed revision is read from the running container itself.

## Considered options

- **Per-deploy semver + git tag after verify** — readable ordering, but a number to pick, a step to forget, and state that can lie.
- **Docker Hub tags API as source of truth** — records "pushed", not "deployed"; network-dependent; lexical sort.
- **State file on the VPS** — records "deployed", but is writable state that can drift from what's actually running; the revision label cannot.

## Consequences

- No human-readable version ordering on Docker Hub; "what changed" is answered by `git log <deployed-sha>..HEAD`, not by comparing versions.
- The release tag is a claim that image == commit, so `docker-build` must refuse dirty trees and unpushed HEADs.
- Rollback and the migration gate both anchor on the deployed revision read pre-update.
