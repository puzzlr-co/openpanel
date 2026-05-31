# Query playbook — Puzzlr client snapshot

Connection (from project memory): pipe the SQL over stdin to avoid nested-quote mangling —
`ssh root@91.98.228.238 'docker exec -i self-hosting-op-ch-1 clickhouse-client -d openpanel --query="<SQL>"'`. Read-only (SELECT only; clear any write with the user first).

Substitute `<slug>` and date placeholders before running.

**Quoting gotcha (validated):** through the nested ssh + docker quoting, a bare `BETWEEN '<start>' AND '<end>'` silently matches **0 rows** instead of erroring — a report built on that is silently empty and wrong. Always bound dates with explicit comparisons and a type-wrapped literal: `toDate(created_at) >= toDate('<start>') AND toDate(created_at) <= toDate('<end>')`. After every windowed query, sanity-check the row count is non-zero before trusting it. The queries below already use this form.

## 0. Confirm scope

```sql
SELECT count() AS events,
       min(created_at) AS first_event,
       max(created_at) AS last_event
FROM openpanel.events
WHERE project_id = '<slug>';
```

Use `last_event` as "today". If `events = 0`, stop and ask.

## 1. Game catalog & lifetime sessions per game

```sql
SELECT properties['game_id'] AS game_id,
       count() AS sessions,
       min(created_at) AS first_seen,
       max(created_at) AS last_seen
FROM openpanel.events
WHERE project_id = '<slug>' AND name = 'session_started'
GROUP BY game_id
ORDER BY sessions DESC;
```

Filter the result to the real games (boxr, circuit, sudoku, color-connect, guessr, quizr, shiftr, crossword). Drop UUID-looking rows — those are test/dev artefacts.

## 2. Detect production launch

```sql
SELECT toDate(created_at) AS day,
       uniq(device_id) AS dau,
       countIf(name = 'session_started') AS sessions
FROM openpanel.events
WHERE project_id = '<slug>'
GROUP BY day
ORDER BY day;
```

Production launch = first day daily sessions cross ~100. Earlier traffic is internal/test.

## 3. Country mix (lifetime)

```sql
SELECT country,
       uniq(device_id) AS devices,
       count() AS events
FROM openpanel.events
WHERE project_id = '<slug>'
GROUP BY country
ORDER BY devices DESC
LIMIT 15;
```

Use shares, not absolutes (see [methodology.md](methodology.md)).

## 4. Per-game completion quality

```sql
SELECT s.game, s.started, c.completed,
       round(100.0 * c.completed / s.started, 1) AS completion_pct
FROM (
  SELECT properties['game_id'] AS game, count() AS started
  FROM openpanel.events
  WHERE project_id = '<slug>' AND name = 'level_started'
  GROUP BY game
) s
LEFT JOIN (
  SELECT properties['game_id'] AS game, count() AS completed
  FROM openpanel.events
  WHERE project_id = '<slug>' AND name = 'level_completed'
  GROUP BY game
) c USING game
ORDER BY started DESC;
```

## 5. Last-week game mix

```sql
SELECT properties['game_id'] AS game, count() AS sessions
FROM openpanel.events
WHERE project_id = '<slug>'
  AND name = 'session_started'
  AND toDate(created_at) >= toDate('<last_week_start>') AND toDate(created_at) <= toDate('<last_week_end>')
GROUP BY game
ORDER BY sessions DESC;
```

## 6. Weekly trajectory

```sql
SELECT toMonday(toDate(created_at)) AS week,
       uniq(device_id) AS wau,
       countIf(name = 'session_started') AS sessions,
       countIf(name = 'level_started') AS levels_started,
       countIf(name = 'level_completed') AS levels_completed
FROM openpanel.events
WHERE project_id = '<slug>'
  AND toDate(created_at) >= '<production_launch_date>'
GROUP BY week
ORDER BY week;
```

## 7. Returning-rate trend (weekly) — with new-visitor volume

