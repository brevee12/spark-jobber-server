# Changelog

Server changes for the Veenstra Painting Spark / Jobber / QuickBooks MCP server
(`spark-jobber-server` on Render). Newest first. Every entry links to its pull
request, which holds the full diff and test notes.

QuickBooks postings (what was written to the books) are tracked separately in
[`docs/bookkeeping-log.md`](docs/bookkeeping-log.md).

**Adding an entry:** every PR that changes behavior adds a line under
`Unreleased`; when it merges (Render auto-deploys `main`), move it under the
merge date.

## Unreleased

- Scheduled bookkeeping brief via GitHub Actions (Tue 11:59 PM / Fri 3:30 PM Chicago) — no Cursor tokens per run.
- `CHANGELOG.md` and the QuickBooks posting log.

## 2026-10-10

- **Sherwin invoice gallons.** Quantity and can size from the Sherwin invoice replace the guessed gallon count. A 5-gallon can counts as 5. Returns reduce the total. Brushes and other supplies stay at zero gallons. [#29](https://github.com/brevee12/spark-jobber-server/pull/29)
- **Paint gallons on the job.** Each Sherwin expense notes how many gallons were bought, and a pinned job note shows the total. A count is kept only when the same product has an exact one-gallon price; a 5-gallon price is not guessed. [#28](https://github.com/brevee12/spark-jobber-server/pull/28)
- **Job numbers stay job numbers.** Jobber numbers requests, quotes, invoices, and jobs independently. A job lookup matches `Job.jobNumber` exactly, so a quote or invoice with the same digits is left alone. Paint POs still post to that job. [#26](https://github.com/brevee12/spark-jobber-server/pull/26)
- **Paint bills go on the Jobber job.** Sherwin-Williams invoices use PO# as the job number. Those bills are posted as Jobber expenses on that job. SHOP and name POs are skipped, and an invoice already on the job is not posted again. [#25](https://github.com/brevee12/spark-jobber-server/pull/25)

## 2026-10-09

- **Client meetings.** Can read a request and create or reschedule its assessment (on-site meeting) with a time and crew. [#24](https://github.com/brevee12/spark-jobber-server/pull/24)

- **Job hours.** `get_job` now includes Jobber job costing (labour hours) and timesheet entries. [#23](https://github.com/brevee12/spark-jobber-server/pull/23)

- **Quote labor defaults to $60/hr** (Jobber catalog is $55). A different hourly rate is warned. [#22](https://github.com/brevee12/spark-jobber-server/pull/22)
- **Visit create matches Jobber's current API** (local date + timezone, crew on the schedule). Day-of "add a visit" works. [#22](https://github.com/brevee12/spark-jobber-server/pull/22)
- **Crew scheduling by voice/chat.** New `crew_schedule` tool: see a day's visits and crew, add/remove/replace people on a job, move someone off their other jobs that day, reschedule a visit, or add a visit. Nothing is written if a name or job is ambiguous. [#20](https://github.com/brevee12/spark-jobber-server/pull/20)
- **Quote drafts use the Jobber price book.** Line items are matched to Products & Services (catalog id, price, taxable); unknown items are refused unless allowed; rate differences vs the catalog are warned. House style guide from 24 sent quotes: `docs/skills/jobber-quote-style.md`. [#20](https://github.com/brevee12/spark-jobber-server/pull/20), [#21](https://github.com/brevee12/spark-jobber-server/pull/21)
- Read-only Jobber schema lookup used to build the above. [#19](https://github.com/brevee12/spark-jobber-server/pull/19)

## 2026-10-08

- **Credit-card refunds can be posted.** New `qbo_create_cc_credit` posts a Credit Card Credit against the original expense account and refuses duplicates (same amount on the card within ±1 day). Card charges stay feed-only. [#16](https://github.com/brevee12/spark-jobber-server/pull/16)
- **Fix: QuickBooks/Jobber disconnecting after deploys.** Before deleting a "dead" refresh token, the server re-reads the latest saved token and retries with it. [#17](https://github.com/brevee12/spark-jobber-server/pull/17)

## 2026-10-07

- **SimpleFIN rate limit.** Bank data is cached for 4 hours and capped at 12 pulls/day (bridge limit is 24). [#15](https://github.com/brevee12/spark-jobber-server/pull/15)
- **Suggested categories are real QBO accounts.** Suggestions come from QBO payee history, then COA name rules; otherwise "Needs your pick". Transfers booked once clear both feed sides; checks match by check number. [#12](https://github.com/brevee12/spark-jobber-server/pull/12), [#13](https://github.com/brevee12/spark-jobber-server/pull/13), [#14](https://github.com/brevee12/spark-jobber-server/pull/14)
- **Brief layout.** Table per account (#, Date, Description, Amount, Suggested category). [#11](https://github.com/brevee12/spark-jobber-server/pull/11)
- **Outstanding = not already in QBO.** Bank lines are compared to posted QBO activity (±1 day), per account. [#7](https://github.com/brevee12/spark-jobber-server/pull/7), [#8](https://github.com/brevee12/spark-jobber-server/pull/8), [#10](https://github.com/brevee12/spark-jobber-server/pull/10)
- **Bank window** defaults to the last 45 days. [#5](https://github.com/brevee12/spark-jobber-server/pull/5)
- **Approved lines aren't re-emailed** (durable processed-id list). [#6](https://github.com/brevee12/spark-jobber-server/pull/6)
- **Spark CFO skill docs** (original + Cursor version). [#9](https://github.com/brevee12/spark-jobber-server/pull/9)
- **Bookkeeping email brief** via Resend, approve by number in Cursor. [#4](https://github.com/brevee12/spark-jobber-server/pull/4)

## 2026-10-05

- Bank staging notes / treatment per transaction (CC refunds, transfers). [#3](https://github.com/brevee12/spark-jobber-server/pull/3)
- Jobber quotes: line-item replacement and fresh totals after `update_quote`.

## 2026-09-26

- Live Jobber quotes, schedule, and timesheets. [#2](https://github.com/brevee12/spark-jobber-server/pull/2)

## 2026-09-24

- Jobber MCP tools: expense delete, visits, jobs, invoices, quotes. [#1](https://github.com/brevee12/spark-jobber-server/pull/1)
