# Morning bookkeeping email (Cursor Automation)

Stage-only daily brief for Veenstra Painting. Emails Brennan a numbered §1/§2/§3 summary; he approves by number **in Cursor chat** (not Slack). Nothing posts to QuickBooks until a separate write Allow.

## Schedule

- Suggested: weekdays ~7:00 America/Chicago
- Trigger: Cursor Automation cron → this agent / MCP server

## Env (Render + automation)

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key (required to send) |
| `RESEND_FROM` | Verified from-address |
| `BOOKKEEPING_NOTIFY_EMAIL` | Default `brennan@veenstrapainting.com` |
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
   - dryRun: false
   - agentUrl: <this chat / agent URL if not already in CURSOR_AGENT_URL>

2. Do NOT call qbo_create_expense, qbo_create_deposit, qbo_create_transfer, or qbo_delete_transaction.
   This run is stage-only.

3. If the tool returns blocked/health_gate, report the issues (SimpleFIN, QBO, or RESEND_API_KEY) and stop.

4. If sent:ok, reply with the Resend message id and itemCount only — Brennan already has the email.

5. When Brennan later replies with "approve 1,3" / "skip 2" in this chat, map numbers to the staged lines from the brief and only then propose QBO write tools (separate Allows). Credit-card refunds/credits stay feed-only (doNotPostViaApi).
```

## Email shape

- **§1** Cash snapshot (Checking / LOC / CC)
- **§2** Numbered bank staging lines (category + short treatment)
- **§3** Cursor link + approve-by-number instructions

## Health gate

`POST /bookkeeping/notify` and `email_bookkeeping_brief` refuse to send when SimpleFIN or QBO is down, or when `RESEND_API_KEY` is missing (unless `dryRun: true`, which still requires data sources).
