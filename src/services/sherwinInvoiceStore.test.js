/**
 * Run: node src/services/sherwinInvoiceStore.test.js
 */
import {
  parseSherwinInvoiceCsv,
  importSherwinInvoiceCsv,
  searchSherwinInvoices,
  rememberSherwinEmailInvoices,
  openSherwinInvoiceDb,
} from './sherwinInvoiceStore.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const csv = `
"Order Number","Invoice Number","PO Number","Order Date","Order Total","Taxes","Account Number","Job Number","Job Name","Store Number","Type","Unit Number","SKU","Product/REX Number","Product Name","Quantity","Price","Color Name"
"OE1","4941","26070","2026-10-20","65.15","4.26","420687030","1","VEENSTRA PAINTING","3848","11","117 HIGH AVE W","650930852","SD3T00025","SPRDK WB ST TB EN","1.00","60.89","MANUAL RIVERWOOD"
"OE2","5252","26092","2026-10-22","419.84","27.47","420687030","1","VEENSTRA PAINTING","3848","11","117 HIGH AVE W","9718354","7610","CLEAR XTREME","3.00","392.37",""
"","5252","","","","","","","","","11","","7531593","360","UTILITY BLADE 5/CARD","1.00","3.82",""
"OE3","95456","DEVIN","2026-09-29","176.00","11.51","420687030","1","VEENSTRA PAINTING","3848","11","117 HIGH AVE W","650850589","","REVOLUTION FRAME 9""","1.00","16.99",""
`.trim();

const parsed = parseSherwinInvoiceCsv(csv);
assertEq(parsed.length, 3, 'three invoices');
assertEq(parsed[0].jobNumber, '26070', 'numeric PO is the job');
assertEq(parsed[1].lines.length, 2, 'second product stays on the invoice');
assertEq(parsed[1].lines[1].productName, 'UTILITY BLADE 5/CARD', 'continuation line');
assertEq(parsed[2].jobNumber, null, 'a name PO is not a job number');
assertEq(parsed[2].poNumber, 'DEVIN', 'name PO is kept');
assertEq(parsed[2].lines[0].productName, 'REVOLUTION FRAME 9"', 'quoted product name');

const reused = `
"Order Number","Invoice Number","PO Number","Order Date","Order Total","Taxes","Account Number","Job Number","Job Name","Store Number","Type","Unit Number","SKU","Product/REX Number","Product Name","Quantity","Price","Color Name"
"OE1","5252","26092","2026-10-22","10.00","0","420687030","1","VEENSTRA PAINTING","3848","11","117 HIGH AVE W","1","7610","CLEAR XTREME","1.00","10.00",""
"OE2","5252","26001","2018-04-02","20.00","0","420687030","1","VEENSTRA PAINTING","3848","11","117 HIGH AVE W","2","A1","OLD WHITE","1.00","20.00","EXTRA WHITE"
`.trim();

const db = openSherwinInvoiceDb(':memory:');
const saved = importSherwinInvoiceCsv(csv, { db, source: 'csv' });
assertEq(saved.invoices, 3, 'saved invoices');
assertEq(saved.lines, 4, 'saved lines');

const river = searchSherwinInvoices({ query: 'riverwood 26070', db });
assertEq(river.count, 1, 'color and job find the stain');
assertEq(river.invoices[0].invoiceNumber, '4941', 'riverwood invoice');
assertEq(river.invoices[0].lines[0].quantity, 1, 'one gallon');

const linked = rememberSherwinEmailInvoices(
  [{ docNumber: '04941154851026', po: '26070', date: '2026-10-20', amount: 65.15, lines: [] }],
  { db }
);
assertEq(linked.linked, 1, 'email doc number attaches to the CSV invoice');
assertEq(linked.stored, 0, 'email does not copy an invoice the CSV already has');
const again = searchSherwinInvoices({ query: '04941154851026', db });
assertEq(again.count, 1, 'long doc number finds the CSV invoice');

const emailedFirst = rememberSherwinEmailInvoices(
  [{ docNumber: '09999999999999', po: '26001', date: '2018-04-02', amount: 20, lines: [{ description: 'temp', qty: 1, value: 20 }] }],
  { db }
);
assertEq(emailedFirst.stored, 1, 'an email with no CSV row is kept');
const beforeCsv = searchSherwinInvoices({ query: '09999999999999', db });
assertEq(beforeCsv.invoices[0].invoiceNumber, '09999999999999', 'email is stored under the doc number');

const kept = importSherwinInvoiceCsv(reused, { db, source: 'csv' });
assertEq(kept.invoices, 2, 'same invoice number on two dates is two invoices');
const both = searchSherwinInvoices({ query: '5252', db });
assertEq(both.count, 2, 'both years stay searchable');
const afterCsv = searchSherwinInvoices({ query: '09999999999999', db });
assertEq(afterCsv.count, 1, 'csv replaces the email copy');
assertEq(afterCsv.invoices[0].invoiceNumber, '5252', 'short invoice number wins');

console.log('sherwinInvoiceStore.test.js ok');
