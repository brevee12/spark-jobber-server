# Biweekly bookkeeping email (Cursor Automation)

Stage-only brief for Veenstra Painting per [`../skills/spark-cfo-cursor.md`](../skills/spark-cfo-cursor.md). Emails a numbered §1/§2/§3 summary **grouped by account** (bootstrap: `brevee12@gmail.com` via Resend test sender); approve by number **in Cursor chat** (not Slack). Nothing posts to QuickBooks until a separate write Allow.

## Schedule

- **Tue 11:59 PM** and **Fri 3:30 PM** America/Chicago (Spark CFO skill cadence)
- Trigger: Cursor Automation cron → this agent / MCP server

## Env (Render + automation)

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key (required to send) |
| `RESEND_FROM` | Bootstrap: `Veenstra Bookkeeping <onboarding@resend.dev>` (later: verified domain) |
| `BOOKKEEPING_NOTIFY_EMAIL` | Bootstrap default `brevee12@gmail.com` (later: `brennan@veenstrapainting.com`) |
| `CURSOR_AGENT_URL` | Link to this Cursor agent/chat for approve-by-number |
| `BOOKKEEPING_NOTIFY_SECRET` | Optional auth for HTTP notify |

Also requires live **SimpleFIN** + **QBO** on the MCP server (Jobber optional for this brief).

## Preferred call (MCP)

```
email_bookkeeping_brief
  includeProcessed: false   # only unseen bank lines
  dryRun: false
```

Equivalent HTTP (after deploy):

```bash
curl -sS -X POST https://spark-jobber-server.onrender.com/bookkeeping/notify \
  -H 'Content-Type: application/json' \
  -H "x-bookkeeping-notify-secret: $BOOKKEEPING_NOTIFY_SECRET" \
  -d '{}'
```

## Automation prompt (paste into Cursor Automations)

```
You are the Veenstra Painting morning bookkeeping runner.

1. Call MCP tool email_bookkeeping_brief with:
   - includeProcessed: false
   - excludeBookedInQbo: true   # real outstanding = not already in QBO
   - dryRun: false
   - agentUrl: <this chat / agent URL if not already in CURSOR_AGENT_URL>
   - startDate optional (server defaults to last 14 days — SimpleFIN needs a start-date)

2. Do NOT call qbo_create_expense, qbo_create_deposit, qbo_create_transfer, or qbo_delete_transaction.
   This run is stage-only.

3. If the tool returns blocked/health_gate, report the issues (SimpleFIN, QBO, or RESEND_API_KEY) and stop.

4. If sent:ok, reply with the Resend message id and itemCount only — Brennan already has the email.

5. When Brennan later replies with "approve 1,3" / "skip 2" in this chat:
   - Call bookkeeping_mark_seen with those transaction ids (durable:true) so they are not re-emailed.
   - Only propose QBO write tools (separate Allows) for lines that are NOT doNotPostViaApi / feed-only.
   - Credit-card charges/refunds stay feed-only — approve means clear in the QBO Banking feed; never also qbo_create_* (duplicates).
```

## Email shape

- **§1** Cash snapshot (Checking / LOC / CC)
- **§2** Numbered bank staging lines (category + short treatment)
- **§3** Cursor link + approve-by-number instructions

## Health gate

`POST /bookkeeping/notify` and `email_bookkeeping_brief` refuse to send when SimpleFIN or QBO is down, or when `RESEND_API_KEY` is missing (unless `dryRun: true`, which still requires data sources).
