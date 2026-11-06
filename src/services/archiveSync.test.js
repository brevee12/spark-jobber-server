import assert from 'node:assert/strict';
import { createArchive } from './jobArchive.js';
import { billsToInvoices, importSherwinCsv, parseSherwinCsv } from './archiveSync.js';
import { answerQuestion } from './archiveSearch.js';

const csv = `Invoice Number,PO Number,Order Date,Order Total,Product Name,Quantity,Price,Color Name
95456,26070,10/20/2026,58.00,SPRDK WB ST TB EN,1,58.00,MANUAL RIVERWOOD
95456,26070,10/20/2026,58.00,SPRDK WB ST TB EN,1,0,MANUAL RIVERWOOD
`;

const invoices = parseSherwinCsv(csv);
assert.equal(invoices.length, 1, 'two lines are one invoice');
assert.equal(invoices[0].jobNumber, '26070', 'numeric PO is the job');
assert.equal(invoices[0].date, '2026-10-20', 'US date becomes ISO');
assert.equal(invoices[0].lines[0].color, 'MANUAL RIVERWOOD', 'color column is kept');
assert.equal(invoices[0].lines.length, 2, 'both lines stay');

const db = createArchive(':memory:');
const loaded = await importSherwinCsv(db, csv);
assert.equal(loaded.documents, 1, 'csv is stored');
const found = answerQuestion(db, 'when did we last use riverwood', { today: new Date('2026-11-05T00:00:00Z'), useModel: false });
assert.equal(found.rows[0].jobNumber, '26070', 'color search finds the csv invoice');

const qbo = billsToInvoices([{
  id: '9',
  docNumber: '86828112820926',
  txnDate: '2026-09-02',
  totalAmount: 58.44,
  privateNote: 'PO#: 26027',
  lines: [{ description: 'Description: CASHMERE LL EXTRA\nColor: NATURAL LINEN', amount: 58.44, item: 'Paint' }],
}]);
assert.equal(qbo[0].jobNumber, '26027', 'QBO note PO is the job');
assert.equal(qbo[0].lines[0].color, 'NATURAL LINEN', 'QBO color line is kept');
assert.equal(qbo[0].lines[0].product, 'CASHMERE LL EXTRA', 'QBO product description is kept');

console.log('archiveSync.test.js: all assertions passed');
