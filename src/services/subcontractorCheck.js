/**
 * A handwritten subcontractor check is a QuickBooks check to that vendor
 * (so it lands on the 1099) and a Jobber expense on the job.
 * The category and the bank account come from earlier checks to the same
 * vendor. A blank job on the check is not guessed.
 */

import { createExpense, listExpenses, searchJobs } from '../../jobber/client.js';
import { queryAll } from './qboPostedMatch.js';
import {
  enableVendor1099,
  getQboAccounts,
  postQboCheck,
  qboQuery,
} from './qbo.js';

const CHECKING_RE = /checking-marion county bank/i;

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const GENERIC_NAME = new Set(['drywall', 'painting', 'paint', 'construction', 'services', 'llc', 'inc']);

function samePayee(a, b) {
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const words = right.split(' ').filter((word) => word.length >= 4 && !GENERIC_NAME.has(word));
  const hay = new Set(left.split(' '));
  return words.some((word) => hay.has(word));
}

function dayDiff(a, b) {
  const ms = new Date(`${String(a).slice(0, 10)}T00:00:00Z`) - new Date(`${String(b).slice(0, 10)}T00:00:00Z`);
  return Math.abs(ms / 86400000);
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function categoryOf(records, payee) {
  const counts = new Map();
  for (const row of records) {
    if (row.paymentType && row.paymentType !== 'Check') continue;
    if (!samePayee(row.payee, payee) || !row.accountId) continue;
    const key = String(row.accountId);
    const hit = counts.get(key) || { accountId: key, accountName: row.accountName, n: 0, latest: row.date };
    hit.n += 1;
    if (String(row.date) > String(hit.latest)) hit.latest = row.date;
    counts.set(key, hit);
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n || String(b.latest).localeCompare(String(a.latest)));
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].n === ranked[1].n) return null;
  return ranked[0];
}

/**
 * Decide what to write. `qboRecords` are existing checks and bill payments.
 * `job` is set only when the check names a job number that exists.
 */
