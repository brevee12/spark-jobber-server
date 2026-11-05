# Job search and OneDrive invoices

The office page is [https://spark-jobber-server.onrender.com/archive](https://spark-jobber-server.onrender.com/archive). One search box. Questions are answered from the invoices on file, and a link opens the PDF in OneDrive.

A misspelled product is matched to a real product name. If nothing is on file, the page says so.

## One-time setup

### 1. Password

Render → the Spark service → Environment → add `ARCHIVE_PASSWORD`. Use a password your mom and dad can type. Save. Render redeploys.

Why: the page lists customers and prices. Without the password the page stays closed.

### 2. OneDrive app

This lets the server file PDFs into the OneDrive account you sign in with. It does not give the server the rest of that account's mail.

1. Open [Azure app registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and choose **New registration**.
2. Name: `Veenstra Job Archive`.
3. Supported accounts: **Accounts in any organizational directory and personal Microsoft accounts**.
4. Redirect URI: platform **Web**, value `https://spark-jobber-server.onrender.com/onedrive/callback`.
5. Register. Copy the **Application (client) ID**.
6. Certificates & secrets → **New client secret**. Copy the **Value** immediately. The Secret ID is not the secret.
7. In Render Environment set:
   - `ONEDRIVE_CLIENT_ID` = the application id
   - `ONEDRIVE_CLIENT_SECRET` = the secret value
   - `ONEDRIVE_REDIRECT_URI` = `https://spark-jobber-server.onrender.com/onedrive/callback`
8. After the redeploy, open [Connect OneDrive](https://spark-jobber-server.onrender.com/onedrive/start) and sign in with the OneDrive account that should hold the files.

New Sherwin invoices from the nightly email import are then filed under `Veenstra Jobs / {job number and customer} / Sherwin /`.

### 3. Optional smarter wording

Set `OPENAI_API_KEY` (or `ARCHIVE_LLM_API_KEY`) on Render if you want a model to read unusual questions. The answer is still only the matching invoices. Without the key, the page still understands dates, job numbers, products, colors, and misspellings.

### 4. Older Sherwin bills

Invoices that arrive after OneDrive is connected include the PDF.

Older line items (product, color, job number, date) load from either place, on the search page under **Add older Sherwin invoices**:

- Sherwin's invoice spreadsheet export (CSV). This is the far-back product history.
- The original PDF, uploaded from the shop Gmail mailbox or from files you already saved. That is the copy you can open.
- **Load Sherwin bills from QuickBooks** fills bills that were entered in QuickBooks and never kept a PDF. Those rows do not open a file.

## What the office sees

Sign in at `/archive`, type a question, open the invoice link. Examples that work from the data, not from a fixed list: "When did we last use Cashmere?", "What jobs did we do last March?", "Techno Gray", "job 26054".
