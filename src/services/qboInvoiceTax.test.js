/**
 * Run: node src/services/qboInvoiceTax.test.js
 */
import {
  clearQboInvoiceTax,
  invoiceWithoutSalesTax,
  planQboTaxClear,
} from './qboInvoiceTax.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const jobber = {
  invoiceNumber: '25248',
  clientName: 'Jason Van Gorp',
  amounts: { subtotal: 3897.58, taxAmount: 0, total: 3897.58 },
};
const qbo = {
  Id: '99',
  SyncToken: '3',
  DocNumber: '25248',
  TotalAmt: 4160.78,
  Balance: 263.2,
  TxnTaxDetail: { TotalTax: 263.2 },
  CustomerRef: { name: 'Jason Van Gorp' },
  PrivateNote: 'Basement',
  MetaData: { CreateTime: '2026-11-20' },
  Line: [
    {
      Id: '1',
      DetailType: 'SalesItemLineDetail',
      Amount: 3760,
      SalesItemLineDetail: { ItemRef: { value: '1' }, TaxCodeRef: { value: 'TAX' } },
    },
    {
      Id: '2',
      DetailType: 'SalesItemLineDetail',
      Amount: 137.58,
      SalesItemLineDetail: { ItemRef: { value: '2' }, TaxCodeRef: { value: 'NON' } },
    },
    { Id: '3', DetailType: 'SubTotalLineDetail', Amount: 3897.58 },
  ],
};

const clear = planQboTaxClear({ qbo, jobber });
assert(clear.action === 'clear', `van gorp should clear, got ${clear.action} ${clear.reason || ''}`);
assert(clear.qboTax === 263.2, 'tax amount');
assert(clear.paid === 3897.58, 'payment matches Jobber');

const kept = planQboTaxClear({
  qbo: { TotalAmt: 5435.36, Balance: 5435.36, TxnTaxDetail: { TotalTax: 310.8 } },
  jobber: { amounts: { taxAmount: 310.8, total: 5435.36 } },
});
assert(kept.action === 'skip' && /already charges/.test(kept.reason), 'leave a taxed Jobber invoice');

const paidTax = planQboTaxClear({
  qbo: { TotalAmt: 2297.75, Balance: 0, TxnTaxDetail: { TotalTax: 143.85 } },
  jobber: { amounts: { taxAmount: 0, total: 2153.9 } },
});
assert(paidTax.action === 'skip' && /already paid/.test(paidTax.reason), 'do not drop tax already paid');

const updated = invoiceWithoutSalesTax(qbo);
assert(updated.Line.length === 2, 'subtotal line is left for QuickBooks');
assert(updated.Line.every((row) => row.SalesItemLineDetail.TaxCodeRef.value === 'NON'), 'lines are non-taxable');
assert(!updated.TxnTaxDetail, 'old tax block is not sent back');
assert(!updated.MetaData, 'metadata is not sent back');
assert(updated.PrivateNote.includes('Basement'), 'existing note stays');
assert(updated.PrivateNote.includes('Sales tax removed to match Jobber'), 'note says why');

const preview = await clearQboInvoiceTax({
  docNumbers: ['25248', '25242'],
  apply: false,
  loadQbo: async (doc) => (doc === '25248' ? [qbo] : [{
    Id: '42',
    DocNumber: '25242',
    TotalAmt: 5435.36,
    Balance: 5435.36,
    TxnTaxDetail: { TotalTax: 310.8 },
    CustomerRef: { name: 'Karen TeRonde' },
    Line: [],
  }]),
  findJobber: async ({ invoiceNumber }) => ({
    invoices: [
      invoiceNumber === '25248'
        ? jobber
        : { invoiceNumber: '25242', amounts: { taxAmount: 310.8, total: 5435.36 } },
    ],
  }),
  saveQbo: async () => {
    throw new Error('preview must not write');
  },
});
assert(preview.ready === 1 && preview.skipped === 1 && preview.cleared === 0, 'preview writes nothing');

let savedBody = null;
const applied = await clearQboInvoiceTax({
  docNumbers: ['25248'],
  apply: true,
  loadQbo: async () => [qbo],
  findJobber: async () => ({ invoices: [jobber] }),
  saveQbo: async (body) => {
    savedBody = body;
    return { Id: '99', TotalAmt: 3897.58, Balance: 0, TxnTaxDetail: { TotalTax: 0 } };
  },
});
assert(applied.cleared === 1, 'one invoice cleared');
assert(savedBody.Line[0].SalesItemLineDetail.TaxCodeRef.value === 'NON', 'write marks lines non-taxable');
assert(applied.results[0].balanceAfter === 0, 'balance drops to zero');

console.log('qboInvoiceTax.test.js: all assertions passed');