export function planSubcontractorCheck({
  check,
  vendor = null,
  qboRecords = [],
  jobberExpenses = [],
  job = null,
} = {}) {
  const number = String(check?.number || '').trim();
  const amount = money(check?.amount);
  const date = String(check?.date || '').slice(0, 10);
  const payee = check?.payee || vendor?.name || null;
  const problems = [];
  if (!/^\d{3,6}$/.test(number)) problems.push('Check number is missing');
  if (amount == null || amount <= 0) problems.push('Amount is missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push('Check date is missing');
  if (!payee) problems.push('Payee is missing');

  const sameNumber = qboRecords.filter((row) => String(row.docNumber || '') === number);
  const samePayment = qboRecords.filter(
    (row) =>
      samePayee(row.payee, payee) &&
      money(row.amount) === amount &&
      row.date &&
      dayDiff(row.date, date) <= 4
  );
  const qboDuplicate = sameNumber[0] || samePayment[0] || null;
  const category = categoryOf(qboRecords, payee);
  const prior = qboRecords.filter((row) => samePayee(row.payee, payee) && (!row.paymentType || row.paymentType === 'Check'));

  let qboAction = 'post';
  let qboReason = null;
  if (problems.length) {
    qboAction = 'needs-input';
    qboReason = problems.join('. ');
  } else if (qboDuplicate) {
    qboAction = 'skip';
    qboReason = sameNumber.length
      ? `Check ${number} is already in QuickBooks`
      : `${payee} already has a $${amount.toFixed(2)} check within 4 days of ${date}`;
  } else if (!vendor?.id) {
    qboAction = 'needs-vendor';
    qboReason = `No QuickBooks vendor matches ${payee}`;
  } else if (!check?.bankAccountId) {
    qboAction = 'needs-bank';
    qboReason = 'Marion County checking account was not found';
  } else if (!category) {
    qboAction = 'needs-category';
    qboReason = prior.length
      ? `${payee} checks use more than one category`
      : `No earlier check to ${payee} to copy the category from`;
  }

  const jobberHit = jobberExpenses.find((row) => {
    const text = `${row.title || ''} ${row.description || ''}`;
    if (number && new RegExp(`\\b${number}\\b`).test(text)) return true;
    const dated = row.date && dayDiff(String(row.date).slice(0, 10), date) <= 7;
    return dated && money(row.total) === amount && samePayee(text, payee);
  });

  let jobberAction = 'post';
  let jobberReason = null;
  if (jobberHit) {
    jobberAction = 'skip';
    jobberReason = `Jobber already has this on job ${jobberHit.jobNumber || 'unknown'}`;
  } else if (!job?.jobId) {
    jobberAction = 'needs-job';
    jobberReason = 'The check does not name a job';
  }

  return {
    check: { number, date, amount, payee },
    vendor: vendor
      ? { id: vendor.id, name: vendor.name, vendor1099: vendor.vendor1099 === true }
      : null,
    enable1099: Boolean(vendor?.id) && vendor.vendor1099 !== true && qboAction === 'post',
    category: category
      ? { accountId: category.accountId, accountName: category.accountName, priorChecks: category.n }
      : null,
    priorCheckCount: prior.length,
    qboAction,
    qboReason,
    qboDuplicate: qboDuplicate
      ? { id: qboDuplicate.id, type: qboDuplicate.type, docNumber: qboDuplicate.docNumber, date: qboDuplicate.date }
      : null,
    jobberAction,
    jobberReason,
    job: job ? { jobId: job.jobId, jobNumber: job.jobNumber, title: job.title || null } : null,
    bankAccountId: check?.bankAccountId || null,
  };
}

function fromPurchase(row) {
  const line = (row.Line || []).find((item) => item.AccountBasedExpenseLineDetail?.AccountRef);
  const account = line?.AccountBasedExpenseLineDetail?.AccountRef;
  return {
    id: row.Id,
    type: 'Purchase',
    docNumber: row.DocNumber || null,
    date: row.TxnDate,
    amount: money(row.TotalAmt),
    payee: row.EntityRef?.name || null,
    payeeId: row.EntityRef?.value || null,
    accountId: account?.value ? String(account.value) : null,
    accountName: account?.name || null,
    bankAccountId: row.AccountRef?.value ? String(row.AccountRef.value) : null,
    memo: [row.PrivateNote, line?.Description].filter(Boolean).join(' · '),
    paymentType: row.PaymentType || null,
  };
}

function fromBillPayment(row) {
  return {
    id: row.Id,
    type: 'BillPayment',
    docNumber: row.DocNumber || null,
    date: row.TxnDate,
    amount: money(row.TotalAmt),
    payee: row.VendorRef?.name || null,
    payeeId: row.VendorRef?.value || null,
    accountId: null,
    accountName: null,
    bankAccountId: row.CheckPayment?.BankAccountRef?.value
      ? String(row.CheckPayment.BankAccountRef.value)
      : null,
    memo: row.PrivateNote || '',
    paymentType: row.PayType === 'Check' ? 'Check' : row.PayType || null,
  };
}

async function findVendor(payee) {
  const safe = String(payee).replace(/'/g, "\\'");
  const qr = await qboQuery(
    `SELECT Id, DisplayName, CompanyName, Vendor1099, Active, SyncToken FROM Vendor WHERE DisplayName LIKE '${safe}%' MAXRESULTS 20`
  );
  const rows = asList(qr.Vendor).filter((row) => row.Active !== false);
  const exact = rows.find((row) => norm(row.DisplayName) === norm(payee));
  const vendor = exact || (rows.length === 1 ? rows[0] : null);
  if (!vendor) return { vendor: null, matches: rows.map((row) => row.DisplayName) };
  return {
    vendor: {
      id: vendor.Id,
      name: vendor.DisplayName,
      vendor1099: vendor.Vendor1099 === true,
      syncToken: vendor.SyncToken,
    },
    matches: rows.map((row) => row.DisplayName),
  };
}

async function loadQboRecords(checkNumber, since) {
  const [purchases, billPayments, numbered] = await Promise.all([
    queryAll('Purchase', since),
    queryAll('BillPayment', since).catch(() => []),
    qboQuery(`SELECT * FROM Purchase WHERE DocNumber = '${String(checkNumber).replace(/'/g, '')}'`).catch(() => ({})),
  ]);
  const records = [
    ...purchases.map(fromPurchase),
    ...asList(billPayments).map(fromBillPayment),
    ...asList(numbered.Purchase).map(fromPurchase),
  ];
  const seen = new Set();
  return records.filter((row) => {
    const key = `${row.type}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Read QuickBooks and Jobber and return the plan. apply:true writes the
 * check and, when the job is known, the Jobber expense.
 */
export async function recordSubcontractorCheck({
  payee,
  amount,
  checkNumber,
  txnDate,
  jobNumber,
  memo,
  apply = false,
  findVendorFn = findVendor,
  loadRecords = loadQboRecords,
  loadAccounts = getQboAccounts,
  findJob = searchJobs,
  findExpenses = listExpenses,
  saveCheck = postQboCheck,
  save1099 = enableVendor1099,
  saveExpense = createExpense,
} = {}) {
  const number = String(checkNumber || '').trim();
  const date = String(txnDate || '').slice(0, 10);
  const since = '2025-01-01';
  const [found, accounts, records, expenses, jobs] = await Promise.all([
    findVendorFn(payee),
    loadAccounts(),
    loadRecords(number, since),
    findExpenses({ searchTerm: payee, limit: 50 }).catch(() => []),
    jobNumber ? findJob({ jobNumber: String(jobNumber) }) : Promise.resolve([]),
  ]);
  const bank = accounts.find((account) => CHECKING_RE.test(account.name));
  const job = Array.isArray(jobs) ? jobs[0] : jobs?.jobs?.[0] || null;
  const named = records
    .filter((row) => row.accountId)
    .map((row) => ({
      ...row,
      accountName: row.accountName || accounts.find((account) => account.id === row.accountId)?.name || null,
    }));
  const plan = planSubcontractorCheck({
    check: {
      number,
      date,
      amount,
      payee,
      bankAccountId: bank?.id || null,
    },
    vendor: found.vendor,
    qboRecords: named,
    jobberExpenses: expenses,
    job: job?.jobId ? job : null,
  });
  const priorMemos = named
    .filter((row) => samePayee(row.payee, payee))
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 8)
    .map((row) => ({
      date: row.date,
      docNumber: row.docNumber,
      amount: row.amount,
      accountName: row.accountName,
      memo: row.memo || null,
    }));

  const result = {
    apply: Boolean(apply),
    plan,
    vendorMatches: found.matches,
    priorMemos,
  };
  if (!apply || plan.qboAction !== 'post') return result;

  if (plan.enable1099) {
    result.vendor1099 = await save1099({
      vendorId: found.vendor.id,
      syncToken: found.vendor.syncToken,
    });
  }
  const note = memo || (job?.jobNumber ? String(job.jobNumber) : `Check ${number}`);
  result.qbo = await saveCheck({
    paymentAccountId: bank.id,
    categoryAccountId: plan.category.accountId,
    vendorId: found.vendor.id,
    vendorName: found.vendor.name,
    amount: plan.check.amount,
    txnDate: date,
    checkNumber: number,
    memo: note,
  });
  if (plan.jobberAction === 'post') {
    result.jobber = await saveExpense({
      amount: plan.check.amount,
      title: found.vendor.name,
      description: job.title ? `${job.title} · job ${job.jobNumber}` : note,
      date,
      linkedJobId: job.jobId,
    });
  }
  return result;
}
