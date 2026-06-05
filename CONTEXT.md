# OpenPanel Fork (puzzlr)

Fork of OpenPanel powering `activity.puzzlr.net`. This glossary holds the canonical terms for fork operations; pick these words over their aliases in docs, scripts, and conversation.

## Language

### Deployment

**Release tag**:
The immutable image tag identifying exactly one build of one commit, derived from git (`main-<7-char-sha>`). Never chosen by a human and never reused.
_Avoid_: version, semver tag, sha tag, immutable tag

**Channel tag**:
The mutable tag prod tracks (`:2`). Moved only by a release (`sh/docker-release`) — never as a side effect of a build. Invariant: it always points at what prod should run.
_Avoid_: mover, moving tag, floating tag, latest (as a concept)

**Build**:
Producing and pushing an immutable release-tagged image (`sh/docker-build`). Prod-inert: nothing prod tracks has moved yet.

**Release**:
Re-pointing the channel tag at a build (`sh/docker-release`). Still prod-inert until the next update. Rollback is a release of the previous build.

**Deploy**:
The end-to-end runbook: preflight → build → release → backup → update → verify → babysit.

**Deployed revision**:
The git commit prod is actually running, read from the `org.opencontainers.image.revision` label of the running containers — never from local state, registry listings, or memory.
_Avoid_: prod version, current version, live version

**Update**:
The recreate step on the VPS (`./update`): git pull + compose re-resolve of the channel tags. Distinct from a release (building images) and a deploy (the whole runbook).

**Babysit**:
The post-update watch window (`verify-deploy --watch`): all checks re-run every minute, any failed round fails the babysit.
_Avoid_: monitoring, smoke testing

**Canary (SSR)**:
The known public share page whose render + log-grep proves server-side rendering works; HTTP 200 alone proves nothing (loading shell).

## Example dialogue

> **Dev:** What's prod on right now?
> **Ops:** The deployed revision is `65e0419` — read it off the running container's label, don't trust the registry listing.
> **Dev:** And if tonight's release goes bad?
> **Ops:** Pin the previous release tag, `main-<prev-sha>`, in the VPS compose file. The channel tag `:2` stays put until a fixed release re-points it via the next update.
> **Dev:** Verify passed, are we done?
> **Ops:** No — babysit for 15 minutes; the canary and freshness checks are the ones that catch slow failures.
