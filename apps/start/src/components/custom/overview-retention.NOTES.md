# Retention section — design notes

Fork-only overview section (`overview-retention.tsx`), shown on both the
dashboard and share contexts. Promoted from a throwaway prototype (the old
`overview-retention-prototype.tsx` + its DIAGNOSIS/NOTES, now deleted) after the
analysis was validated against production ClickHouse and the live share page on
2026-05-31.

## What ships

Two complementary signals, both derived purely from `days_since_first_visit`
(dsfv) on `session_started` — one GROUP BY scan each, no self-join, no cross-day
identity (the anon id rotates daily, so these are session-denominated **floors**,
not people-retention):

- **Tenure River (stock)** — `overview.tenureSeries`. Sessions per interval split
  by visitor age band (New / 1–7 / 8–30 / 30+ days). No ratio, no denominator →
  cannot manufacture a >100% spike or a fake cliff. The honest headline.
- **Cohort Quality (flow)** — `overview.cohortRetention`. Each point is a join-week
  cohort plotted by its week-N session-activity retention (sessions in life-week N
  ÷ life-week 0). Answers "is the experience itself getting stickier?",
  independent of volume — the one thing the stock signal structurally can't tell
  you.

The dropped prototype variants: **E** (returning-rate headline) is now the
first-class "Returning visitors" metric tile in `overview-metrics.tsx`; its
honest acquisition-dilution reframe lives in that tile's info copy. **H** (curve
overlay) was redundant with Cohort Quality (both flow signals) and was the
noisiest possible comparison — dropped. **Combo** was an E+F packaging — dropped.

## Honesty / production guards

- **Bounded full-history denominators** (`getCohortRetention`): the cohort scan's
  lower bound is a fixed `COHORT_LOOKBACK_DAYS = 180` look-back decoupled from the
  display window — so each shown cohort's full week-0 is counted (no left-censor
  → no >100% artifact), while the scan stays bounded on large projects instead of
  walking full project history.
- **Server-side both-sided censor** (`HAVING`): a *right* guard
  (`addDays(cohort_week, life_week*7+12) <= endDate`) emits a life-week only once
  it is fully elapsed for every member of the cohort-week (members join across all
  7 days, so the latest joiner finishes life-week L at `cohort_week + L*7 + 12`,
  not `+6`). The looser `+6` bound partially censors each cohort's most-recent
  point and fakes a closing cliff (validated: the `2026-04-26` week-4 point read
  6.5% under `+6` vs a true ~16% once fully observed). A *left* guard
  (`cohort_week >= lookbackStart`) drops the cohort straddling the look-back bound,
  whose week-0 denominator would otherwise be truncated into inflated retention at
  the trend's left-most point. Decoupling the look-back from the display window
  does not remove that seam on its own: it moves it to `lookbackStart`, and the
  left guard closes it.
- **`MIN_COHORT_SIZE = 100`**: drops tiny launch-era / instrumentation-seam
  cohorts whose handful of week-0 sessions manufacture >100% retention. An
  absolute floor (the ~100-member trust floor) — a huge client clears it
  trivially; a tiny client honestly falls back to the empty state rather than
  plotting noise.
- **100% cap** on the client pivot — a survivors-more-active blip never renders
  as a >100% spike.
- **Stable, labelled target week**: Cohort Quality pins to `PREFERRED_TARGET_WEEK
  = 4` and only steps *down* when fewer than `MIN_COHORTS_FOR_TREND = 3` cohorts
  have aged that far — so it doesn't silently drift as the date range changes. The
  chosen week is always labelled in the chart.
- **Honest low-sample empty state**: fewer than 3 qualifying cohorts renders a
  "not enough history" state, never a confident 2-point trend line.
- **Trend epsilon** `TREND_EPS = 5pp`: a move is only called Improving/Worsening
  once it clears the noise band.
- **`FloorNote`** under each chart keeps the "conservative floor, not
  people-retention" framing.

## Validated read (tages-anzeiger, share `mUShKS`)

Validated read-only against production ClickHouse twice. As of the original
March-2026 window the Cohort Quality line sat on a stable ~30–55% plateau (a
"strong/stable" read). Re-validated 2026-05-31 with both server censor guards
applied: the picture has genuinely changed. A large acquisition surge began
~2026-03-22 (weekly week-0 size jumps from ~150 in January to 12k+, reaching
80k–108k by mid-May), and the post-surge cohorts retain noticeably less at week 4
(~16–23%) than the January–February cohorts (~32–47%). So Cohort Quality now reads
"Worsening" (≈32% → ≈16% by week 4), and that is honest: newer cohorts really are
stickier-or-not on their own terms, independent of volume. This is acquisition
dilution showing up at the cohort level, exactly the signal the flow widget exists
to surface. The Tenure River still shows a thick, growing long-time base.

No cohort exceeds 100% after the guards; the >100% dsfv-seam cohorts (Nov–early
Jan, all under the 100-session floor) are dropped, the inflated left anchor is
gone, and the right-edge cliff is gone (e.g. the `2026-04-26` week-4 point no
longer renders its partially-censored 6.5%; the last fully-observed point is
`2026-04-19` at 16.2%).

## Possible Phase 2 (deferred)

Fold H's one unique offering — decay-curve *shape* — into Cohort Quality as a
drill-down: click the latest point to overlay the two most-recent mature cohorts
(most-recent vs second-most-recent, post-seam, like-for-like). Not built yet.
