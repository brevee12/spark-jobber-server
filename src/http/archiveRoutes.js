/**
 * Search page for the office. One box, plain questions, links to the
 * OneDrive PDF. A password keeps customer prices off the public internet.
 */

import crypto from 'crypto';
import { askArchive } from '../services/archiveSearch.js';
import { archiveCounts, openArchive } from '../services/jobArchive.js';
import {
  importQboSherwinBills,
  importSherwinCsv,
  rememberSherwinPacket,
  rememberUploadedPdf,
} from '../services/archiveSync.js';
import {
  buildOneDriveAuthorizeUrl,
  disconnectOneDrive,
  exchangeOneDriveCode,
  oneDriveStatus,
} from '../services/oneDrive.js';
import { searchJobs } from '../../jobber/client.js';
import { rememberJob } from '../services/jobArchive.js';

const COOKIE = 'archive_session';

function password() {
  return process.env.ARCHIVE_PASSWORD?.trim() || '';
}

function sessionToken(secret) {
  return crypto.createHmac('sha256', secret).update('veenstra-archive').digest('hex');
}

function readCookie(req, name) {
  const header = req.get('cookie') || '';
  const hit = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  const secret = password();
  if (!secret) return false;
  const header = req.get('x-archive-password') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (header && header === secret) return true;
  return readCookie(req, COOKIE) === sessionToken(secret);
}

