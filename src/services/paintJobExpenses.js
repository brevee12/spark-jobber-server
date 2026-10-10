/**
 * Sherwin-Williams bills imported to QBO carry the Jobber job number in PO#.
 * Post each bill as a Jobber expense on that job so job cost includes the paint.
 * "Job: 1 VEENSTRA PAINTING" on the invoice is the store account, not the job.
 * A PO that is not a 4–6 digit job number (SHOP, a client name) is skipped.
 */

import { getSherwinWilliamsBills } from './qbo.js';
import { searchJobs, listExpenses, createExpense } from '../../jobber/client.js';

export function jobNumberFromSherwinNote(note = '') {
  const po =
    String(note).match(/PO#:\s*([A-Za-z0-9-]+)/i)?.[1] ||
    String(note).match(/PO[#:\s-]*([A-Za-z0-9-]+)/i)?.[1] ||
    null;
  if (po && /^\d{4,6}$/.test(po)) return { po, jobNumber: po };
  return { po, jobNumber: null };
}

export function paintExpenseTitle(docNumber) {
  return `SW ${docNumber}`;
}

export function paintExpenseDescription(bill) {
  const items = (bill.lines || [])
    .map((l) => l.description)
    .filter((d) => d && !/sales tax/i.test(d))
    .slice(0, 8);
  return [
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
  const base = { docNumber: bill.docNumber, date: bill.txnDate, amount: bill.totalAmount, po, jobNumber };

  if (!jobNumber) {
    return { ...base, action: 'skip', reason: po ? `PO "${po}" is not a job number` : 'no PO#' };
  }
  if (!job || String(job.jobNumber) !== String(jobNumber)) {
    return { ...base, action: 'skip', reason: `no Jobber job ${jobNumber}` };
  }
  if (existing) {
    return { ...base, action: 'skip', reason: 'already on the job', expenseId: existing.id };
  }
  return {
    ...base,
    action: 'create',
    jobId: job.jobId,
    clientName: job.clientName || null,
    title: paintExpenseTitle(bill.docNumber),
    description: paintExpenseDescription({ ...bill, jobNumber }),
  };
}

export async function postPaintJobExpenses({ maxResults = 100, apply = false } = {}) {
  const bills = await getSherwinWilliamsBills({ maxResults });
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
    if (plan.action !== 'create' || !apply) {
      results.push(plan);
      continue;
    }

    try {
      const created = await createExpense({
        title: plan.title,
        description: plan.description,
        amount: Number(plan.amount),
        date: `${String(plan.date).slice(0, 10)}T12:00:00Z`,
        linkedJobId: plan.jobId,
      });
      results.push({ ...plan, action: 'created', expenseId: created?.id || null });
    } catch (err) {
      results.push({ ...plan, action: 'error', reason: err.message });
    }
  }

  const count = (action) => results.filter((r) => r.action === action).length;
  return {
    apply,
    bills: bills.length,
    created: count('created'),
    ready: count('create'),
    skipped: count('skip'),
    errors: count('error'),
    results,
  };
}
