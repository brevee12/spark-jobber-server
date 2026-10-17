# QuickBooks posting log

Every write made to QuickBooks through the MCP server (from approvals in the
Cursor chat). Newest first. Each QBO record's memo also carries the bank
description and SimpleFIN id, so it can be found in QBO by searching the memo.

**Undo:** `qbo_delete_transaction` with the QBO id (Purchase or Deposit), or
delete the record in QBO. Transfers: delete in QBO.

**Adding entries:** after any approved write batch, the agent appends a section
here (date, brief #, what, QBO ids) and commits it.

## 2026-10-17 — Brief approvals (#3–#15; checks left alone)

Checks #1 (1485, $800) and #2 (1483, $1,285) were not posted.

| QBO id | Type | Date | Account | Category | Amount | Brief # |
| --- | --- | --- | --- | --- | --- | --- |
| 18631 | Credit Card Credit | 2026-10-12 | CC-Capital One (4558) | Job Supplies | 64.67 | 10 MENARDS ALTOONA IA |
| 18632 | Credit Card Credit | 2026-10-13 | CC-Capital One Spark (7296) | Car & Truck | 1.00 | 14 RBT-CASEYS |
| 18633 | Credit Card Credit | 2026-10-13 | CC-Capital One Spark (7296) | Car & Truck | 0.20 | 15 RBT-CASEYS |
| 18634 | Transfer | 2026-10-15 | Checking-Marion County Bank (3696) → CC-Capital One Spark (7296) | Transfer | 5,628.17 | 12 CAPITAL ONE AUTOPAY PYMT |

Banking: **Match** the Menards credit, both Casey's rebates, and the Spark autopay feed line to these records. Do not add them again.

Feed-only card charges, clear in the QBO Banking feed (do not post again):

| Brief # | Date | Description | Amount | Category |
| --- | --- | --- | --- | --- |
| 3 | 2026-10-15 | WENDY'S 4410 | 12.51 | Meals & Entertainment |
| 4 | 2026-10-14 | CASEYS #3566 | 83.43 | Car & Truck |
| 5 | 2026-10-14 | KWIK STAR #1727 | 116.35 | Car & Truck |
| 6 | 2026-10-14 | CASEYS #3214 | 108.33 | Car & Truck |
| 7 | 2026-10-14 | CASEYS #3214 | 1.81 | Meals & Entertainment |
| 8 | 2026-10-14 | KWIK STAR #1727 | 106.39 | Car & Truck |
| 9 | 2026-10-13 | RIVERSIDE FAMILY RESTAURA | 10.53 | Meals & Entertainment |
| 11 | 2026-10-12 | MENARDS ALTOONA IA | 40.78 | Job Supplies |
| 13 | 2026-10-14 | The Sherwin-Williams C | 5,473.62 | Job Supplies |

## 2026-10-13 — Brief approvals (all except checks #2 and #3)

| QBO id | Type | Date | Account | Category | Amount | Brief # |
| --- | --- | --- | --- | --- | --- | --- |
| 18614 | Credit Card Credit | 2026-10-01 | CC-Capital One (4558) | Job Supplies | 25.12 | 18 WAL-MART #0751 |
| 18612 | Credit Card Credit | 2026-10-07 | CC-Capital One Spark (7296) | Car & Truck | 1.00 | 23 RBTfuelmanusa |
| 18613 | Credit Card Credit | 2026-10-07 | CC-Capital One Spark (7296) | Car & Truck | 1.00 | 24 RBTfuelmanusa |

Banking: **Match** those three credit feed lines to these records. Do not add them again.

Checks #2 (1485, $800) and #3 (1483, $1,285) were left unposted for manual entry.

The other approved lines are feed-only. Clear them in the QBO Banking feed. Do not post them again: #1 and #4 match existing Intuit payroll tax payments; #5–17 and #19–22 are card charges.

## 2026-10-08 — FasTool refund (brief #21)

| QBO id | Type | Date | Account | Category | Amount | Bank line |
| --- | --- | --- | --- | --- | --- | --- |
| 18609 | Credit Card Credit | 2026-09-23 | CC-Capital One Spark (7296) | Small Tools & Equipment | 159.10 | PAYPAL *FASTOOL INC FA |

Banking: **Match** the Spark +159.10 feed line to 18609.

## 2026-10-07 — Brief approvals (all except #8, #10, #20)

| QBO id | Type | Date | From | To / Category | Amount | Brief # |
| --- | --- | --- | --- | --- | --- | --- |
| 18594 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 1,685.28 | 1 |
| 18595 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 1,950.48 | 2 |
| 18596 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 1,674.19 | 4 |
| 18597 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 176.76 | 5 |
| 18598 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 1,390.95 | 6 |
| 18599 | Expense (Check) | 2026-09-17 | Checking-Marion County Bank (3696) | Wages | 1,590.95 | 7 |
| 18600 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 1,841.21 | 11 |
| 18601 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 1,613.65 | 13 |
| 18602 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 1,612.49 | 14 |
| 18603 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 1,590.96 | 15 |
| 18604 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 1,390.96 | 16 |
| 18605 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 212.96 | 17 |
| 18606 | Expense (Check) | 2026-09-02 | Checking-Marion County Bank (3696) | Wages | 119.81 | 18 |
| 18607 | Transfer | 2026-09-15 | Checking-Marion County Bank (3696) | CC-Capital One Spark (7296) | 11,433.24 | 9 + 22 |

Verified after posting: 15 bank lines matched these 14 records (the transfer
covers both feed sides); no duplicates.

Not posted (pending Brennan): #3 and #12 payroll tax (account?), #19 IA Dept of
Rev $470.75 (sales tax vs withholding?). Skipped: #8, #10, #20.

## 2026-10-07 — First 6 approvals

Feed-only approvals: no QuickBooks API writes. Marked processed so they are not
re-emailed; cleared by Brennan in QBO Banking.
