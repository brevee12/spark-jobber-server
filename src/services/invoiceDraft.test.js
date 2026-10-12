/**
 * Run: node src/services/invoiceDraft.test.js
 */
import { buildInvoiceCreateInput, buildInvoiceLine, buildJobCreateInput } from '../../jobber/client.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const line = buildInvoiceLine({
  name: '1 Labor',
  description: 'exterior painting',
  unitPrice: 750,
  productOrServiceId: 'PROD',
});
assert(line.taxable === false, 'labor line is not taxed');
assert(line.quantity === 1 && line.unitPrice === 750, 'price is 750');
assert(line.description === 'exterior painting', 'description');

const input = buildInvoiceCreateInput({
  clientId: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x',
  propertyId: 'Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzE=',
  jobId: 'Z2lkOi8vSm9iYmVyL0pvYi8x',
  subject: 'Exterior touch ups',
  lineItems: [line],
});
assert(input.markSent === false, 'invoice stays a draft');
assert(input.tax.taxCalculationMethod === 'EXCLUSIVE', 'tax method');
assert(!input.tax.taxRateId, 'no tax rate');
assert(input.dueDetails.invoiceNet === 0, 'due on receipt');
assert(input.lineItems.length === 1 && input.lineItems[0].unitPrice === 750, 'one line');
assert(input.clientId && input.propertyId && input.jobId, 'ids passed through');

let threw = false;
try {
  buildInvoiceCreateInput({ clientId: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x', lineItems: [] });
} catch (err) {
  threw = /line item/i.test(err.message);
}
assert(threw, 'refuses an invoice with no lines');

const job = buildJobCreateInput({
  propertyId: 'Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzE=',
  quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=',
  title: 'Exterior Repaint',
  lineItems: [{
    name: '1 Labor',
    quantity: 160,
    unitPrice: 60,
    taxable: true,
    quoteLineItemId: 'QL1',
  }],
  notes: [{ message: 'Hold until next year.', pinned: true }],
});
assert(job.quoteId === 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', 'quote converts onto the job');
assert(job.scheduling.createVisits === false, 'no visit until one is scheduled');
assert(job.lineItems[0].quoteLineItemId === 'QL1', 'quote line is linked');
assert(job.notes[0].message.includes('next year'), 'note is kept');

console.log('invoiceDraft.test.js: all assertions passed');
