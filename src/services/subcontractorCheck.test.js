/**
 * Run: node src/services/subcontractorCheck.test.js
 */
import { planSubcontractorCheck, recordSubcontractorCheck } from './subcontractorCheck.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const vendor = { id: '55', name: 'Deluxe Drywall', vendor1099: true };
const prior = [
  {
    id: '1',
    type: 'Purchase',
    docNumber: '1400',
    date: '2026-08-01',
    amount: 500,
    payee: 'Deluxe Drywall',
    accountId: '80',
    accountName: 'Subcontractors',
    paymentType: 'Check',
    memo: 'Job 26010',
  },
  {
    id: '2',
    type: 'Purchase',
    docNumber: '1450',
    date: '2026-09-12',
    amount: 900,
    payee: 'Deluxe Drywall',
    accountId: '80',
    accountName: 'Subcontractors',
    paymentType: 'Check',
    memo: 'Job 26040',
  },
];

const ready = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor,
  qboRecords: prior,
  jobberExpenses: [],
  job: { jobId: 'job-1', jobNumber: 26088, title: 'Drywall' },
});
assert(ready.qboAction === 'post', `qbo should post, got ${ready.qboAction}`);
assert(ready.category.accountName === 'Subcontractors', 'category follows earlier checks');
assert(ready.jobberAction === 'post', 'jobber posts when the job is known');
assert(ready.enable1099 === false, '1099 already on');

const duplicate = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor,
  qboRecords: [...prior, { id: '9', type: 'Purchase', docNumber: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', accountId: '80', paymentType: 'Check' }],
  job: { jobId: 'job-1', jobNumber: 26088 },
});
assert(duplicate.qboAction === 'skip' && /already in QuickBooks/.test(duplicate.qboReason), 'same check number is a duplicate');

const noJob = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor,
  qboRecords: prior,
  jobberExpenses: [],
  job: null,
});
assert(noJob.qboAction === 'post' && noJob.jobberAction === 'needs-job', 'a blank job is not guessed');

const off = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor: { ...vendor, vendor1099: false },
  qboRecords: prior,
  job: null,
});
assert(off.enable1099 === true, '1099 gets turned on when the vendor is not tracked');

const split = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor,
  qboRecords: [
    prior[0],
    { ...prior[1], accountId: '81', accountName: 'Job Supplies' },
  ],
  job: null,
});
assert(split.qboAction === 'needs-category', 'a split history is not guessed');

let wrote = null;
const applied = await recordSubcontractorCheck({
  payee: 'Deluxe Drywall',
  amount: 750,
  checkNumber: '1499',
  txnDate: '2026-11-05',
  jobNumber: '26088',
  apply: true,
  findVendorFn: async () => ({ vendor: { ...vendor, syncToken: '0' }, matches: ['Deluxe Drywall'] }),
  loadRecords: async () => prior,
  loadAccounts: async () => [{ id: '35', name: 'Checking-Marion County Bank (3696)' }],
  findJob: async () => [{ jobId: 'job-1', jobNumber: 26088, title: 'Drywall' }],
  findExpenses: async () => [],
  save1099: async () => { throw new Error('1099 already on'); },
  saveCheck: async (body) => {
    wrote = body;
    return { id: '77', docNumber: '1499', status: 'created' };
  },
  saveExpense: async (body) => ({ id: 'exp-1', ...body }),
});
assert(applied.qbo.id === '77', 'check was written');
assert(wrote.checkNumber === '1499', 'check number is passed through');
assert(wrote.memo === '26088', 'memo is the job number, matching earlier checks');
assert(wrote.categoryAccountId === '80', 'category is the one from earlier checks');
assert(applied.jobber.linkedJobId === 'job-1', 'expense is on the job');
assert(applied.jobber.title === 'Deluxe Drywall', 'expense title is the vendor');

const older = planSubcontractorCheck({
  check: { number: '1499', date: '2026-11-05', amount: 750, payee: 'Deluxe Drywall', bankAccountId: '35' },
  vendor,
  qboRecords: prior,
  jobberExpenses: [{ title: 'Deluxe Drywall', description: 'Texture', total: 750, date: '2025-09-11', jobNumber: 25068 }],
  job: { jobId: 'job-1', jobNumber: 26088 },
});
assert(older.jobberAction === 'post', 'an older payment of the same amount is not this check');

const preview = await recordSubcontractorCheck({
  payee: 'Deluxe Drywall',
  amount: 750,
  checkNumber: '1499',
  txnDate: '2026-11-05',
  apply: false,
  findVendorFn: async () => ({ vendor, matches: ['Deluxe Drywall'] }),
  loadRecords: async () => prior,
  loadAccounts: async () => [{ id: '35', name: 'Checking-Marion County Bank (3696)' }],
  findJob: async () => [],
  findExpenses: async () => [],
  saveCheck: async () => { throw new Error('preview must not write'); },
  saveExpense: async () => { throw new Error('preview must not write'); },
});
assert(preview.apply === false && preview.plan.jobberAction === 'needs-job', 'preview writes nothing');
assert(preview.priorMemos.length === 2, 'earlier memos are returned');

console.log('subcontractorCheck.test.js: all assertions passed');
