/**
 * Run: node src/services/sherwinEmailImport.test.js
 */
import { deleteJson } from '../lib/jsonStore.js';
import {
  isForwardingConfirmation,
  parseSherwinEmailText,
  importSherwinEmails,
  markSherwinEmailsSeen,
  listSherwinSeenEmailIds,
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

console.log('sherwinEmailImport.test.js: all assertions passed');
