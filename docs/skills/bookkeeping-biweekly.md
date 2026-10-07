# Biweekly bookkeeping categorize (Cursor)

**Full skill:** [`spark-cfo-cursor.md`](./spark-cfo-cursor.md) (from Brennan’s Spark/Gemini CFO instructions).

End goal: **twice a week** (Tue 11:59 PM / Fri 3:30 PM), stage only lines that still need categorizing — not a month-end backlog. Golden Rule: never guess; stage exceptions for approval.

## What “outstanding” means

QuickBooks **For Review** is not available via the QBO API. So we:

1. Pull the **current SimpleFIN bank feed** per account (default lookback ~45 days so stalled accounts still show — e.g. Marion County checking’s ~31 open feed lines).
2. Compare each feed line to posted QBO activity (`Purchase`, `Deposit`, `Transfer`, `JournalEntry`, `BillPayment`, `Payment`) by **amount + date (±1 day)** — same idea as QBO’s match vs categorize.
3. Subtract rows already approved/skipped in email (`SIMPLEFIN_PROCESSED_IDS`).
4. **Only lines with no QBO match** are listed for approval (with category suggestions), grouped by account (`N need · M matched · F in feed`).

## Report shape

- **§1** Cash snapshot (+ buyout reserve note when relevant)
- **§2** Numbered staging **grouped by bank/CC account** (global numbers for `approve 1,3`)
- **§3** Cursor link + approve grammar
- Exceptions / sales-tax mismatches / proposed Jobber+QBO push lists per the full skill

## Runner steps

1. `email_bookkeeping_brief` with `includeProcessed: false`, `excludeBookedInQbo: true`, `dryRun: false`, `agentUrl` = this chat.
2. Do **not** call `qbo_create_*` / Jobber expense creates on the stage-only run.
3. On `approve N` / `skip N`: `bookkeeping_mark_seen` (durable) for those ids; only propose writes for non–feed-only lines after confirmation.
4. CC refunds/credits stay feed-only forever.

## Cadence

Tue 11:59 PM and Fri 3:30 PM (America/Chicago) via Cursor Automation → MCP notify. See `../automations/morning-bookkeeping-email.md`.
