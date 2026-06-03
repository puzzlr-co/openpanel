# Events widget — in-page property drill-down

## Question
The Overview/Share "Events" widget listed top events but gave no way to see an
event's **properties** without leaving the page. How should properties be
surfaced, aligned with the existing widget UI/UX?

## Decision
**Drill-down (master/detail inside the card).** Chosen 2026-06-03 after a
3-variant `?variant=` prototype (inline-expand / drill-down / popover-peek).
Drill-down won — it reuses the real overview table (volume bars, sortable
columns) for the value distribution, so it reads as native Openpanel, and it
maps 1:1 to the data model: `event -> property key -> values`.

Navigation:
```
events list  ->  property keys for the event  ->  value distribution for a key
```
Clicking an event replaces the old navigate-out-to-explorer behavior. That
escape hatch is preserved as an "open in explorer" icon in the breadcrumb
(dashboard only; hidden in the public share context).

## Implementation (fork-safe)
- **UI:** `overview-top-events-properties.tsx` (this folder). Swapped into the
  `top-events` slot in `config/overview-widgets.fork.ts`. Upstream
  `overview/overview-top-events.tsx` is left untouched for clean upstream pulls.
- **Backend (fork-only, appended — not edits to upstream logic):**
  - `OverviewService.getEventPropertyKeys` — distinct, range/filter-scoped
    property keys for an event (excludes internal `__*` keys).
  - `OverviewService.getEventPropertyValues` — value distribution for an
    event + key. Generic form of the existing `getTopLinkOut`.
  - tRPC: `overview.topEventPropertyKeys` / `overview.topEventPropertyValues`,
    both on the share-safe `overviewProcedure`, appended after `topGames`.
- All property data respects the overview range + filters, like the rest of the
  widget. The user-supplied property key is escaped into the ClickHouse Map
  accessor (`properties[<escaped>]`) to avoid injection.
