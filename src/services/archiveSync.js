/**
 * Fill the job archive from a parsed Sherwin invoice, a Sherwin CSV export,
 * or a QuickBooks bill. A PDF is uploaded to OneDrive when that account is
 * connected. The index is kept either way.
 */

import crypto from 'crypto';
import { rememberDocument, rememberJob } from './jobArchive.js';
import { oneDrivePath, uploadOneDriveFile } from './oneDrive.js';
import { parseSherwinInvoiceText } from './sherwinInvoices.js';
import { qboQuery } from './qbo.js';

function colorFromText(text) {
  const match = String(text || '').match(/Color:\s*([^\n|]+)/i);
  return match ? match[1].trim() : null;
}

export function linesFromParsedInvoice(invoice) {
  return (invoice.lines || []).map((line) => ({
    sku: line.salesNumber || line.sku || null,
    product: line.product || line.description || null,
    description: line.description || null,
    color: line.color || colorFromText(line.description),
    quantity: line.qty ?? line.quantity ?? null,
    price: line.value ?? line.price ?? null,
  }));
}

export async function rememberSherwinInvoice(db, invoice, { source = 'sherwin-email', file, upload = uploadOneDriveFile } = {}) {
  const lines = linesFromParsedInvoice(invoice);
  let drive = null;
  let sha256 = null;
  let filename = null;
  if (file?.bytes) {
    sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
    filename = file.filename || `${invoice.date || 'invoice'} ${invoice.docNumber || ''}.pdf`.trim();
    const path = oneDrivePath({
      jobNumber: invoice.jobNumber,
      clientName: invoice.clientName,
      filename,
    });
    drive = await upload({ path, bytes: file.bytes, contentType: file.contentType || 'application/pdf' });
  }
  const id = rememberDocument(db, {
    source,
    docNumber: invoice.docNumber,
    poNumber: invoice.po || invoice.poNumber || null,
    jobNumber: invoice.jobNumber || null,
    date: invoice.date || null,
    total: invoice.amount ?? invoice.total ?? null,
    clientName: invoice.clientName || null,
    filename,
    sha256,
    driveItemId: drive?.driveItemId || null,
    driveUrl: drive?.driveUrl || null,
    lines,
    body: lines.map((line) => [line.product, line.color].filter(Boolean).join(' ')).join('\n'),
  });
  return { id, drive, sha256 };
}

export async function rememberSherwinPacket(db, { invoices = [], files = [], upload } = {}) {
  const stored = [];
  for (const invoice of invoices) {
    const file = files.find((item) => item?.bytes) || null;
    stored.push(await rememberSherwinInvoice(db, invoice, { file, upload, source: 'sherwin-email' }));
  }
  return { documents: stored.length, stored };
}

