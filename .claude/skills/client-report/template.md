# Deck template — Puzzlr client snapshot

10 slides, markdown, written for a non-technical reader (the colleague who will paraphrase it to the client).

Replace `<…>` placeholders. Drop any slide whose data is missing rather than half-filling it.

---

# <Client> × Puzzlr — Snapshot

Slide 01 · Cover
---

**<Client> × Puzzlr**

State of play after <N> weeks of live traffic.

*From soft launch on <DD Mon YYYY> to <DD Mon YYYY>.*

---

Slide 02 · State of play
---

One paragraph orienting the reader. Lead with the strongest one or two facts: completion %, returning-rate climb, catalogue size. End with a sentence that frames what the rest of the deck demonstrates.

*Avoid: "executive brief," "stakeholders," product-design jargon like "short loops that resolve" or "compounding usage."*

---

Slide 03 · In four numbers
---

| | |
|---|---|
| **<~weekly active>** | weekly active devices, in recent weeks |
| **<~daily>** | daily active devices, on a typical day |
| **<X%>** | of last week's sessions came from a returning visitor |
| **<Y%>** | of every level started gets finished |

One footer line anchoring the trajectory, written to match what the data actually shows — do not assume it rose. If it climbed and held: "In the first week after launch, N% of sessions were from a returning visitor; <N> weeks later it is M%." If a growth surge pulled the share down, say so plainly: "Returning share moved from N% to M% as a wave of new visitors arrived — that is dilution from growth, not visitors leaving."

*Never lead with lifetime `uniqExact(device_id)`, and never hardcode an upward returning-rate arc — see methodology guardrails §3.*

---

Slide 04 · Reach by country
---

| Country | Devices | Share |
|---|---:|---:|
| 🇨🇨 <Country> | <n> | <p>% |
| … | … | … |

One sentence on the market concentration (e.g. "overwhelmingly single-market" vs "spread across N countries").

*How to read this table: our analytics is privacy-by-design — it identifies devices anonymously and resets that identifier every 24 hours. That means the **shares** between countries are accurate, but the absolute device counts overstate the number of unique humans. Read them as relative ordering, not as a head-count.*

---

Slide 05 · Game popularity
---

**Last week's traffic mix (DD–DD Mon):**

| Game | Sessions | Share |
|---|---:|---:|
| **<game>** | <n> | <p>% |
| … | … | … |

One sentence on the recent trend (rising title, falling title, surprise).

**Lifetime totals, with completion quality:**

| Game | Sessions | Levels finished | Completion rate |
|---|---:|---:|---:|
| <game> | <n> | <n> | <p>% |
| … | … | … | … |

One sentence calling out games clearing 90% completion. Avoid "fleet" jargon — use "Puzzlr's portfolio."

---

Slide 06 · Trajectory
---

Weekly active devices and sessions, since soft launch:

| Week of | Weekly active | Sessions | Levels finished |
|---|---:|---:|---:|
| <date> | <n> | <n> | <n> |
| … | … | … | … |

One sentence on any single-day spikes (with date + game + likely cause: "promoted on the homepage" only if confirmed; otherwise "promoted on a Puzzlr surface"). End with the settled baseline range. If the latest week is still in progress, mark it partial or drop it — a half-finished week is not a downturn (methodology §2, right-censoring).

---

Slide 07 · Retention
---

Up to four views. Drop a view if its signal is weak or contradicts the others.

**View 1 — Returning-rate trend.** Weekly share of sessions from a returning visitor, shown next to that week's new visitors so the share is read in context:

| Week of | Returning rate | New visitors that week |
|---|---:|---:|
| … | …% | … |

One-line summary describing the *actual* shape — rising-and-stable, flat, or diluted-by-growth are all legitimate reads; pick the true one. If new-visitor volume jumped, pair the dip with that context so it reads as growth dilution, not churn ("returning share eased from X% to Y% while new visitors roughly N×'d"). Only claim "higher every week" if it is literally true (methodology §3).

**View 2 — Tenure composition (last full week).** Where last week's traffic came from, by visitor age:

| Visitor age at session | Sessions | Share |
|---|---:|---:|
| Day 0 (first visit) | <n> | <p>% |
| 1–7 days old | <n> | <p>% |
| 8–30 days old | <n> | <p>% |
| 31–60 days old | <n> | <p>% |
| 60+ days old | <n> | <p>% |

One sentence on the share of traffic from visitors older than a week.

*This is the most trustworthy retention view in the deck: a plain headcount of sessions by visitor age, with no denominator or ratio. Unlike View 1 (a share that an acquisition surge dilutes) and View 3 (whose recent edge is censored), it cannot manufacture a fake spike or a fake cliff. When those views get murky, lean on this one.*

**View 3 — The early visitors are still here.** Each session is stamped with the visitor's first-ever visit date. Below: sessions during last week, grouped by when those visitors *originally* arrived.

| First arrived on | Sessions during last week | Age of group |
|---|---:|---|
| <date> | <n> | <range> |

One sentence noting that every weekly group since launch is still producing sessions.

*How to read this view: the analytics tells us, for each session, the date that visitor first arrived — but for privacy reasons it does not give us a stable per-person ID. So the numbers above are total sessions attributable to each starting date, not "% of that group who came back." It is a strong directional signal that early visitors are still active; it is not a full retention curve. The most recent arrival dates are also still filling in — someone who first arrived in the last day or two has barely had time to return, so the newest rows read low for timing reasons, not because those visitors are worse. Read the established dates, not the trailing edge.*

**View 4 — Day-of-week shape.** Average sessions per day, averaged across the production window:

| Day | Avg sessions/day |
|---|---:|
| Mon | <n> |
| … | … |

One sentence on the shape (weekend dip / midweek peak / flat). If any weekday total is inflated by a single promo day, call it out and give the adjusted number.

---

Slide 08 · Onboarding quality
---

| Step | Count |
|---|---:|
| Tutorial started | <n> |
| Tutorial completed | <n> |
| Tutorial deliberately skipped | <n> |

"<resolution_pct>% of visitors who open a tutorial resolve it deliberately" — completed or actively closed. Comment on the silent-drop share vs Puzzlr norm.

---

Slide 09 · The numbers that matter
---

| | |
|---|---|
| **<~weekly active>** weekly active | One sentence framing what this means for the client. |
| **<Y%>** level completion | One sentence on what this proves. |
| **<X% → X%>** returning | One sentence on the trajectory. |

*Three rows. Not three slides. Collapse when scale is small.*

---

Slide 10 · Closing
---

**What this dataset says about the partnership, plainly:**

- One bullet on the audience.
- One bullet on the games.
- One bullet on the habit.
- One bullet on what the catalogue can support next.

One closing sentence framing the warm audience available for whatever comes next.

---

*Source: Puzzlr analytics, <date range>. Identity is anonymous and privacy-preserving by design; see the methodology notes on Slides 04 and 07 for what that does and does not allow us to claim.*
