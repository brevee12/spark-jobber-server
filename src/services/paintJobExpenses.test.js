/**
 * Run: node src/services/paintJobExpenses.test.js
 */
import {
  formatInvoiceLine,
  gallonsOnSherwinExpenses,
  invoiceGallonDescription,
  invoiceGallonTitle,
  jobNumberFromSherwinNote,
  planPaintBill,
} from './paintJobExpenses.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const note = `CHARGE INVOICE - 89673
PO#: 26086
Account No: 4206-8703-0
Job: 1 VEENSTRA PAINTING
Imported from Sherwin-Williams PRO+`;

assertEq(jobNumberFromSherwinNote(note).jobNumber, '26086', 'PO is the job');
assertEq(jobNumberFromSherwinNote(note).po, '26086', 'po');
assertEq(jobNumberFromSherwinNote('PO#: SHOP\nJob: 1 VEENSTRA PAINTING').jobNumber, null, 'SHOP is not a job');
assertEq(jobNumberFromSherwinNote('PO#: THADEN').jobNumber, null, 'name PO is not a job');

const bill = {
  id: '100',
  docNumber: '89673112820926',
  txnDate: '2026-09-10',
  totalAmount: 124.01,
  privateNote: note,
  poNumber: '26086',
  jobNumber: '26086',
  lines: [{ description: 'DUR HOME SG EXTRA', amount: 115.9 }],
};
const job = { jobId: 'J1', jobNumber: 26086, clientName: 'Randy Sinclair' };

assertEq(planPaintBill(bill, { job }).action, 'create', 'ready to post');
assertEq(planPaintBill(bill, { job }).jobId, 'J1', 'job id');
assertEq(
  planPaintBill({ ...bill, poNumber: 'SHOP', jobNumber: null, privateNote: 'PO#: SHOP' }, {}).action,
  'skip',
  'shop skipped'
);
assertEq(planPaintBill(bill, { job: null }).reason, 'no Jobber job 26086', 'missing job');
assertEq(
  planPaintBill(bill, { job, existing: { id: 'E1' } }).reason,
  'already on the job',
  'duplicate skipped'
);
assertEq(
  planPaintBill(
    { ...bill, gallons: 3, unknownLines: 0 },
    { job, existing: { id: 'E1', description: 'Sherwin-Williams invoice' } }
  ).action,
  'update',
  'existing expense gains its gallon count'
);
assertEq(
  planPaintBill(
    { ...bill, gallons: 3, unknownLines: 0 },
    { job, existing: { id: 'E1', description: 'Gallons: 3\nSherwin-Williams invoice' } }
  ).action,
  'skip',
  'gallon line already on the expense'
);
assertEq(
  planPaintBill({ ...bill, gallons: 3, unknownLines: 0 }, { job }).title,
  'SW 89673112820926 · 3 gal',
  'title shows gallons'
);

const onJob = [
  { description: 'Gallons: 10\nSherwin-Williams invoice 111\nJob 26095' },
  { description: 'Gallons: 4\nSherwin-Williams invoice 222\nJob 26095' },
];
assertEq(
  gallonsOnSherwinExpenses(onJob, [{ docNumber: '333', gallons: 5 }]),
  19,
  'a new invoice adds to the job total'
);
assertEq(
  gallonsOnSherwinExpenses(onJob, [{ docNumber: '222', gallons: 4 }]),
  14,
  'the same invoice is not counted twice'
);
assertEq(
  gallonsOnSherwinExpenses(
    [{ description: 'Gallons: 10\nSherwin-Williams invoice 222\nJob 26095' }],
    [{ docNumber: '222', gallons: 6 }]
  ),
  6,
  'this run replaces a stale gallon count'
);

assertEq(
  invoiceGallonDescription({
    docNumber: '2655',
    jobNumber: '26094',
    gallons: 1,
    lines: [
      { product: 'CASHMERE LL EXTRA', qty: 1, gallons: 1, color: 'ALABASTER' },
      { product: 'PURDY PAIL', qty: 2, gallons: 0 },
    ],
  }),
  '1 CASHMERE LL EXTRA — ALABASTER\n2 PURDY PAIL\nGallons: 1\nSherwin-Williams invoice 2655\nJob 26094',
  'product, quantity, and color come before the gallon total'
);
assertEq(
  formatInvoiceLine({ product: 'B42B81', description: 'WB DF FL BLACK', qty: 5, gallons: 5 }),
  '5 WB DF FL BLACK',
  'invoice text uses the product name, not the product number'
);
assertEq(
  formatInvoiceLine({ description: 'EMERALD UTE SA UD', qty: 1, gallons: 0.25 }),
  '0.25 EMERALD UTE SA UD',
  'a quart is a quarter gallon on the line'
);
assertEq(invoiceGallonTitle('2655', 1), 'SW 2655 · 1 gal', 'title with gallons');
assertEq(invoiceGallonTitle('3901', 0), 'SW 3901', 'supplies-only title has no gallon count');

console.log('paintJobExpenses.test.js: all assertions passed');
