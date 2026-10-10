/**
 * Run: node src/services/sherwinInvoices.test.js
 */
import { parseSherwinInvoiceText } from './sherwinInvoices.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const text = `
ACCOUNT: 4206-8703-0
INVOICE
No. 02424154851026
PO# 26095
DATE: 10/01/2026
6502-05669 5 GAL B42B81 WB DF FL BLACK 10 24.45 244.50
CHARGE $261.62
ACCOUNT: 4206-8703-0
INVOICE
No. 11111111111111
PO# SHOP
DATE: 09/01/2026
6508-93746 EACH EASY SAND 5 3LB BAG 1 10.99 10.99
CHARGE $11.76
ACCOUNT: 4206-8703-0
INVOICE
No. 22222222222222
PO#
DATE: 08/01/2026
6501-32764 GALLON B28W8111 PREM W&W PRM WHITE 2 -42.95 -85.90
104-0351 GALLON A15T5 WDSCPS ST EXT STN 1 48.45 48.45
6513-52916 QUART K37T3754 EMERALD UTE SA UD 1 32.45 32.45
CASH $10.00
ACCOUNT: 4206-8703-0
INVOICE
No. 02424154851026
PO# 26095
DATE: 10/01/2026
02 of 02
`;

const invoices = parseSherwinInvoiceText(text);
assertEq(invoices.length, 3, 'three invoices');
const job = invoices.find((invoice) => invoice.docNumber === '02424154851026');
assertEq(job.jobNumber, '26095', 'po is the job');
assertEq(job.gallons, 50, 'ten 5-gallon cans');
assertEq(job.date, '2026-10-01', 'date');
assertEq(job.amount, 261.62, 'charge');
assertEq(job.lines.length, 1, 'page 2 adds no lines');
const shop = invoices.find((invoice) => invoice.docNumber === '11111111111111');
assertEq(shop.jobNumber, null, 'SHOP is not a job');
assertEq(shop.gallons, 0, 'a bag is not gallons');
const returned = invoices.find((invoice) => invoice.docNumber === '22222222222222');
assertEq(returned.gallons, -0.75, 'return 2 gallons, keep 1 quart and 1 gallon');

console.log('sherwinInvoices.test.js: all assertions passed');
