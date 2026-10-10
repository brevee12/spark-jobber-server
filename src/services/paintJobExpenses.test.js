/**
 * Run: node src/services/paintJobExpenses.test.js
 */
import { jobNumberFromSherwinNote, planPaintBill } from './paintJobExpenses.js';

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

console.log('paintJobExpenses.test.js: all assertions passed');
