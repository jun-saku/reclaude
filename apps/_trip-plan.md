# Trip planner: plan (not built yet)

One page per trip that replaces the group chat, the plan docs and the expenses spreadsheet. Not published (the build
skips `_` files). Name and URL still to decide (`/apps/trip/`?).

## Stack

- Page `apps/trip/` (own manifest, installs as its own app), plain HTML/JS on `shared/base.css`, like Pickleball.
- Client `shared/trip.js` on `core.app("trip")`, with a `?backend=fake` store.
- Supabase schema `trip`: every change through a checked database function (which also writes the log), row level
  security, pgTAP tests for every policy. Live updates (chat, edits) with Supabase Realtime (already allowed by the CSP).
- Offline: the trip is kept on the device for reading; chat messages typed offline are sent later.
- Risk: the free plan pauses after about a week idle. Plan: a weekly scheduled job keeps it awake (or Pro later).
- Notes with two editors: each section has a version; a stale save is refused and shows the other person's text. No live
  co-editing.
- No new external sources: the currency rate is typed by hand.

## Trip and people

- A planner (with an account, app role `planner`) creates the trip and can add co-planners.
- The planner adds people by name. Only planners add people.
- Join link `?t=<code>`: "Who are you?" → tap a name → the device signs in anonymously and is tied to that name. A taken
  name can't be picked again; the planner can free it (lost phone).
- Signing in to an account links it to your name on the trip (same user id, so data comes along); "My trips" lists them.
- Everyone can add and edit; a planner can lock a section (only planners change it then).
- After the trip: stays editable (to finish settling up); the planner can archive it, which locks everything.
- Currency: a home currency and an optional local one with a rate typed by hand; totals shown in the home currency.

## The page: sections

Like a Notion page: people add sections and move them around. Types: Notes, Itinerary, Chat, Budget, Expenses,
Summary (who owes whom), Checklist, Poll, Links (files later).

### Expenses

- Two kinds of expense:
  - Total: one amount, split equally between the people ticked.
  - Itemized (e.g. "Lunch" receipt): lines, each given to a person with an amount; shared lines (service charge,
    tip) split equally between the people on it.
- One payer by default; "+ someone else chipped in" adds payers with their amounts.
- Each person's share on a receipt can be marked paid; a receipt shows "Settled" once every share is paid.
- Category: a label only. Defaults Stay, Transport, Food, Activities, Shopping, Other; planners add, rename, delete.

### Summary (who owes whom): invoices

- One invoice per pair ("A owes B"): every unpaid share A has on receipts B paid (date, receipt, line, amount),
  subtotal, minus payments already made, = amount due. What B owes A shows as credit lines on the same invoice
  (one net amount per pair).
- Settle either way, kept in sync: paying a share on a receipt removes it from the invoice; paying the invoice marks
  all its lines paid; a partial amount becomes a payment line that lowers what's due.
- Payer taps "I paid" (Pending); receiver taps "Received" (Paid) or "Not received" (reopened). The receiver can also
  mark it received directly (cash). Pending isn't counted as paid until confirmed.
- Invoices are always worked out from the current receipts: if a share went up after it was paid, the difference is
  due again.
- "Settle all" in the summary.

### Budget

- Both: planned line items (Hotel ₱15k, Train ₱3k…) grouped under categories, each compared to actual expenses (a
  line can link to its expense; a category compares to expenses with that label).
- Group budget (total and per person) and a personal budget each (vs that person's own shares).

### Itinerary

- A free list by default; grouping by day is an option (from the trip dates), with unscheduled items shown too.
- An item: title, start time and optional end time (or all day), place with a Google Maps link, note, link.
- Optional details, added only when set (nothing stored otherwise): who's going (a subset of people) and a cost
  estimate (feeds the budget; can become an expense later).
- Anyone can mark "Not going" / "Not interested" on an item (and undo it).

### Chat

- One chat per trip, plus a comment thread on any item (itinerary item, expense, poll), linked from the chat.
- Emoji reactions and replies; @name mentions (highlighted for that person).
- Pin a message to a section: it becomes a note, itinerary item or poll option.
- Photos later (needs file storage).

### Checklist

- Shared to-dos (e.g. book the hotel): can be given to someone, optional due date.
- Packing list: one list, each person ticks their own copy.

### Poll

- Single or multiple choice; anyone can add options unless locked.
- Date poll: everyone picks the dates that work; the best ones are highlighted; a planner can make them the trip dates.
- A planner closes a poll; the winning option can become an itinerary item.

### Links between things

- One `links` table joins any two things on the trip: a note, itinerary item, expense, budget line, checklist item,
  poll. Both ends show it ("Linked: Lunch receipt ₱3,200"), and a tap opens the other.
- In a note, type `+` or tap "Link" to pick a thing; it shows as a chip inside the text. From an item, "Link a note"
  (an existing one or a new one).
- Deleting a thing removes its links, not the other thing. Links are logged.

### Notes and Links

- Notes: simple formatting (headings, bold, lists, links), written without a library.
- Links: bookings, tickets and other links with a title. File uploads later.

## Activity log (planners only)

- Every database function writes a log row in the same step (can't be skipped or faked): when, who (person and linked
  account), action (`expense.edit`, `section.delete`, `person.claim`…), what it's about, old and new values.
- Deleted things are kept in the log. Logged: edits, deletes, joins, freeing a name, planner changes, "I paid" and
  confirmations. Not logged: each chat message and vote (only their edits and deletes).
- Only planners can read it (row level security, tested). Nobody can change or delete it. A "Log" tab for planners,
  newest first, filter by person and section, each entry links to its thing.

## PRs (one each)

1. Schema, people, join flow, log, tests.
2. Page with sections: Notes and Itinerary, and the Log tab.
3. Chat (Realtime).
4. Expenses, Summary and invoices, then Budget.
5. Checklist and Poll.
6. Offline copy, "My trips", keep-awake job.
