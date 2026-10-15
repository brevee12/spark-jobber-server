/**
 * Read Sherwin-Williams invoice emails from Resend and post them on the
 * Jobber job named in PO#. Gallons come from the invoice, which QuickBooks
 * does not store. An invoice already on the job is updated, not duplicated.
 * SHOP and other non-job POs are skipped.
 * After a new invoice lands on a job, the PDF is attached to a note on that
 * job. Jobber downloads the Resend link during this run. The file is not saved.
 */

import { readJson, writeJson } from '../lib/jsonStore.js';
import { persistEnvVars } from '../lib/durableTokens.js';
import { parseSherwinInvoiceText } from './sherwinInvoices.js';
import { applySherwinInvoiceGallons } from './paintJobExpenses.js';
import { extractPdfText } from './pdfText.js';
import { createJobNote, listJobNotes } from '../../jobber/client.js';
import {
  listReceivedEmails,
  getReceivedEmail,
  listReceivedAttachments,
  downloadAttachment,
} from './resendReceiving.js';

const PROCESSED_FILE = '.sherwin-processed-emails.json';
const PROCESSED_ENV_KEY = 'SHERWIN_PROCESSED_EMAIL_IDS';

export function isForwardingConfirmation(email) {
  const from = String(email?.from || '').toLowerCase();
  const subject = String(email?.subject || '').toLowerCase();
  return (
    from.includes('forwarding-noreply@google.com') ||
    subject.includes('forwarding confirmation')
  );
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** PDF extractors often put each column on its own line. Put a product back on one line. */
export function reflowSherwinText(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat
    .replace(/ (?=(?:ACCOUNT:|No\.|PO#|DATE:|CHARGE|CASH)\b)/g, '\n')
    .replace(/ (?=\d{3,4}-\d{3,5}\s)/g, '\n');
}

export function parseSherwinEmailText(text) {
  const raw = parseSherwinInvoiceText(text);
  const reflowed = parseSherwinInvoiceText(reflowSherwinText(text));
  const byDoc = new Map();
  for (const invoice of [...raw, ...reflowed]) {
    if (!invoice?.docNumber) continue;
    const prev = byDoc.get(invoice.docNumber);
    if (!prev || invoiceScore(invoice) > invoiceScore(prev)) {
      byDoc.set(invoice.docNumber, invoice);
    }
  }
  return [...byDoc.values()];
}

function invoiceScore(invoice) {
  return (
    (invoice.lines?.length || 0) +
    (invoice.amount != null ? 0.1 : 0) +
    (invoice.jobNumber ? 0.1 : 0)
  );
}

export function invoiceFileKind(attachment) {
  const type = String(attachment?.content_type || '').toLowerCase();
  const name = String(attachment?.filename || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('text/') || name.endsWith('.txt')) return 'text';
  return null;
}

function idsFromEnv() {
  const raw = process.env[PROCESSED_ENV_KEY]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return raw.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

export function listSherwinSeenEmailIds() {
  const stored = readJson(PROCESSED_FILE, { ids: [] });
  return [...new Set([...(stored.ids || []).map(String), ...idsFromEnv()])].sort();
}

function saveSeenIds(ids) {
  writeJson(PROCESSED_FILE, {
    ids,
    updatedAt: new Date().toISOString(),
  });
  return ids;
}

export async function markSherwinEmailsSeen(emailIds = []) {
  const before = new Set(listSherwinSeenEmailIds());
  const beforeEnv = process.env[PROCESSED_ENV_KEY] || '';
  const set = new Set(before);
  for (const id of emailIds) {
    if (id) set.add(String(id));
  }
  const ids = [...set].sort();
  saveSeenIds(ids);
  const next = JSON.stringify(ids);
  const durable =
    next !== beforeEnv
      ? await persistEnvVars({ [PROCESSED_ENV_KEY]: next }, { onlyIfChanged: true })
      : { synced: true, updated: [], skipped: [PROCESSED_ENV_KEY] };
  return {
    count: ids.length,
    added: ids.filter((id) => !before.has(id)).length,
    durable,
  };
}

export function sherwinInvoiceNoteMessage(docNumber) {
  return `Sherwin-Williams invoice ${docNumber}`;
}

function pdfDownloadUrl(attachment) {
  const url = String(attachment?.download_url || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return url;
}

/**
 * docNumber -> https URL for the PDF that contained it.
 * When the PDF text did not parse and the email has one PDF, that file is used.
 */
export function invoicePdfUrls(invoices, parsedUrls, pdfAttachments) {
  const urls = new Map(parsedUrls || []);
  const ready = (pdfAttachments || []).map((attachment) => pdfDownloadUrl(attachment)).filter(Boolean);
  if (urls.size > 0 || ready.length !== 1) return urls;
  const only = ready[0];
  for (const invoice of invoices || []) {
    const doc = String(invoice?.docNumber || '');
    if (doc && !urls.get(doc)) urls.set(doc, only);
  }
  return urls;
}

/**
 * One note per invoice on the job the PO mapped to.
 * A note whose message already contains that invoice number is left alone.
 * A missing URL or a failed create is recorded and does not throw.
 */
export async function attachSherwinInvoicePdfNotes({
  results = [],
  pdfUrlByDoc = new Map(),
  listNotes = listJobNotes,
  createNote = createJobNote,
} = {}) {
  const notes = [];
  const seen = new Set();
  for (const row of results || []) {
    if (!row?.jobId || row.docNumber == null || row.docNumber === '') continue;
    if (!invoiceLanded(row)) continue;
    const reason = String(row.reason || '');
    if (reason.includes('is not a job number') || reason === 'no PO#') continue;
    const doc = String(row.docNumber);
    const key = `${row.jobId}:${doc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { docNumber: doc, jobNumber: row.jobNumber || null };
    const url = pdfUrlByDoc.get(doc) || '';
    if (!url) {
      notes.push({ ...base, error: 'invoice PDF url is missing' });
      continue;
    }
    try {
      const existing = await listNotes(row.jobId);
      const already = (existing || []).some((note) => String(note?.message || '').includes(doc));
      if (already) {
        notes.push({ ...base, skipped: true, reason: 'note already on the job' });
        continue;
      }
      const created = await createNote({
        jobId: row.jobId,
        message: sherwinInvoiceNoteMessage(doc),
        pinned: false,
        attachments: [{ url }],
      });
      if (!created?.id) {
        notes.push({ ...base, error: 'invoice note was not created' });
        continue;
      }
      notes.push({ ...base, noteId: created.id });
    } catch (err) {
      notes.push({ ...base, error: err.message });
    }
  }
  return notes;
}

/** A skip is finished when another run would not change it. A missing job is not. */
function invoiceLanded(row) {
  if (row?.action === 'created' || row?.action === 'updated') return true;
  if (row?.action !== 'skip') return false;
  const reason = String(row.reason || '');
  if (reason.startsWith('no Jobber job')) return false;
  if (reason === 'no line items' || reason === 'no amount to create') return false;
  return true;
}

function slimResult(row) {
  return {
    docNumber: row.docNumber,
    jobNumber: row.jobNumber,
    po: row.po,
    date: row.date,
    amount: row.amount,
    gallons: row.gallons,
    action: row.action,
    reason: row.reason || null,
    expenseId: row.expenseId || null,
  };
}

async function textFromAttachment(attachment, fetchImpl, extractText) {
  const kind = invoiceFileKind(attachment);
  if (!kind) return '';
  const bytes = await downloadAttachment(attachment, fetchImpl);
  if (kind === 'text') return bytes.toString('utf8');
  return extractText(bytes);
}

/**
 * @param {{ apply?: boolean, limit?: number, includeSeen?: boolean }} [opts]
 * Inject listEmails / getEmail / attachmentsFor / applyInvoices / markSeen / seenIds /
 * listJobNotes / createJobNote / extractPdfText in tests.
 */
export async function importSherwinEmails(opts = {}) {
  const apply = Boolean(opts.apply);
  const limit = opts.limit ?? 30;
  const includeSeen = Boolean(opts.includeSeen);
  const fetchImpl = opts.fetchImpl || fetch;
  const extractText = opts.extractPdfText || extractPdfText;
  const listEmails = opts.listEmails || ((args) => listReceivedEmails({ ...args, fetchImpl }));
  const getEmail = opts.getEmail || ((id) => getReceivedEmail(id, { fetchImpl }));
  const attachmentsFor =
    opts.attachmentsFor || ((id) => listReceivedAttachments(id, { fetchImpl }));
  const applyInvoices = opts.applyInvoices || applySherwinInvoiceGallons;
  const markSeen = opts.markSeen || markSherwinEmailsSeen;
  const listNotes = opts.listJobNotes || listJobNotes;
  const createNote = opts.createJobNote || createJobNote;
  const seen = new Set(opts.seenIds || listSherwinSeenEmailIds());

  const listed = await listEmails({ limit });
  const emails = [];
  const toSee = [];

  for (const summary of listed) {
    if (!includeSeen && seen.has(String(summary.id))) continue;

    const base = {
      id: summary.id,
      from: summary.from || null,
      to: summary.to || null,
      subject: summary.subject || null,
      createdAt: summary.created_at || summary.createdAt || null,
    };

    if (isForwardingConfirmation(summary)) {
      emails.push({ ...base, kind: 'forwarding_confirmation', invoices: 0 });
      if (apply) toSee.push(summary.id);
      continue;
    }

    try {
      const full = await getEmail(summary.id);
      const parts = [full.text, htmlToText(full.html)].filter(Boolean);
      const fromEmail = Array.isArray(full.attachments) ? full.attachments : [];
      const fromSummary = Array.isArray(summary.attachments) ? summary.attachments : [];
      const listedAttachments = fromEmail.length ? fromEmail : fromSummary;
      const attachments = listedAttachments.length ? await attachmentsFor(summary.id) : [];
      const pdfUrlByDoc = new Map();
      const pdfAttachments = [];
      let attachmentErrors = 0;
      for (const attachment of attachments) {
        const kind = invoiceFileKind(attachment);
        if (!kind) continue;
        if (kind === 'pdf') pdfAttachments.push(attachment);
        try {
          const text = await textFromAttachment(attachment, fetchImpl, extractText);
          parts.push(text);
          if (kind === 'pdf') {
            for (const invoice of parseSherwinEmailText(text)) {
              const doc = String(invoice?.docNumber || '');
              const url = pdfDownloadUrl(attachment);
              if (!doc || !url || pdfUrlByDoc.has(doc)) continue;
              pdfUrlByDoc.set(doc, url);
            }
          }
        } catch (err) {
          attachmentErrors += 1;
          parts.push('');
          base.attachmentError = err.message;
        }
      }

      const invoices = parseSherwinEmailText(parts.join('\n'));
      const readable = attachments.filter((attachment) => invoiceFileKind(attachment));
      if (!invoices.length && (readable.length || attachmentErrors)) {
        emails.push({
          ...base,
          kind: 'unparsed_attachment',
          invoices: 0,
          reason: base.attachmentError || 'attachment did not parse as a Sherwin invoice',
        });
        continue;
      }

      let posting = null;
      if (invoices.length) {
        posting = await applyInvoices({ invoices, apply });
      }
      let invoiceNotes = [];
      if (apply && posting) {
        invoiceNotes = await attachSherwinInvoicePdfNotes({
          results: posting.results,
          pdfUrlByDoc: invoicePdfUrls(invoices, pdfUrlByDoc, pdfAttachments),
          listNotes,
          createNote,
        });
      }
      const gallonNoteErrors = (posting?.notes || []).filter((note) => note.error).length;
      const unlanded = apply
        ? (posting?.results || []).filter((row) => !invoiceLanded(row)).length
        : 0;
      // Gallon-note failures count toward the run. A PDF note failure does not.
      const errors =
        Math.max(posting?.errors || 0, unlanded, gallonNoteErrors) + attachmentErrors;
      const emailResult = {
        ...base,
        kind: invoices.length ? 'invoices' : 'no_invoices',
        invoices: invoices.length,
        created: posting?.created || 0,
        updated: posting?.updated || 0,
        ready: posting?.ready || 0,
        toUpdate: posting?.toUpdate || 0,
        skipped: posting?.skipped || 0,
        errors,
        results: (posting?.results || []).map(slimResult),
      };
      if (invoiceNotes.length) emailResult.invoiceNotes = invoiceNotes;
      emails.push(emailResult);
      if (apply && errors === 0) toSee.push(summary.id);
    } catch (err) {
      emails.push({ ...base, kind: 'error', invoices: 0, errors: 1, reason: err.message });
    }
  }

  const seenResult = apply && toSee.length ? await markSeen(toSee) : null;
  const sum = (key) => emails.reduce((total, email) => total + (email[key] || 0), 0);
  const unparsed = emails.filter((email) => email.kind === 'unparsed_attachment').length;
  const errors = sum('errors') + unparsed;
  const invoiceNoteErrors = emails.reduce(
    (total, email) => total + (email.invoiceNotes || []).filter((item) => item.error).length,
    0
  );

  let note = null;
  if (!emails.length) note = 'No new Sherwin emails.';
  else if (emails.every((email) => email.kind === 'forwarding_confirmation')) {
    note =
      'Inbox has the Gmail forwarding confirmation only. No Sherwin invoices have arrived.';
  } else if (unparsed) {
    note = 'An email had an attachment that did not parse as a Sherwin invoice.';
  } else if (invoiceNoteErrors) {
    note = 'An expense posted, but its invoice PDF was not attached to the job.';
  }

  return {
    ok: errors === 0,
    apply,
    inbox: listed.length,
    considered: emails.length,
    created: sum('created'),
    updated: sum('updated'),
    ready: sum('ready'),
    toUpdate: sum('toUpdate'),
    skipped: sum('skipped'),
    errors,
    unparsed,
    invoiceNoteErrors,
    note,
    seen: seenResult
      ? { count: seenResult.count, added: seenResult.added, synced: Boolean(seenResult.durable?.synced) }
      : null,
    emails,
  };
}
