# QuickBooks posting log

Every write made to QuickBooks through the MCP server (from approvals in the
Cursor chat). Newest first. Each QBO record's memo also carries the bank
description and SimpleFIN id, so it can be found in QBO by searching the memo.

**Undo:** `qbo_delete_transaction` with the QBO id (Purchase or Deposit), or
delete the record in QBO. Transfers: delete in QBO.

**Adding entries:** after any approved write batch, the agent appends a section
here (date, brief #, what, QBO ids) and commits it.

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
