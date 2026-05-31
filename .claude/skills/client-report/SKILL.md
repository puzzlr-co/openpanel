---
name: client-report
description: Produce a markdown slide-deck snapshot for a Puzzlr client deployment — engagement, retention, game popularity, country mix, with anonymous peer comparisons and methodology guardrails baked in. Use when the user asks to write a client report, snapshot, or monthly update for a project slug (e.g. "write the report for azet", "client snapshot for bild", "monthly for tages-anzeiger").
---

# Client Report

Goal: produce a non-technical, client-shareable markdown deck that tells the true story of a Puzzlr deployment — and refuses to overclaim on the things our anonymous-by-design analytics cannot prove.

## Inputs

The user names a **project slug** (e.g. `azet`, `bild`, `tages-anzeiger`) and optionally a window. Default window: launch → today.

If unclear, ask once for the slug; never guess.

## Output

Single markdown file at `~/Downloads/<slug>-analytics-v0/<slug>-snapshot-<YYYY-MM>.md`.

10 slides, in the order specified in [template.md](template.md).

## Workflow

### 1. Confirm scope

- Resolve "today" from the data: `SELECT max(created_at) FROM events WHERE project_id = '<slug>'`. Do not assume.
- Detect the **production launch date** — the first day daily session volume crossed ~100 sessions/day (test traffic before that is excluded from "first week" framing).
- Confirm the slug exists. If it returns 0 rows, stop and ask.

### 2. Pull data

Run the queries in [queries.md](queries.md), in order. Batch related queries in parallel where possible.

The standard set covers: scale & date range, game catalog & sessions, country mix, daily DAU/sessions, weekly trajectory, returning-rate climb, tenure composition, cohort-survival by first-visit date, day-of-week normalised, tutorial funnel.

### 3. Apply the methodology guardrails

Before writing a single sentence, read [methodology.md](methodology.md). Every guardrail there exists because a prior report got it wrong.

Quick-check list (the traps that have actually been hit):

- **Never use lifetime `uniqExact(device_id)` as a "reach" headline** — the salt rotates daily. Lead with weekly-active instead.
- **`session_started` carries no per-user ID for authenticated traffic** — never claim "per-user" retention or "X sessions per user." Cohort numbers are session attribution by first-visit date, not retention curves.
- **"0% → X% returning" conflates pre-launch test traffic with the production story.** Anchor to the first production week (typically ~20–25% returning).
- **Day-of-week totals are biased by occurrence count and one-off promos.** Always report per-day averages and call out spike days.
- **Country `uniq(device_id)` shares are reliable; absolutes are not.** Include the methodology note on the country slide.
- **No named peer comparisons.** Use "fleet median," "Peer A/B/C," or "across active Puzzlr deployments."
- **Never claim something the data does not show.** No "first big marketing push" without confirmation; no "opt-in" unless verified for that integration.

### 4. Write the deck

Use [template.md](template.md) verbatim for structure. Fill placeholders from the query output. Keep the section voice — direct, non-technical, no "executive brief" / "stakeholders" / "fleet" jargon.

### 5. Final polish for non-technical readers

Last pass before saving:

- Replace jargon: "production traffic" → "live traffic"; "monotonic" → "rising every week"; "cohort" → "group of visitors"; "feature placement" → "promoted on the homepage."
- Methodology notes belong on the slide they qualify (Slide 04 for country, Slide 07 View 3 for cohort survival), written as "how to read this" — not as footnotes.
- Collapse repetition. If three Big Number slides feel padded at this scale, collapse them into one three-up recap.
- Read the closing slide aloud. If a non-technical colleague couldn't paraphrase it to a client, rewrite it.

### 6. Report back

State: file path saved, headline numbers (weekly active, completion %, returning %), one sentence on the story arc, and any claims you deliberately did not make (and why).

## What this skill does not do

- It does not generate HTML decks. Markdown only. (The user can request an HTML pass separately.)
- It does not write or update production data — read-only ClickHouse queries.
- It does not invent peer benchmarks. If you don't have a number, say so.