export function parseSherwinCsv(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  const index = (name) => header.findIndex((cell) => cell === name);
  const invoiceCol = index('invoice number');
  const poCol = index('po number');
  const dateCol = index('order date');
  const totalCol = index('order total');
  const productCol = index('product name');
  const colorCol = index('color name');
  const qtyCol = index('quantity');
  const priceCol = index('price');
  const skuCol = index('sku');
  if (invoiceCol < 0) {
    throw new Error('The CSV needs an Invoice Number column from the Sherwin invoice export.');
  }
  const grouped = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const docNumber = cells[invoiceCol]?.trim();
    if (!docNumber) continue;
    const po = poCol >= 0 ? cells[poCol]?.trim() : '';
    const jobNumber = po && /^\d{4,6}$/.test(po) ? po : null;
    if (!grouped.has(docNumber)) {
      grouped.set(docNumber, {
        docNumber,
        po: po || null,
        jobNumber,
        date: dateCol >= 0 ? normalizeCsvDate(cells[dateCol]) : null,
        amount: totalCol >= 0 ? Number(String(cells[totalCol] || '').replace(/[$,]/g, '')) || null : null,
        lines: [],
      });
    }
    grouped.get(docNumber).lines.push({
      sku: skuCol >= 0 ? cells[skuCol]?.trim() : null,
      product: productCol >= 0 ? cells[productCol]?.trim() : null,
      description: productCol >= 0 ? cells[productCol]?.trim() : null,
      color: colorCol >= 0 ? cells[colorCol]?.trim() : null,
      quantity: qtyCol >= 0 ? Number(cells[qtyCol]) || null : null,
      price: priceCol >= 0 ? Number(String(cells[priceCol] || '').replace(/[$,]/g, '')) || null : null,
    });
    rows.push(docNumber);
  }
  return [...grouped.values()];
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeCsvDate(value) {
  const text = String(value || '').trim();
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

export async function importSherwinCsv(db, text, { upload } = {}) {
  const invoices = parseSherwinCsv(text);
  let documents = 0;
  for (const invoice of invoices) {
    await rememberSherwinInvoice(db, invoice, { source: 'sherwin-csv', upload: upload || (async () => ({ stored: false })) });
    documents += 1;
  }
  return { documents, invoices: invoices.length };
}

export function billsToInvoices(bills = []) {
  return bills.map((bill) => {
    const note = bill.privateNote || bill.PrivateNote || '';
    const po = bill.poNumber || note.match(/PO#:\s*([A-Za-z0-9-]+)/i)?.[1] || null;
    const jobNumber = bill.jobNumber || (po && /^\d{4,6}$/.test(po) ? po : null);
    const lines = (bill.lines || bill.Line || []).map((line) => {
      const description = line.description || line.Description || line.item || '';
      const product = description.match(/Description:\s*([^\n|]+)/i)?.[1]?.trim() || line.item || description;
      return {
        product,
        description,
        color: colorFromText(description),
        quantity: null,
        price: line.amount ?? line.Amount ?? null,
      };
    }).filter((line) => line.product && !/sales tax/i.test(line.product));
    return {
      docNumber: bill.docNumber || bill.DocNumber || (bill.id ? `qbo-${bill.id}` : null),
      po,
      jobNumber,
      date: bill.txnDate || bill.TxnDate || null,
      amount: bill.totalAmount ?? bill.TotalAmt ?? null,
      lines,
    };
  }).filter((invoice) => invoice.docNumber);
}

export async function importQboSherwinBills(db, { query = qboQuery, vendorId = process.env.QBO_SHERWIN_VENDOR_ID || '24' } = {}) {
  const bills = [];
  for (let start = 1; start < 5000; start += 100) {
    const page = await query(
      `SELECT * FROM Bill WHERE VendorRef = '${String(vendorId).replace(/'/g, '')}' ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 100`
    );
    const chunk = page.Bill || [];
    bills.push(...chunk);
    if (chunk.length < 100) break;
  }
  const invoices = billsToInvoices(bills.map((bill) => ({
    id: bill.Id,
    docNumber: bill.DocNumber,
    txnDate: bill.TxnDate,
    totalAmount: bill.TotalAmt,
    privateNote: bill.PrivateNote || bill.Memo || '',
    lines: (bill.Line || []).filter((line) => line.DetailType === 'AccountBasedExpenseLineDetail' || line.DetailType === 'ItemBasedExpenseLineDetail').map((line) => ({
      description: line.Description || null,
      amount: line.Amount,
      item: line.ItemBasedExpenseLineDetail?.ItemRef?.name || line.AccountBasedExpenseLineDetail?.AccountRef?.name || null,
    })),
  })));
  let documents = 0;
  for (const invoice of invoices) {
    await rememberSherwinInvoice(db, invoice, { source: 'qbo-bill', upload: async () => ({ stored: false }) });
    documents += 1;
  }
  return { bills: bills.length, documents };
}

export async function rememberUploadedPdf(db, { filename, bytes }) {
  const text = await (await import('./pdfText.js')).extractPdfText(bytes);
  const invoices = parseSherwinInvoiceText(text);
  if (!invoices.length) {
    throw new Error(`${filename || 'That file'} did not read as a Sherwin invoice.`);
  }
  const stored = [];
  for (const invoice of invoices) {
    stored.push(await rememberSherwinInvoice(db, invoice, {
      source: 'sherwin-upload',
      file: { filename: filename || `${invoice.docNumber}.pdf`, bytes, contentType: 'application/pdf' },
    }));
  }
  return { documents: stored.length, invoices };
}

export async function enrichJobs(db, lookup) {
  const numbers = db.prepare(`SELECT DISTINCT job_number AS jobNumber FROM documents WHERE job_number IS NOT NULL`).all();
  let updated = 0;
  for (const row of numbers) {
    const found = await lookup(row.jobNumber);
    if (!found) continue;
    rememberJob(db, found);
    updated += 1;
  }
  return { updated };
}
