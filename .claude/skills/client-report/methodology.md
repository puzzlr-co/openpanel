# Methodology guardrails

Every rule below exists because a prior client report got it wrong. Read this before writing.

## 1. `device_id` rotates daily

OpenPanel salts `device_id` with `SHAKE256(ua : ip : project_id : salt)` and rotates the salt every day at 00:00 UTC (`apps/worker/src/jobs/cron.salt.ts`). Cross-day continuity is best-effort via Redis session lookup against the previous salt — so a visitor returning after a 24h gap with no active session gets a fresh `device_id`.

**Consequence:**

- `uniqExact(device_id)` over a multi-week window does **not** equal unique humans. It approximates "unique device-day buckets."
- Country **shares** are reliable. Country **absolute counts** are inflated against true population.
- Weekly active devices are trustworthy within the week (salt rotates daily, Redis stitches the boundary).

**Rules:**

- Never lead the deck with a lifetime device count.
- Weekly active is the defensible "reach" headline.
- Include the privacy-by-design note on any slide that shows raw device counts (typically Slide 04).

For comparison: Plausible uses a persistent localStorage `user_id`, which gives true cross-day uniqueness; OpenPanel does not, by design.

## 2. `days_since_first_visit` means the same thing for anon and auth — but it's a tenure mix, not a cohort curve

`session_started` fires once per active day for everyone and carries `days_since_first_visit` (dsfv). The anchor is **first Puzzlr interaction** in both populations — anon reads localStorage `puzzlr_first_visit`; auth reads `users.createdAt`, a puzzlr-internal row lazily created on first interaction (`ensureUserExists`), NOT the upstream SSO account. So dsfv is one consistent metric; **do not split the retention story by auth vs anon, and never call auth dsfv "account age."**

The real limit is what dsfv can express. On the OpenPanel event stream, `profile_id` / `device_id` / `session_id` are empty for auth `session_started`, and anon `device_id` rotates daily — so the events carry no stable per-person key. "Day-N retention" as exposed is therefore:

```
DN+ = share of a period's sessions where days_since_first_visit ≥ N
```

a **tenure-mix / activity-share**, not a sized-cohort curve following one person from Day 1 to Day N. A high D7 blends genuine retention with low new-user acquisition.

**Consequence:**

- You cannot compute "X sessions per user per cohort" or a true % retention curve from the event stream (no sized denominator).
- Numbers grouped by `first_visit_date` are **session attribution**, not user survival.
- (Aside: auth users *do* have a stable identity in the puzzlr DB — `users.lastActiveAt`/`createdAt` — so a true cohort curve is computable there if ever needed. It just isn't on the events.)

**Rules:**

- Never say "per user" / "per visitor" for any cohort metric from the event stream.
- Never say "X% of the launch cohort returned" — we don't have the denominator.
- Frame DN+/cohort views as: "Share of sessions from visitors who first played ≥ N days ago" or "Sessions in week N, grouped by when those visitors first arrived." Add the "how to read this view" paragraph on the slide.
- The qualitative signal (every weekly group still producing sessions; rising returning rate) is real and worth reporting. The per-user magnitude is not available.

## 3. The "0% → X%" trap

Pre-launch test traffic (internal QA, soft sandbox) often shows 0% returning because there's only one event per device. Including that period creates a misleading "0% → 71%" story.

**Rule:** Anchor the returning-rate narrative to the **first production week** — the first week after daily session volume crossed ~100/day. Typical first-production-week returning rate: 20–25%. Use that as the baseline.

## 4. Day-of-week needs occurrence-normalisation

A 6-week window has 6 of each weekday but possibly 7 of one (whichever day the window starts on). Raw totals over-attribute to that day. Worse, a single promo day inflates one weekday by 200–400%.

**Rules:**

- Report `avg_sessions_per_day` (total / number of occurrences of that weekday), not raw totals.
- If any weekday's average is inflated by an outlier promo day, call it out and give the without-promo number.
- The honest claim is usually "weekend dip" (Sat/Sun ~25–35% below weekday baseline), not "midweek peak."

## 5. Anonymous peer comparisons

The user has explicitly required this: never name a peer client in a deck shared with another client.

**Rules:**

- "Fleet median," "Peer A / Peer B / Peer C," "across active Puzzlr deployments."
- Never reveal launch dates, scale, or country mix of another deployment that could uniquely identify it.

## 6. Speculation hygiene

If you don't have evidence for a cause, don't claim one.

**Rules:**

- "Promoted on the homepage" only if confirmed (ask if you don't know — or generalise to "promoted on a Puzzlr surface").
- "Opt-in" only if the integration's consent flow is verified.
- "First marketing push" / "topical news event" / "weather effect" — only with confirmation.
- It is better to say "<DATE> shows a clear single-day spike of X sessions in <game> — likely a promotional placement" than to guess at the mechanism.

## 7. Voice & format

Audience: non-technical colleagues who will paraphrase to the client. Style:

- "Live traffic," not "production traffic."
- "Rising every week," not "monotonic."
- "Group of visitors," not "cohort."
- "Promoted on the homepage," not "feature placement."
- "Visit," "session" — both fine, use consistently.
- Methodology notes belong on the slide they qualify, written as "how to read this," not as footnotes.
- Read every paragraph aloud. If a non-technical colleague couldn't paraphrase it to a client, rewrite.

## 8. What we report when in doubt

- Trust **weekly active** > daily active > lifetime devices.
- Trust **session_started returning_pct** > derived retention curves.
- Trust **per-game completion %** > per-game session counts as a quality signal.
- Trust **tutorial resolution** (completed + skipped) > tutorial completion alone.
- Trust **share of last-week sessions from `days_since_first_visit > 7`** as the strongest habit metric.

## 9. What we do not claim

- Unique human reach (we don't have it).
- Per-user retention curve (we don't have it).
- Cause of any spike without confirmation.
- Comparison to a named peer.
- "Opt-in" unless verified.
- Future projections.
