/**
 * Sherwin-Williams bills imported to QBO carry the Jobber job number in PO#.
 * Post each bill as a Jobber expense on that job so job cost includes the paint.
 * "Job: 1 VEENSTRA PAINTING" on the invoice is the store account, not the job.
 * A PO that is not a 4–6 digit job number (SHOP, a client name) is skipped.
 * Jobber numbers requests, quotes, invoices, and jobs separately. The PO is
 * matched only to Job.jobNumber, never to a quote or invoice with the same digits.
 * Each expense notes gallons bought, and a pinned job note shows the total.
 */

import { getSherwinWilliamsBills } from './qbo.js';
import { assignGallons, formatGallons, paintGallonsNote } from './paintGallons.js';
import {
  searchJobs,
  listExpenses,
  createExpense,
  editExpense,
  listJobNotes,
  createJobNote,
  editJobNote,
} from '../../jobber/client.js';

export function jobNumberFromSherwinNote(note = '') {
  const po =
    String(note).match(/PO#:\s*([A-Za-z0-9-]+)/i)?.[1] ||
    String(note).match(/PO[#:\s-]*([A-Za-z0-9-]+)/i)?.[1] ||
    null;
  if (po && /^\d{4,6}$/.test(po)) return { po, jobNumber: po };
  return { po, jobNumber: null };
}

export function paintExpenseTitle(docNumber, gallons, unknownLines = 0) {
  const base = `SW ${docNumber}`;
  if (gallons == null || unknownLines) return base;
  return `${base} · ${formatGallons(gallons)} gal`;
}

export function gallonLine(bill) {
  const unknown = Number(bill.unknownLines) || 0;
  if (bill.gallons == null && !unknown) return null;
  if (bill.gallons == null) return 'Gallons: not on invoice';
  if (unknown) return `Gallons: ${formatGallons(bill.gallons)} counted, more not on the invoice`;
  return `Gallons: ${formatGallons(bill.gallons)}`;
}

export function paintExpenseDescription(bill) {
  const items = (bill.lines || [])
    .map((l) => l.description)
    .filter((d) => d && !/sales tax/i.test(d))
    .slice(0, 8);
  return [
    gallonLine(bill),
    `Sherwin-Williams invoice ${bill.docNumber}`,
    bill.jobNumber ? `Job ${bill.jobNumber}` : null,
    ...items,
    `QBO bill ${bill.id}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function alreadyPosted(expenses, docNumber) {
  const needle = String(docNumber);
  return expenses.find(
    (e) => String(e.title || '').includes(needle) || String(e.description || '').includes(needle)
  );
}

/**
 * Decide what to do with one bill. `job` is the exact Jobber match or null.
 * `existing` is a Jobber expense that already cites this invoice, or null.
 */
export function planPaintBill(bill, { job = null, existing = null } = {}) {
  const parsed = jobNumberFromSherwinNote(bill.privateNote || '');
  const jobNumber = bill.jobNumber || parsed.jobNumber;
  const po = bill.poNumber || parsed.po;
  const gallons = bill.gallons ?? null;
  const unknownLines = Number(bill.unknownLines) || 0;
  const title = paintExpenseTitle(bill.docNumber, gallons, unknownLines);
  const description = paintExpenseDescription({ ...bill, jobNumber, gallons, unknownLines });
  const base = {
    docNumber: bill.docNumber,
    date: bill.txnDate,
    amount: bill.totalAmount,
    po,
    jobNumber,
    gallons,
    unknownLines,
    title,
    description,
  };

  if (!jobNumber) {
    return { ...base, action: 'skip', reason: po ? `PO "${po}" is not a job number` : 'no PO#' };
  }
  if (!job || String(job.jobNumber) !== String(jobNumber)) {
    return { ...base, action: 'skip', reason: `no Jobber job ${jobNumber}` };
  }
  const onJob = { ...base, jobId: job.jobId, clientName: job.clientName || null };
  if (existing) {
    const noted = gallonLine({ gallons, unknownLines });
    const alreadyNoted = noted && String(existing.description || '').includes(noted);
    if (gallons != null && noted && !alreadyNoted) {
      return { ...onJob, action: 'update', expenseId: existing.id };
    }
    return { ...onJob, action: 'skip', reason: 'already on the job', expenseId: existing.id };
  }
  return { ...onJob, action: 'create' };
}

const NOTE_MARK = 'Paint gallons bought:';

export function jobGallonTotals(results = []) {
  const jobs = new Map();
  for (const row of results) {
    if (!row.jobId || !row.jobNumber) continue;
    if (!jobs.has(row.jobId)) {
      jobs.set(row.jobId, {
        jobId: row.jobId,
        jobNumber: row.jobNumber,
        clientName: row.clientName || null,
        gallons: 0,
        known: false,
        unknown: 0,
      });
    }
    const job = jobs.get(row.jobId);
    if (row.gallons != null) {
      job.gallons += Number(row.gallons);
      job.known = true;
    }
    if (row.unknownLines) job.unknown += 1;
  }
  return [...jobs.values()].map((job) => ({
    ...job,
    gallons: job.known ? job.gallons : null,
    note: paintGallonsNote({ gallons: job.known ? job.gallons : null, unknown: job.unknown }),
  }));
}

async function upsertGallonNote(job) {
  if (!job.note) return null;
  const notes = await listJobNotes(job.jobId);
  const existing = notes.find((note) => String(note.message || '').startsWith(NOTE_MARK));
  if (existing) {
    if (existing.message === job.note && existing.pinned) return existing.id;
    const edited = await editJobNote({ noteId: existing.id, message: job.note, pinned: true });
    return edited?.id || existing.id;
  }
  const created = await createJobNote({ jobId: job.jobId, message: job.note, pinned: true });
  return created?.id || null;
}

export async function postPaintJobExpenses({ maxResults = 100, apply = false } = {}) {
  const fetched = await getSherwinWilliamsBills({ maxResults });
  const annotated = assignGallons(fetched);
  const bills = fetched.map((bill, index) => ({ ...bill, ...annotated[index] }));
  const jobCache = new Map();
  const results = [];

  for (const bill of bills) {
    const parsed = jobNumberFromSherwinNote(bill.privateNote || '');
    const jobNumber = bill.jobNumber || parsed.jobNumber;
    let job = null;
    if (jobNumber) {
      if (!jobCache.has(jobNumber)) {
        const found = await searchJobs({ jobNumber, limit: 10 });
        jobCache.set(
          jobNumber,
          found.find((j) => String(j.jobNumber) === String(jobNumber)) || null
        );
      }
      job = jobCache.get(jobNumber);
    }

    let existing = null;
    if (bill.docNumber && job) {
      const hits = await listExpenses({ searchTerm: String(bill.docNumber), limit: 10 });
      existing = alreadyPosted(hits, bill.docNumber) || null;
    }

    const plan = planPaintBill(bill, { job, existing });
    if (!apply || (plan.action !== 'create' && plan.action !== 'update')) {
      results.push(plan);
      continue;
    }

    try {
      if (plan.action === 'update') {
        const edited = await editExpense({
          expenseId: plan.expenseId,
          title: plan.title,
          description: plan.description,
        });
        results.push({ ...plan, action: 'updated', expenseId: edited?.id || plan.expenseId });
      } else {
        const created = await createExpense({
          title: plan.title,
          description: plan.description,
          amount: Number(plan.amount),
          date: `${String(plan.date).slice(0, 10)}T12:00:00Z`,
          linkedJobId: plan.jobId,
        });
        results.push({ ...plan, action: 'created', expenseId: created?.id || null });
      }
    } catch (err) {
      results.push({ ...plan, action: 'error', reason: err.message });
    }
  }

  const jobs = jobGallonTotals(results);
  const notes = [];
  if (apply) {
    for (const job of jobs) {
      if (job.gallons == null && !job.unknown) continue;
      try {
        notes.push({ jobNumber: job.jobNumber, noteId: await upsertGallonNote(job) });
      } catch (err) {
        notes.push({ jobNumber: job.jobNumber, error: err.message });
      }
    }
  }

  const count = (action) => results.filter((r) => r.action === action).length;
  const knownGallons = jobs.reduce((sum, job) => sum + (job.gallons || 0), 0);
  return {
    apply,
    bills: bills.length,
    created: count('created'),
    updated: count('updated'),
    ready: count('create'),
    toUpdate: count('update'),
    skipped: count('skip'),
    errors: count('error'),
    gallons: knownGallons,
    jobs: jobs.map((job) => ({
      jobNumber: job.jobNumber,
      clientName: job.clientName,
      gallons: job.gallons,
      unknown: job.unknown,
    })),
    notes,
    results,
  };
}
