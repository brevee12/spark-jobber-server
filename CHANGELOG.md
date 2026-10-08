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
