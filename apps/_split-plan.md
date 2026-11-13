# Split: plan

A bill splitter for a group (a dinner, a gathering, a trip): who paid, who owes whom, settled up. Its own app at
`/apps/split/`, separate from Trip for now (Trip may use it later; how is open). Not published (the build skips `_`
files).

## Decisions so far

- **Groups**: only accounts make them. The maker is the group's first owner; owners add people by name, make other
  owners (people with a linked account), free a name, remove someone, change the group's details and archive it.
- **Joining**: like Trip. The group's link (`?g=<code>`) shows the names; a phone picks one and is that person (an
  anonymous sign-in is enough). An account can be linked to a name (claimed signed in, or with a hand-over code).
- **Everyone in the group** (as the person they picked) adds, edits and deletes bills, and settles up.
- **Currency**: the group's currency, and optionally a second one with a rate typed by hand. Totals in the group's.
- **Bills**, two kinds:
  - Total: one amount, split equally between the people ticked.
  - Itemized (a receipt): lines, each given to one or more people (split equally between them; a shared line like a
    service charge or tip goes to everyone on it).
  - One payer by default; "+ someone else chipped in" adds payers with their amounts (they add up to the total).
  - A category (a label only): defaults Food, Drinks, Transport, Stay, Activities, Shopping, Other; owners add,
    rename and delete them. A note and a date.
- **Who owes whom** (worked out on the phone from the bills, `apps/split/ledger.js`, unit-tested):
  - On a bill, each person's share is owed to the payers, in proportion to what each paid.
  - **Invoices**: one per pair ("Ann owes Ben"): every unpaid share Ann has on bills Ben paid (date, bill, amount),
    what Ben owes Ann on the same footing as credits, payments already made, and the amount due.
  - **Paying**: a share on one bill, or a whole invoice at once (any amount: a partial payment counts against the
    oldest bills first). The one paying taps "I paid" (pending); the one paid taps "Received" (or "Not received").
    The one paid can also record it directly (cash handed over). Pending payments don't count until confirmed.
  - Everything is worked out from the bills as they are now: a share that grew after it was paid is due again.
- **Log**: every change (bills, payments, people) with old and new values; owners read it.

## PRs

1. Database: groups, people, joining, categories, bills, payments, the log; pgTAP tests.
2. The app: groups, bills (total and itemized), balances and invoices, paying and confirming, people and the link,
   the log; `apps/split/ledger.js` with its tests; its own installable app.
