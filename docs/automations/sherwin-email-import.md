# Daily Sherwin invoice email → Jobber

Gmail at `veenstrapainting@gmail.com` forwards to the Resend inbox (`paint@….resend.app`). Each evening the server reads new mail, parses the Sherwin invoice (including the PDF), and posts an expense on the Jobber job in PO#. The expense notes gallons. An invoice already on the job is updated. The import does not add a job note. SHOP and other non-job POs are skipped. A job that is not in Jobber yet is left unread so the next evening tries again.

Nothing is posted until this is deployed and the schedule runs. A purchase made after 6:00 PM shows up the next evening. Ask in chat to run it sooner.

## Schedule

- **6:00 PM** America/Chicago, every day
- Trigger: GitHub Actions [`sherwin-email-import.yml`](../../.github/workflows/sherwin-email-import.yml) → `POST /sherwin/import` with `apply: true`
- Manual run: GitHub → Actions → *Sherwin email import* → *Run workflow* (tick `dryRun` to plan without writing)
- Uses the same `BOOKKEEPING_NOTIFY_SECRET` as the bookkeeping brief

## What the inbox has to contain

Resend Receiving must be on, and Gmail forwarding to that address must be confirmed. The confirmation message itself is not an invoice. Until a Sherwin invoice arrives, the run reports an empty inbox and writes nothing.

## Chat

`import_sherwin_emails` with `apply: false` shows the plan. `apply: true` writes to Jobber and remembers the email id (`SHERWIN_PROCESSED_EMAIL_IDS`) so the next day does not post it again.