function page(title, body, { wide = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:${wide ? '46rem' : '36rem'};margin:1.5rem auto;padding:0 1rem;line-height:1.45;color:#111;font-size:1.05rem}
  h1{font-size:1.7rem;margin-bottom:.25rem}
  input,button,textarea{font:inherit}
  input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #ccc;border-radius:.4rem}
  button{padding:.7rem 1rem;border:0;border-radius:.4rem;background:#0b57d0;color:#fff;margin-top:.6rem}
  pre{white-space:pre-wrap;background:#f6f6f6;padding:.8rem;border-radius:.4rem}
  a{color:#0b57d0}
  .muted{color:#555;font-size:.95rem}
  details{margin-top:2rem}
</style></head><body>
${body}
</body></html>`;
}

function setupSteps() {
  const drive = oneDriveStatus();
  return `<h1>Job search is not open yet</h1>
<p>This page is for looking up a job, a paint color, or a Sherwin invoice. It stays locked until a password is set, so customer prices are not public.</p>
<ol>
  <li>In Render → Environment, set <code>ARCHIVE_PASSWORD</code> to a password your mom and dad can type.</li>
  <li>OneDrive is ${drive.connected ? 'connected' : 'not connected'}. ${drive.configured ? '' : 'Add the OneDrive app ids first. '}Open <a href="/onedrive/start">Connect OneDrive</a> and sign in with the account that should hold the invoice files.</li>
</ol>
<p class="muted">Why: the invoices have your prices and your customers. The password is the lock. OneDrive is the folder the files are saved in.</p>`;
}

async function attachJobberNames(db, result) {
  const numbers = new Set(
    [...(result.rows || []), ...(result.jobs || [])]
      .map((row) => row.jobNumber)
      .filter(Boolean)
  );
  if (result.interpreted?.jobNumber) numbers.add(String(result.interpreted.jobNumber));
  let changed = false;
  for (const jobNumber of numbers) {
    const known = db.prepare('SELECT title, client_name FROM jobs WHERE job_number = ?').get(String(jobNumber));
    if (known?.title && known?.client_name) continue;
    try {
      const found = await searchJobs({ jobNumber, limit: 10 });
      const job = found.find((item) => String(item.jobNumber) === String(jobNumber));
      if (!job) continue;
      rememberJob(db, {
        jobNumber: job.jobNumber,
        title: job.title,
        clientName: job.clientName,
        jobberUrl: null,
      });
      changed = true;
    } catch {
      // The invoice rows still answer if Jobber is down.
    }
  }
  return changed;
}

export function mountArchive(app) {
  app.get('/archive/login', (_req, res) => {
    if (!password()) {
      res.type('html').send(page('Job search', setupSteps()));
      return;
    }
    res.type('html').send(page('Job search', `<h1>Job search</h1>
<form method="post" action="/archive/login">
  <label>Password<br/><input type="password" name="password" autofocus/></label>
  <button type="submit">Open</button>
</form>`));
  });

  app.post('/archive/login', async (req, res) => {
    const secret = password();
    const body = (await rawBody(req)).toString();
    const given = new URLSearchParams(body).get('password') || '';
    if (!secret || given !== secret) {
      res.status(401).type('html').send(page('Job search', `<h1>That password did not match</h1><p><a href="/archive/login">Try again</a></p>`));
      return;
    }
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${sessionToken(secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`
    );
    res.redirect('/archive');
  });

  app.get('/archive', (req, res) => {
    if (!password()) {
      res.type('html').send(page('Job search', setupSteps()));
      return;
    }
    if (!authorized(req)) {
      res.redirect('/archive/login');
      return;
    }
    const counts = archiveCounts(openArchive());
    const drive = oneDriveStatus();
    res.type('html').send(page('Job search', `<h1>Job search</h1>
<p class="muted">${counts.documents} invoices indexed, ${counts.withFile} with a file in OneDrive. OneDrive is ${drive.connected ? 'connected' : 'not connected'}.</p>
<form id="ask">
  <input type="text" name="q" placeholder="When did we last use Cashmere?" autofocus/>
  <button type="submit">Search</button>
</form>
<pre id="out">Ask in a normal sentence. A misspelled product still finds the real name on the invoices.</pre>
<details>
  <summary>Add older Sherwin invoices</summary>
  <p>Upload the Sherwin invoice spreadsheet (CSV) to load product, color, and job number as far back as that export goes. Upload invoice PDFs to file the original bill in OneDrive.</p>
  <form id="csv"><input type="file" name="file" accept=".csv,text/csv"/><button type="submit">Load spreadsheet</button></form>
  <form id="pdf"><input type="file" name="file" accept="application/pdf" multiple/><button type="submit">File PDFs in OneDrive</button></form>
  <form id="qbo"><button type="submit">Load Sherwin bills from QuickBooks</button></form>
  <p id="load" class="muted"></p>
  <p><a href="/onedrive/start">Connect OneDrive</a></p>
</details>
<script>
async function post(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}
document.getElementById('ask').onsubmit = async (event) => {
  event.preventDefault();
  const q = new FormData(event.target).get('q');
  document.getElementById('out').textContent = 'Looking…';
  try {
    const data = JSON.parse(await post('/archive/ask?q=' + encodeURIComponent(q)));
    document.getElementById('out').textContent = data.answer || 'Nothing on file.';
  } catch (err) {
    document.getElementById('out').textContent = err.message;
  }
};
document.getElementById('csv').onsubmit = async (event) => {
  event.preventDefault();
  const file = event.target.file.files[0];
  if (!file) return;
  document.getElementById('load').textContent = await post('/archive/import-csv', { method:'POST', headers:{'Content-Type':'text/csv'}, body: await file.text() });
};
document.getElementById('pdf').onsubmit = async (event) => {
  event.preventDefault();
  const notes = [];
  for (const file of event.target.file.files) {
    notes.push(await post('/archive/upload-pdf?filename=' + encodeURIComponent(file.name), { method:'POST', headers:{'Content-Type':'application/pdf'}, body: file }));
  }
  document.getElementById('load').textContent = notes.join('\\n');
};
document.getElementById('qbo').onsubmit = async (event) => {
  event.preventDefault();
  document.getElementById('load').textContent = 'Loading QuickBooks bills…';
  document.getElementById('load').textContent = await post('/archive/import-qbo', { method:'POST' });
};
</script>`, { wide: true }));
  });

  app.get('/archive/ask', async (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: 'Sign in at /archive/login' });
      return;
    }
    try {
      const db = openArchive();
      let result = await askArchive(db, req.query.q || '');
      const changed = await attachJobberNames(db, result);
      if (changed) result = await askArchive(db, req.query.q || '', { useModel: false, interpreted: result.interpreted });
      res.json({ ok: true, answer: result.answer, interpreted: result.interpreted, rows: result.rows, jobs: result.jobs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/archive/import-csv', async (req, res) => {
    if (!authorized(req)) {
      res.status(401).type('text').send('Sign in at /archive/login');
      return;
    }
    try {
      const text = (await rawBody(req)).toString();
      const result = await importSherwinCsv(openArchive(), text);
      res.type('text').send(`Loaded ${result.documents} invoices from the spreadsheet.`);
    } catch (err) {
      res.status(400).type('text').send(err.message);
    }
  });

  app.post('/archive/upload-pdf', async (req, res) => {
    if (!authorized(req)) {
      res.status(401).type('text').send('Sign in at /archive/login');
      return;
    }
    try {
      const result = await rememberUploadedPdf(openArchive(), {
        filename: req.query.filename || 'invoice.pdf',
        bytes: await rawBody(req),
      });
      res.type('text').send(`Filed ${result.documents} invoice${result.documents === 1 ? '' : 's'} from ${req.query.filename || 'the PDF'}.`);
    } catch (err) {
      res.status(400).type('text').send(err.message);
    }
  });

  app.post('/archive/import-qbo', async (req, res) => {
    if (!authorized(req)) {
      res.status(401).type('text').send('Sign in at /archive/login');
      return;
    }
    try {
      const result = await importQboSherwinBills(openArchive());
      res.type('text').send(`Loaded ${result.documents} QuickBooks Sherwin bills. Those rows have no PDF until you upload the invoice file.`);
    } catch (err) {
      res.status(500).type('text').send(err.message);
    }
  });

  app.get('/onedrive/start', (_req, res) => {
    try {
      res.redirect(buildOneDriveAuthorizeUrl());
    } catch (err) {
      res.status(500).type('html').send(page('OneDrive', `<h1>OneDrive is not set up</h1><p>${err.message}</p>`));
    }
  });

  app.get('/onedrive/callback', async (req, res) => {
    try {
      await exchangeOneDriveCode(req.query.code, req.query.state);
      res.type('html').send(page('OneDrive', `<h1>OneDrive connected</h1><p>New Sherwin invoices will be filed under Veenstra Jobs. <a href="/archive">Back to search</a></p>`));
    } catch (err) {
      res.status(400).type('html').send(page('OneDrive', `<h1>OneDrive was not connected</h1><p>${err.message}</p>`));
    }
  });

  app.post('/onedrive/disconnect', async (_req, res) => {
    await disconnectOneDrive();
    res.json({ ok: true, connected: false });
  });
}

export async function archiveEmailInvoices(packet) {
  return rememberSherwinPacket(openArchive(), packet);
}
