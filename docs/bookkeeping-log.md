# QuickBooks posting log

Every write made to QuickBooks through the MCP server (from approvals in the
Cursor chat). Newest first. Each QBO record's memo also carries the bank
description and SimpleFIN id, so it can be found in QBO by searching the memo.

**Undo:** `qbo_delete_transaction` with the QBO id (Purchase or Deposit), or
delete the record in QBO. Transfers: delete in QBO.

**Adding entries:** after any approved write batch, the agent appends a section
here (date, brief #, what, QBO ids) and commits it.

## 2026-11-05 — Brief approvals (all 11)

| QBO id | Type | Date | Account | Category | Amount | Brief # |
| --- | --- | --- | --- | --- | --- | --- |
| 18851 | Transfer | 2026-10-22 | Checking-Marion County Bank (3696) → CC-Capital One (4558) | Transfer | 2,322.27 | 4 CAPITAL ONE AUTOPAY PYMT |
| 18852 | Expense (Credit Card) | 2026-10-29 | CC-Capital One Spark (7296) | Office Supplies & Software | 5.00 | 7 RAILWAY |
| 18853 | Credit Card Credit | 2026-10-27 | CC-Capital One Spark (7296) | Car & Truck | 1.00 | 8 RBT-CASEYS |

Banking: **Match** the Spark Cash +2,322.27 feed line to transfer 18851, the Spark Cash Plus −5.00 Railway line to 18852, and the +1.00 Casey's line to 18853. Do not add them again.

The checking feed has no October activity (last line is 2026-09-22), so the checking side of this autopay was not in SimpleFIN. No QuickBooks record of $2,322.27 existed within a day of 2026-10-22 before this transfer.

There is no account named Software. Railway is coded to Office Supplies & Software.

The other approved lines are feed-only. Clear them in the QBO Banking feed. Do not post them again:

| # | Date | Account | Description | Amount | Category |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-02 | Spark Cash (4558) | MENARDS ALTOONA IA | -243.32 | Job Supplies |
| 2 | 2026-10-30 | Spark Cash (4558) | SUBWAY 7713 | -23.10 | Meals & Entertainment |
| 3 | 2026-10-28 | Spark Cash (4558) | VZWRLSS*APOCC VISB | -744.49 | Cell Phone Expense |
| 5 | 2026-10-30 | Spark Cash Plus (7296) | STATE FARM INSURANCE | -1,200.59 | Insurance |
| 6 | 2026-10-30 | Spark Cash Plus (7296) | STATE FARM INSURANCE | -76.73 | Insurance |
| 9 | 2026-10-22 | Spark Cash Plus (7296) | PAYPAL *QUICKBOOKS | -233.26 | Office Supplies & Software |
| 10 | 2026-10-22 | Spark Cash Plus (7296) | JOBBER | -373.43 | Office Supplies & Software |
| 11 | 2026-10-14 | Spark Cash Plus (7296) | The Sherwin-Williams C | -5,473.62 | Job Supplies |

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
