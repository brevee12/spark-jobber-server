/**
 * Run: node src/services/sherwinEmailImport.test.js
 */
import { deleteJson } from '../lib/jsonStore.js';
import { jobCreateNoteInput } from '../../jobber/client.js';
import {
  isForwardingConfirmation,
  parseSherwinEmailText,
  importSherwinEmails,
  markSherwinEmailsSeen,
  listSherwinSeenEmailIds,
  invoicePdfUrls,
} from './sherwinEmailImport.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const wrapped = `
ACCOUNT:
INVOICE
No.
02424154851026
PO#
26095
DATE:
10/01/2026
6502-05669
5 GAL B42B81 WB DF FL BLACK
10
24.45
244.50
CHARGE
$261.62
`;
const parsed = parseSherwinEmailText(wrapped);
assertEq(parsed.length, 1, 'wrapped pdf text is one invoice');
assertEq(parsed[0].jobNumber, '26095', 'po survives a line break');
assertEq(parsed[0].gallons, 10, 'gallons survive a line break');
assertEq(parsed[0].amount, 261.62, 'charge survives a line break');

assertEq(
  isForwardingConfirmation({
    from: 'forwarding-noreply@google.com',
    subject: '(Gmail Forwarding Confirmation - Receive Mail from veenstrapainting@gmail.com',
  }),
  true,
  'gmail confirmation'
);

const invoiceText = `
ACCOUNT: 4206-8703-0
INVOICE
No. 02424154851026
PO# 26095
DATE: 10/01/2026
6502-05669 5 GAL B42B81 WB DF FL BLACK 10 24.45 244.50
CHARGE $261.62
`;

function inbox() {
  return [
    {
      id: 'confirm-1',
      from: 'forwarding-noreply@google.com',
      to: ['paint@example.resend.app'],
      subject: 'Gmail Forwarding Confirmation',
      created_at: '2026-10-10T11:15:04.645Z',
    },
    {
      id: 'mail-1',
      from: 'invoices@sherwin.com',
      to: ['paint@example.resend.app'],
      subject: 'Your invoice',
      created_at: '2026-10-15T12:00:00.000Z',
      attachments: [],
    },
    {
      id: 'already',
      from: 'invoices@sherwin.com',
      subject: 'old',
      created_at: '2026-10-01T12:00:00.000Z',
    },
  ];
}

const calls = [];
const result = await importSherwinEmails({
  apply: false,
  seenIds: ['already'],
  listEmails: async () => inbox(),
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async (args) => {
    calls.push(args);
    return {
      created: 0,
      updated: 0,
      ready: 1,
      toUpdate: 0,
      skipped: 0,
      errors: 0,
      results: [{ docNumber: '02424154851026', jobNumber: '26095', gallons: 10, action: 'create' }],
    };
  },
  markSeen: async () => {
    throw new Error('dry run must not mark emails seen');
  },
});
assertEq(result.ok, true, 'plan is ok');
assertEq(result.apply, false, 'plan does not apply');
assertEq(result.considered, 2, 'seen mail is skipped');
assertEq(result.ready, 1, 'one expense planned');
assertEq(calls.length, 1, 'parser ran once');
assertEq(calls[0].apply, false, 'plan flag reaches Jobber writer');
assertEq(calls[0].invoices[0].gallons, 10, 'parsed gallons');
assertEq(result.emails[0].kind, 'forwarding_confirmation', 'confirmation is not an invoice');

const seen = [];
const failed = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [inbox()[1]],
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async () => ({
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 0,
    errors: 1,
    results: [{ docNumber: '02424154851026', action: 'error', reason: 'jobber down' }],
  }),
  markSeen: async (ids) => {
    seen.push(...ids);
    return { count: ids.length, added: ids.length, durable: { synced: true } };
  },
});
assertEq(failed.ok, false, 'jobber error fails the run');
assertEq(seen.length, 0, 'failed invoice stays unseen for the next run');

const marked = [];
const posted = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => inbox().slice(0, 2),
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async (args) => {
    assertEq(args.apply, true, 'daily run writes');
    return {
      created: 1,
      updated: 0,
      ready: 0,
      toUpdate: 0,
      skipped: 0,
      errors: 0,
      results: [{ docNumber: '02424154851026', jobNumber: '26095', gallons: 10, action: 'created' }],
    };
  },
  markSeen: async (ids) => {
    marked.push(...ids);
    return { count: ids.length, added: ids.length, durable: { synced: true } };
  },
});
assertEq(posted.created, 1, 'one expense created');
assertEq(marked.includes('confirm-1'), true, 'confirmation is remembered');
assertEq(marked.includes('mail-1'), true, 'posted email is remembered');

const shopSeen = [];
const shop = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [inbox()[1]],
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async () => ({
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 1,
    errors: 0,
    results: [{ docNumber: '111', po: 'SHOP', action: 'skip', reason: 'PO "SHOP" is not a job number' }],
  }),
  markSeen: async (ids) => {
    shopSeen.push(...ids);
    return { count: ids.length, added: ids.length, durable: { synced: true } };
  },
});
assertEq(shop.ok, true, 'a non-job PO is done');
assertEq(shopSeen.includes('mail-1'), true, 'a non-job PO is not retried');

const missingSeen = [];
const missingJob = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [inbox()[1]],
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async () => ({
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 1,
    errors: 0,
    results: [{ docNumber: '02424154851026', jobNumber: '26095', action: 'skip', reason: 'no Jobber job 26095' }],
  }),
  markSeen: async (ids) => {
    missingSeen.push(...ids);
    return { count: ids.length, added: ids.length, durable: { synced: true } };
  },
});
assertEq(missingJob.ok, false, 'a missing job fails the run');
assertEq(missingSeen.length, 0, 'a missing job is tried again tomorrow');

const noteSeen = [];
const noteFailed = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [inbox()[1]],
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async () => ({
    created: 1,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 0,
    errors: 0,
    notes: [{ jobNumber: '26095', error: 'note failed' }],
    results: [{ docNumber: '02424154851026', jobNumber: '26095', gallons: 10, action: 'created' }],
  }),
  markSeen: async (ids) => {
    noteSeen.push(...ids);
    return { count: ids.length, added: ids.length, durable: { synced: true } };
  },
});
assertEq(noteFailed.ok, false, 'a gallon note failure fails the run');
assertEq(noteSeen.length, 0, 'a gallon note failure is tried again');

const downloads = [];
const unparsed = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [
    {
      id: 'pdf-1',
      from: 'invoices@sherwin.com',
      subject: 'invoice',
      created_at: '2026-10-15T18:00:00.000Z',
      attachments: [{ id: 'a', filename: 'invoice.pdf' }],
    },
  ],
  getEmail: async () => ({
    text: 'see attached',
    html: null,
    attachments: [{ id: 'a', filename: 'invoice.pdf', content_type: 'application/pdf' }],
  }),
  attachmentsFor: async () => [
    {
      filename: 'mystery.txt',
      content_type: 'text/plain',
      download_url: 'https://files.example/mystery.txt',
    },
  ],
  fetchImpl: async (url, init) => {
    downloads.push({ url, init });
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('not an invoice') };
  },
  applyInvoices: async () => {
    throw new Error('should not post an unparsed attachment');
  },
  markSeen: async () => {
    throw new Error('unparsed mail must stay unseen');
  },
});
assertEq(unparsed.ok, false, 'unparsed attachment fails the run');
assertEq(unparsed.unparsed, 1, 'one unparsed attachment');
assertEq(downloads.length, 1, 'attachment was downloaded');
assertEq(downloads[0].url, 'https://files.example/mystery.txt', 'download uses the signed url');
assertEq(downloads[0].init, undefined, 'download does not send the Resend API key');

const previous = process.env.SHERWIN_PROCESSED_EMAIL_IDS;
delete process.env.SHERWIN_PROCESSED_EMAIL_IDS;
deleteJson('.sherwin-processed-emails.json');
try {
  const saved = await markSherwinEmailsSeen(['mail-9']);
  assertEq(saved.added, 1, 'new email id is stored');
  assertEq(listSherwinSeenEmailIds().includes('mail-9'), true, 'id reloads');
} finally {
  deleteJson('.sherwin-processed-emails.json');
  if (previous == null) delete process.env.SHERWIN_PROCESSED_EMAIL_IDS;
  else process.env.SHERWIN_PROCESSED_EMAIL_IDS = previous;
}

const noteInput = jobCreateNoteInput({
  message: 'Sherwin-Williams invoice 02424154851026',
  pinned: false,
  attachments: [{ url: 'https://files.example/invoice.pdf?sig=1' }],
});
assertEq(noteInput.attachments.length, 1, 'note input has one file');
assertEq(
  noteInput.attachments[0].url,
  'https://files.example/invoice.pdf?sig=1',
  'note input keeps the signed url'
);
assertEq(noteInput.pinned, false, 'invoice pdf note is not pinned');
assertEq(
  jobCreateNoteInput({ message: 'Paint gallons bought: 10' }).attachments,
  undefined,
  'a note without a file does not send attachments'
);

const pdfUrl = 'https://files.example/invoice.pdf?sig=1';
const createdPosting = {
  created: 1,
  updated: 0,
  ready: 0,
  toUpdate: 0,
  skipped: 0,
  errors: 0,
  results: [
    {
      docNumber: '02424154851026',
      jobNumber: '26095',
      jobId: 'job-1',
      gallons: 10,
      action: 'created',
      expenseId: 'exp-1',
    },
  ],
};

function pdfMessage(id = 'pdf-mail') {
  return {
    id,
    from: 'invoices@sherwin.com',
    subject: 'invoice',
    created_at: '2026-10-15T18:00:00.000Z',
    attachments: [{ id: 'a', filename: 'invoice.pdf' }],
  };
}

async function importPdfEmail({
  apply = true,
  posting = createdPosting,
  notes = [],
  downloadUrl = pdfUrl,
  body = '',
  attachments = null,
  createNote,
  listNotes,
} = {}) {
  const noteCalls = [];
  const seenIds = [];
  const downloads = [];
  const result = await importSherwinEmails({
    apply,
    seenIds: [],
    listEmails: async () => [pdfMessage()],
    getEmail: async () => ({
      text: body,
      html: null,
      attachments: attachments || [{ id: 'a', filename: 'invoice.pdf', content_type: 'application/pdf' }],
    }),
    attachmentsFor: async () => [
      {
        filename: 'invoice.pdf',
        content_type: 'application/pdf',
        download_url: downloadUrl,
      },
    ],
    fetchImpl: async (url, init) => {
      downloads.push({ url, init });
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(invoiceText) };
    },
    extractPdfText: async (bytes) => bytes.toString('utf8'),
    applyInvoices: async () => posting,
    listJobNotes: listNotes || (async () => notes),
    createJobNote: async (input) => {
      noteCalls.push(input);
      if (createNote) return createNote(input);
      return { id: 'note-1', message: input.message, pinned: input.pinned };
    },
    markSeen: async (ids) => {
      seenIds.push(...ids);
      return { count: ids.length, added: ids.length, durable: { synced: true } };
    },
  });
  return { result, noteCalls, seenIds, downloads };
}

const attached = await importPdfEmail();
assertEq(attached.result.ok, true, 'pdf note does not fail the run');
assertEq(attached.result.created, 1, 'expense still counts as created');
assertEq(attached.noteCalls.length, 1, 'one note for the invoice pdf');
assertEq(attached.noteCalls[0].jobId, 'job-1', 'note goes on the PO job');
assertEq(
  attached.noteCalls[0].message,
  'Sherwin-Williams invoice 02424154851026',
  'note names the invoice'
);
assertEq(attached.noteCalls[0].pinned, false, 'pdf note stays unpinned');
assertEq(attached.noteCalls[0].attachments[0].url, pdfUrl, 'note uses the fresh download url');
assertEq(attached.downloads[0].init, undefined, 'jobber fetch does not send the Resend API key');
assertEq(attached.result.emails[0].invoiceNotes[0].noteId, 'note-1', 'email result records the note');
assertEq(attached.result.invoiceNoteErrors, 0, 'a created note is not an error');
assertEq(attached.seenIds.includes('pdf-mail'), true, 'posted email with a note is remembered');
assertEq(attached.result.emails[0].results[0].expenseId, 'exp-1', 'expense id stays on the email');

const duplicate = await importPdfEmail({
  notes: [{ id: 'old', message: 'Sherwin-Williams invoice 02424154851026', pinned: false }],
});
assertEq(duplicate.noteCalls.length, 0, 'a second note for the same invoice is skipped');
assertEq(duplicate.result.ok, true, 'an existing invoice note is done');
assertEq(duplicate.result.emails[0].invoiceNotes[0].skipped, true, 'skip is recorded');
assertEq(duplicate.result.invoiceNoteErrors, 0, 'a skipped note is not an error');
assertEq(duplicate.seenIds.includes('pdf-mail'), true, 'an invoice that already has a note is remembered');

const noteBroken = await importPdfEmail({
  createNote: async () => {
    throw new Error('jobber note rejected');
  },
});
assertEq(noteBroken.result.ok, true, 'a failed pdf note does not fail the run');
assertEq(noteBroken.result.created, 1, 'the expense stays when the note fails');
assertEq(noteBroken.result.invoiceNoteErrors, 1, 'the note failure is counted on the run');
assertEq(
  noteBroken.result.emails[0].invoiceNotes[0].error,
  'jobber note rejected',
  'the note error is on the email result'
);
assertEq(
  noteBroken.result.note,
  'An expense posted, but its invoice PDF was not attached to the job.',
  'the run says the pdf was not attached'
);
assertEq(noteBroken.seenIds.includes('pdf-mail'), true, 'a failed note does not retry the email');

const noPdf = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [inbox()[1]],
  getEmail: async (id) => ({ id, text: invoiceText, html: null, attachments: [] }),
  applyInvoices: async () => createdPosting,
  listJobNotes: async () => {
    throw new Error('no pdf should not list notes');
  },
  createJobNote: async () => {
    throw new Error('no pdf should not create a note');
  },
  markSeen: async (ids) => ({ count: ids.length, added: ids.length, durable: { synced: true } }),
});
assertEq(noPdf.ok, true, 'a missing pdf url does not fail the run');
assertEq(noPdf.created, 1, 'the expense stays when the pdf url is missing');
assertEq(noPdf.emails[0].invoiceNotes[0].error, 'invoice PDF url is missing', 'missing url is recorded');
assertEq(noPdf.invoiceNoteErrors, 1, 'missing url is a note error');

const shopPdf = await importPdfEmail({
  posting: {
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 1,
    errors: 0,
    results: [{ docNumber: '02424154851026', po: 'SHOP', action: 'skip', reason: 'PO "SHOP" is not a job number' }],
  },
  listNotes: async () => {
    throw new Error('SHOP should not list notes');
  },
  createNote: async () => {
    throw new Error('SHOP should not get a note');
  },
});
assertEq(shopPdf.noteCalls.length, 0, 'a non-job PO gets no pdf note');
assertEq(shopPdf.result.ok, true, 'a non-job PO still finishes');
assertEq(shopPdf.result.emails[0].invoiceNotes, undefined, 'a non-job PO records no note');

const alreadyThere = await importPdfEmail({
  posting: {
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 1,
    errors: 0,
    results: [
      {
        docNumber: '02424154851026',
        jobNumber: '26095',
        jobId: 'job-1',
        action: 'skip',
        reason: 'already on the job',
        expenseId: 'exp-1',
      },
    ],
  },
});
assertEq(alreadyThere.noteCalls.length, 1, 'a new email still attaches the pdf when the expense is already there');
assertEq(alreadyThere.noteCalls[0].attachments[0].url, pdfUrl, 'that note uses the pdf url');

const noAmount = await importPdfEmail({
  posting: {
    created: 0,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 1,
    errors: 0,
    results: [
      {
        docNumber: '02424154851026',
        jobNumber: '26095',
        jobId: 'job-1',
        action: 'skip',
        reason: 'no amount to create',
      },
    ],
  },
  createNote: async () => {
    throw new Error('an unposted invoice should not get a note');
  },
});
assertEq(noAmount.noteCalls.length, 0, 'no expense means no pdf note');
assertEq(noAmount.result.emails[0].invoiceNotes, undefined, 'an unposted invoice records no note');
assertEq(noAmount.result.ok, false, 'no amount is still unfinished');

const planned = await importPdfEmail({
  apply: false,
  posting: {
    created: 0,
    updated: 0,
    ready: 1,
    toUpdate: 0,
    skipped: 0,
    errors: 0,
    results: [
      {
        docNumber: '02424154851026',
        jobNumber: '26095',
        jobId: 'job-1',
        action: 'create',
      },
    ],
  },
  listNotes: async () => {
    throw new Error('a plan should not list notes');
  },
  createNote: async () => {
    throw new Error('a plan should not create a note');
  },
});
assertEq(planned.noteCalls.length, 0, 'a dry run does not attach the pdf');
assertEq(planned.result.emails[0].invoiceNotes, undefined, 'a dry run records no note');
assertEq(planned.result.invoiceNoteErrors, 0, 'a dry run has no note error');
assertEq(planned.result.ok, true, 'a dry run stays ok');

const secondUrl = 'https://files.example/other.pdf?sig=2';
const secondText = `
ACCOUNT: 4206-8703-0
INVOICE
No. 02424154851099
PO# 26096
DATE: 10/02/2026
6502-05669 5 GAL B42B81 WB DF FL BLACK 4 24.45 97.80
CHARGE $104.00
`;
const bothCalls = [];
const both = await importSherwinEmails({
  apply: true,
  seenIds: [],
  listEmails: async () => [
    {
      id: 'two-pdfs',
      from: 'invoices@sherwin.com',
      subject: 'invoices',
      created_at: '2026-10-15T18:00:00.000Z',
      attachments: [
        { id: 'a', filename: 'one.pdf' },
        { id: 'b', filename: 'two.pdf' },
      ],
    },
  ],
  getEmail: async () => ({
    text: '',
    html: null,
    attachments: [
      { id: 'a', filename: 'one.pdf', content_type: 'application/pdf' },
      { id: 'b', filename: 'two.pdf', content_type: 'application/pdf' },
    ],
  }),
  attachmentsFor: async () => [
    { filename: 'one.pdf', content_type: 'application/pdf', download_url: pdfUrl },
    { filename: 'two.pdf', content_type: 'application/pdf', download_url: secondUrl },
  ],
  fetchImpl: async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(url === secondUrl ? secondText : invoiceText),
  }),
  extractPdfText: async (bytes) => bytes.toString('utf8'),
  applyInvoices: async () => ({
    created: 2,
    updated: 0,
    ready: 0,
    toUpdate: 0,
    skipped: 0,
    errors: 0,
    results: [
      { docNumber: '02424154851026', jobNumber: '26095', jobId: 'job-1', action: 'created', expenseId: 'e1' },
      { docNumber: '02424154851099', jobNumber: '26096', jobId: 'job-2', action: 'created', expenseId: 'e2' },
    ],
  }),
  listJobNotes: async () => [],
  createJobNote: async (input) => {
    bothCalls.push(input);
    return { id: `note-${bothCalls.length}`, message: input.message };
  },
  markSeen: async (ids) => ({ count: ids.length, added: ids.length, durable: { synced: true } }),
});
assertEq(both.ok, true, 'two invoices still succeed');
assertEq(bothCalls.length, 2, 'one note per invoice pdf');
assertEq(bothCalls[0].attachments[0].url, pdfUrl, 'first pdf stays with its invoice');
assertEq(bothCalls[1].attachments[0].url, secondUrl, 'second pdf stays with its invoice');
assertEq(bothCalls[1].jobId, 'job-2', 'second note is on the second job');

const fallback = invoicePdfUrls(
  [{ docNumber: '02424154851026' }],
  new Map(),
  [{ download_url: pdfUrl, filename: 'invoice.pdf', content_type: 'application/pdf' }]
);
assertEq(fallback.get('02424154851026'), pdfUrl, 'one unread pdf is still the invoice file');
const named = new Map([['02424154851026', pdfUrl]]);
const leftAlone = invoicePdfUrls(
  [{ docNumber: '02424154851026' }, { docNumber: '999' }],
  named,
  [
    { download_url: pdfUrl },
    { download_url: secondUrl },
  ]
);
assertEq(leftAlone.get('999'), undefined, 'a second pdf is not guessed onto another invoice');

console.log('sherwinEmailImport.test.js: all assertions passed');
