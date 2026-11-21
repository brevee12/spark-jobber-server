/**
 * Jobber is the source of truth for sales tax.
 * QuickBooks Automated Sales Tax can add tax when a Jobber invoice was saved
 * with no tax rate. This removes that tax only when the extra QuickBooks
 * amount is the tax, and the customer has not already paid more than Jobber.
 */

import { searchInvoices } from '../../jobber/client.js';
import { getQboInvoicesByDocNumber, updateQboInvoice } from './qbo.js';

const TAX_NOTE = 'Sales tax removed to match Jobber, which has no tax on this invoice.';

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function jobberTax(invoice) {
  return money(invoice?.amounts?.taxAmount ?? invoice?.taxAmount ?? 0) ?? 0;
}

function jobberTotal(invoice) {
  return money(invoice?.amounts?.total ?? invoice?.total);
}

/**
 * Decide whether this QuickBooks invoice should lose its sales tax.
 * `paid` is TotalAmt minus Balance.
 */
export function planQboTaxClear({ qbo, jobber } = {}) {
  const jobberAmount = jobberTotal(jobber);
  const taxOnJobber = jobberTax(jobber);
  const qboTotal = money(qbo?.TotalAmt);
  const qboTax = money(qbo?.TxnTaxDetail?.TotalTax ?? 0) ?? 0;
  const balance = money(qbo?.Balance ?? 0) ?? 0;
  const paid = qboTotal == null ? null : money(qboTotal - balance);

  if (!qbo || qboTotal == null) {
    return { action: 'skip', reason: 'QuickBooks invoice has no total' };
  }
  if (!jobber || jobberAmount == null) {
    return { action: 'skip', reason: 'No Jobber invoice with this number' };
  }
  if (taxOnJobber > 0) {
    return { action: 'skip', reason: 'Jobber already charges sales tax' };
  }
  if (qboTax <= 0) {
    return { action: 'skip', reason: 'QuickBooks has no sales tax' };
  }
  const extra = money(qboTotal - jobberAmount);
  if (Math.abs(extra - qboTax) > 0.05) {
    return {
      action: 'skip',
      reason: `QuickBooks is $${extra} above Jobber, but the tax is $${qboTax}`,
    };
  }
  if (paid != null && paid - jobberAmount > 0.05) {
    return {
      action: 'skip',
      reason: 'The customer already paid more than the Jobber total',
    };
  }
  return {
    action: 'clear',
    jobberTotal: jobberAmount,
    qboTotal,
    qboTax,
    paid,
    balance,
  };
}

/** Sales lines become non-taxable. Discount and description lines stay. */
export function invoiceWithoutSalesTax(invoice) {
  const keep = new Set(['SalesItemLineDetail', 'DiscountLineDetail', 'DescriptionOnly']);
  const line = (invoice.Line || [])
    .filter((row) => keep.has(row.DetailType))
    .map((row) => {
      if (row.DetailType !== 'SalesItemLineDetail') return row;
      return {
        ...row,
        SalesItemLineDetail: {
          ...row.SalesItemLineDetail,
          TaxCodeRef: { value: 'NON' },
        },
      };
    });
  const note = String(invoice.PrivateNote || '').trim();
  const next = {
    ...invoice,
    sparse: false,
    Line: line,
    PrivateNote: note.includes(TAX_NOTE) ? note : note ? `${note}\n${TAX_NOTE}` : TAX_NOTE,
  };
  delete next.TxnTaxDetail;
  delete next.MetaData;
  delete next.InvoiceLink;
  delete next.DeliveryInfo;
  return next;
}

async function jobberByNumber(docNumber, findJobber) {
  const found = await findJobber({ invoiceNumber: String(docNumber), limit: 5 });
  const invoices = found?.invoices || [];
  return (
    invoices.find((invoice) => String(invoice.invoiceNumber) === String(docNumber)) || null
  );
}

/**
 * Compare the named invoices and, when apply is true, remove QuickBooks tax
 * that Jobber does not charge.
 */
export async function clearQboInvoiceTax({
  docNumbers = [],
  apply = false,
  findJobber = searchInvoices,
  loadQbo = getQboInvoicesByDocNumber,
  saveQbo = updateQboInvoice,
} = {}) {
  const docs = [...new Set(docNumbers.map((doc) => String(doc).trim()).filter(Boolean))];
  const results = [];

  for (const docNumber of docs) {
    const base = { docNumber };
    try {
      const [qboRows, jobber] = await Promise.all([
        loadQbo(docNumber),
        jobberByNumber(docNumber, findJobber),
      ]);
      if (qboRows.length !== 1) {
        results.push({
          ...base,
          action: 'skip',
          reason: qboRows.length ? `${qboRows.length} QuickBooks invoices share this number` : 'No QuickBooks invoice',
        });
        continue;
      }
      const qbo = qboRows[0];
      const plan = planQboTaxClear({ qbo, jobber });
      const row = {
        ...base,
        customer: qbo.CustomerRef?.name || jobber?.clientName || null,
        ...plan,
        qboId: qbo.Id || null,
      };
      if (!apply || plan.action !== 'clear') {
        results.push(row);
        continue;
      }
      const saved = await saveQbo(invoiceWithoutSalesTax(qbo));
      const taxLeft = money(saved?.TxnTaxDetail?.TotalTax ?? null);
      results.push({
        ...row,
        action: 'cleared',
        qboId: saved?.Id || qbo.Id,
        qboTotalAfter: money(saved?.TotalAmt),
        qboTaxAfter: taxLeft,
        balanceAfter: money(saved?.Balance),
      });
    } catch (err) {
      results.push({ ...base, action: 'error', reason: err.message });
    }
  }

  return {
    apply: Boolean(apply),
    cleared: results.filter((row) => row.action === 'cleared').length,
    ready: results.filter((row) => row.action === 'clear').length,
    skipped: results.filter((row) => row.action === 'skip').length,
    errors: results.filter((row) => row.action === 'error').length,
    results,
  };
}
