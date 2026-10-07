# Biweekly bookkeeping categorize (Cursor)

End goal: **twice a week**, stage only the bank/CC lines that still need categorizing — not a month-end backlog.

## What “outstanding” means

QuickBooks **For Review** is not available via the QBO API. So we:

1. Pull SimpleFIN downloads for the lookback window (default last 14 days; catch-up may widen).
2. Subtract rows already posted in QBO (`Purchase`, `Deposit`, `Transfer`, `JournalEntry`, `BillPayment`, `Payment`) by **amount + date (±1 day)**.
3. Subtract rows already approved/skipped in email (`SIMPLEFIN_PROCESSED_IDS`).
4. What’s left = needs a category suggestion for you to clear in the QBO Banking feed (or approve a write when safe).

## Report shape

- **§1** Cash snapshot  
- **§2** Numbered staging **grouped by bank/CC account** (global numbers for `approve 1,3`)  
- **§3** Cursor link + approve grammar  

## Runner steps

1. `email_bookkeeping_brief` with `includeProcessed: false`, `excludeBookedInQbo: true`, `dryRun: false`, `agentUrl` = this chat.  
2. Do **not** call `qbo_create_*` on the stage-only run.  
3. On `approve N` / `skip N`: `bookkeeping_mark_seen` (durable) for those ids; only propose QBO writes for non–feed-only lines.  
4. CC refunds/credits stay feed-only forever.

## Cadence

Weekdays twice weekly (e.g. Mon/Thu ~7am America/Chicago) via Cursor Automation → MCP notify.
