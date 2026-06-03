# Top games widget — design notes

> Status: **SHIPPED.** Prototype route deleted; the real widget lives in
> `overview-top-games.tsx` and is registered in `overview-widgets.fork.ts`.

## The question

A new Overview/Share widget listing games with **levels started**, **levels
completed**, and **play-through rate** (`completed / started`). Three things were
genuinely undecided, so they were prototyped rather than guessed:

1. How to render the play-through rate (plain %, progress bar, gauge, funnel).
2. How to keep the `quiz` outlier (6.4%) from looking like a bug.
3. Whether to title-case the `game_id` slugs.

## Data reality (verified in prod ClickHouse, read-only)

- `level_started` (5.26M) and `level_completed` (4.22M) both carry
  `properties['game_id']` on ~100% of rows → clean grouping key, no JSON digging.
- `game_id` values are tidy slugs: `word-flow`, `boxr`, `circuit`, `quiz`, …
- Per-game rate varies hugely: `circuit` 97%, `boxr` 92% … `quiz` **6.4%**.
  `quiz` fires `level_completed` only on a perfect run (fail-state game), so its
  rate is real and *not comparable* to puzzle games — this is the same caveat the
  existing blended "Level completion" metric already carries.
- **Aliasing exists** and is a DATA decision for KM, deliberately left out of the
  visual prototype: `quiz`/`quizr`, `crossword`/`mini-crossword`,
  `word-between`/`wordbetween`. Decide whether to merge before/at query time.

## Variants prototyped

| Variant | Structure | Rate shown as | Sort | Outlier handling |
|---|---|---|---|---|
| **A — Native table** | Reuses real `OverviewWidgetTable` (volume bar behind rows) | colored % text column | by Started | red % + "scored differently" badge |
| **B — Drop-off bars** | one two-tone bar per row: outer = started (volume), inner = completed | filled portion + % label | by Started | huge bar, tiny fill — visually obvious |
| **C — Completion board** | rate-first list with a circular gauge per game | gauge + center % | by Rate | drops to bottom, red gauge + badge |

All three title-case slugs (`word-flow` → `Word Flow`) and color-code the rate
(green ≥85%, amber ≥60%, red <60%). Mix-and-match is expected — e.g. "table from
A with the funnel bar from B".

## Verdict

**Variant A, stripped down (KM, 2026-06-03).** Make it identical to the Top
events widget: no colors, no badges, no bars, no title-casing — just the shared
overview table with plain numbers. Columns: Game / Started / Completed / Rate.
Default sort by levels started. Aliases kept as separate rows. Copy is brief and
plain.

## Implementation path once chosen (fork-safe, mirrors the retention widget)

- Component: `apps/start/src/components/custom/overview-top-games.tsx`
- Service: `getTopGames()` in `packages/db/src/services/overview.service.ts`
  — `countIf(name='level_started')` / `countIf(name='level_completed')` grouped by
  `properties['game_id']`, scoped to project + date range + filters.
- Procedure: `overview.topGames` in `packages/trpc/src/routers/overview.ts`
  (the shared `overviewProcedure` already handles dashboard auth + `shareId`).
- Register in `apps/start/src/config/overview-widgets.fork.ts` only.