```sql
SELECT toMonday(toDate(created_at)) AS week,
       round(100.0 * countIf(toUInt32OrZero(properties['days_since_first_visit']) > 0) / count(), 1) AS returning_pct,
       countIf(toUInt32OrZero(properties['days_since_first_visit']) = 0) AS new_visitor_sessions,
       count() AS total
FROM openpanel.events
WHERE project_id = '<slug>' AND name = 'session_started'
GROUP BY week
ORDER BY week;
```

Anchor narrative to first production week, not pre-launch test weeks. **Read `returning_pct` against `new_visitor_sessions`:** returning rate is a share, so a jump in new visitors mechanically lowers it without anyone churning (acquisition dilution — see [methodology.md](methodology.md) §3). A falling share during a new-visitor surge is dilution, not decline. Never report "rising every week" unless the column literally rises every week.

## 8. Tenure composition (last full week)

```sql
SELECT CASE
         WHEN dsf = 0 THEN '0_day_0'
         WHEN dsf BETWEEN 1 AND 7 THEN '1_1to7d'
         WHEN dsf BETWEEN 8 AND 30 THEN '2_8to30d'
         WHEN dsf BETWEEN 31 AND 60 THEN '3_31to60d'
         ELSE '4_60plus'
       END AS band,
       count() AS sessions
FROM (
  SELECT toUInt32OrZero(properties['days_since_first_visit']) AS dsf
  FROM openpanel.events
  WHERE project_id = '<slug>'
    AND name = 'session_started'
    AND toDate(created_at) >= toDate('<last_week_start>') AND toDate(created_at) <= toDate('<last_week_end>')
)
GROUP BY band ORDER BY band;
```

## 9. Cohort survival — session attribution by first-visit date

```sql
SELECT toDate(created_at - INTERVAL toUInt32OrZero(properties['days_since_first_visit']) DAY) AS first_visit_date,
       count() AS sessions
FROM openpanel.events
WHERE project_id = '<slug>'
  AND name = 'session_started'
  AND toDate(created_at) >= toDate('<last_week_start>') AND toDate(created_at) <= toDate('<last_week_end>')
GROUP BY first_visit_date
ORDER BY first_visit_date;
```

**This is session attribution, not a retention curve.** Frame accordingly (see [methodology.md](methodology.md)). Note the right edge is censored: the most-recent `first_visit_date` rows cover visitors who arrived only a day or two ago and have barely had time to return, so they always read low — that is timing, not a worse group. Read the established dates, not the trailing edge.

## 10. Day-of-week, occurrence-normalised

```sql
SELECT toDayOfWeek(toDate(created_at)) AS dow,
       count() AS sessions,
       count(DISTINCT toDate(created_at)) AS day_occurrences,
       round(count() / count(DISTINCT toDate(created_at)), 0) AS avg_sessions_per_day
FROM openpanel.events
WHERE project_id = '<slug>'
  AND name = 'session_started'
  AND toDate(created_at) >= toDate('<production_launch_date>') AND toDate(created_at) <= toDate('<today>')
GROUP BY dow
ORDER BY dow;
```

Report `avg_sessions_per_day`, never raw `sessions`. Call out promo-spike days that inflate any weekday.

## 11. Tutorial funnel

```sql
SELECT name, count()
FROM openpanel.events
WHERE project_id = '<slug>'
  AND name IN ('tutorial_started','tutorial_completed','tutorial_skipped')
GROUP BY name;
```

Resolution rate = `(completed + skipped) / started`. Skip ≠ failure.

## 12. Sanity: auth vs anonymous split

```sql
SELECT properties['is_authenticated'] AS is_auth, count() AS sessions
FROM openpanel.events
WHERE project_id = '<slug>' AND name = 'session_started'
GROUP BY is_auth ORDER BY sessions DESC;
```

If the project is >90% authenticated, the cohort-survival signal is strong (one identity system carries it). Below 50%, retention narrative is weaker — flag it.

## 13. Sanity: identifier presence on session_started

```sql
SELECT properties, profile_id, device_id, session_id
FROM openpanel.events
WHERE project_id = '<slug>' AND name = 'session_started'
LIMIT 3 FORMAT Vertical;
```

If `profile_id` / `device_id` / `session_id` are empty on authenticated traffic, you have no per-user identifier. Adjust retention framing per [methodology.md](methodology.md).
