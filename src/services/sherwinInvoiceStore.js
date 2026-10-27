/**
 * Local Sherwin invoice archive. History is loaded from Sherwin's invoice
 * CSV (100 at a time). The nightly email import adds invoices that are not
 * already in the file. Searching this store does not call Sherwin, Resend,
 * or QuickBooks. Nothing here posts a Jobber expense.
 *
 * The CSV "Job Number" column is the store account (always 1, VEENSTRA
 * PAINTING). The PO Number is the Jobber job when it is 4–6 digits.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SHERWIN_INVOICE_DB = path.join(
  __dirname,
  '../../data/sherwin-invoices.sqlite'
);

let sharedDb = null;

export function sherwinInvoiceDbPath() {
  return process.env.SHERWIN_INVOICE_DB?.trim() || SHERWIN_INVOICE_DB;
}

function connect(dbPath = sherwinInvoiceDbPath()) {
  if (dbPath === ':memory:') return openSherwinInvoiceDb(dbPath);
  if (!sharedDb || sharedDb.path !== dbPath) {
    sharedDb = { path: dbPath, db: openSherwinInvoiceDb(dbPath) };
  }
  return sharedDb.db;
}

export function openSherwinInvoiceDb(dbPath = sherwinInvoiceDbPath()) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_key TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      order_number TEXT,
      po_number TEXT,
      job_number TEXT,
      order_date TEXT,
      order_total REAL,
      taxes REAL,
      account_number TEXT,
      sherwin_job_number TEXT,
      job_name TEXT,
      store_number TEXT,
      store_address TEXT,
      doc_type TEXT,
      doc_number TEXT,
      source TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lines (
      invoice_key TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      sku TEXT,
      product_number TEXT,
      product_name TEXT,
      quantity REAL,
      price REAL,
      color_name TEXT,
      PRIMARY KEY (invoice_key, line_index)
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices(po_number);
    CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_number);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(order_date);
  `);
  return db;
}

/** Quoted Sherwin export. A doubled quote inside a field is one quote. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  return rows;
}

function num(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function cell(record, name) {
  return String(record[name] ?? '').trim();
}

/** A 4–6 digit PO is a Jobber job number. SHOP and a person's name are not. */
export function jobNumberFromPo(po) {
  return /^\d{4,6}$/.test(String(po || '')) ? String(po) : null;
}

function rowRecord(header, cells) {
  const record = {};
  header.forEach((name, index) => {
    record[name] = cells[index] ?? '';
  });
  return record;
}

/**
 * Sherwin repeats the invoice number on every line and fills the order
 * date only on the first line. Later lines are more products on that invoice.
 */
export function parseSherwinInvoiceCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((name) => name.trim());
  const invoices = [];
  let current = null;

  for (const cells of rows.slice(1)) {
    const record = rowRecord(header, cells);
    const invoiceNumber = cell(record, 'Invoice Number');
    if (!invoiceNumber) continue;
    const line = {
      sku: cell(record, 'SKU') || null,
      productNumber: cell(record, 'Product/REX Number') || null,
      productName: cell(record, 'Product Name') || null,
      quantity: num(record.Quantity),
      price: num(record.Price),
      colorName: cell(record, 'Color Name') || null,
    };
    const startsInvoice = cell(record, 'Order Date') !== '';
    if (!current || current.invoiceNumber !== invoiceNumber || startsInvoice) {
      if (current && current.invoiceNumber === invoiceNumber && !startsInvoice) {
        current.lines.push(line);
        continue;
      }
      const po = cell(record, 'PO Number') || null;
      current = {
        invoiceNumber,
        orderNumber: cell(record, 'Order Number') || null,
        poNumber: po,
        jobNumber: jobNumberFromPo(po),
        orderDate: cell(record, 'Order Date') || null,
        orderTotal: num(record['Order Total']),
        taxes: num(record.Taxes),
        accountNumber: cell(record, 'Account Number') || null,
        sherwinJobNumber: cell(record, 'Job Number') || null,
        jobName: cell(record, 'Job Name') || null,
        storeNumber: cell(record, 'Store Number') || null,
        storeAddress: cell(record, 'Unit Number') || null,
        docType: cell(record, 'Type') || null,
        docNumber: null,
        lines: [line],
      };
      invoices.push(current);
      continue;
    }
    current.lines.push(line);
  }
  return invoices;
}

/** Store + invoice number + date. A short invoice number is reused across years. */
export function sherwinInvoiceKey(invoice, source) {
  if (source === 'email') return `email:${invoice.docNumber || invoice.invoiceNumber}`;
  const store = invoice.storeNumber || '';
  const date = invoice.orderDate || '';
  return `${store}:${invoice.invoiceNumber}:${date}`;
}

function moneyClose(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.02;
}

/** A CSV row replaces an email-only copy of the same PO, date, and total. */
function absorbEmailCopy(db, invoice) {
  if (invoice.docNumber) return invoice;
  const twin = db
    .prepare(
      `SELECT invoice_key, doc_number, order_total FROM invoices
       WHERE source = 'email' AND po_number IS ? AND order_date IS ?`
    )
    .all(invoice.poNumber, invoice.orderDate)
    .find((row) => moneyClose(row.order_total, invoice.orderTotal));
  if (!twin) return invoice;
  db.prepare('DELETE FROM lines WHERE invoice_key = ?').run(twin.invoice_key);
  db.prepare('DELETE FROM invoices WHERE invoice_key = ?').run(twin.invoice_key);
  return { ...invoice, docNumber: twin.doc_number };
}

function writeInvoice(db, invoice, source) {
  const stored = source === 'csv' ? absorbEmailCopy(db, invoice) : invoice;
  const key = sherwinInvoiceKey(stored, source);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO invoices (
      invoice_key, invoice_number, order_number, po_number, job_number, order_date,
      order_total, taxes, account_number, sherwin_job_number, job_name,
      store_number, store_address, doc_type, doc_number, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(invoice_key) DO UPDATE SET
      invoice_number = excluded.invoice_number,
      order_number = excluded.order_number,
      po_number = excluded.po_number,
      job_number = excluded.job_number,
      order_date = excluded.order_date,
      order_total = excluded.order_total,
      taxes = excluded.taxes,
      account_number = excluded.account_number,
      sherwin_job_number = excluded.sherwin_job_number,
      job_name = excluded.job_name,
      store_number = excluded.store_number,
      store_address = excluded.store_address,
      doc_type = excluded.doc_type,
      doc_number = COALESCE(excluded.doc_number, invoices.doc_number),
      source = excluded.source,
      updated_at = excluded.updated_at`
  ).run(
    key,
    stored.invoiceNumber,
    stored.orderNumber,
    stored.poNumber,
    stored.jobNumber,
    stored.orderDate,
    stored.orderTotal,
    stored.taxes,
    stored.accountNumber,
    stored.sherwinJobNumber,
    stored.jobName,
    stored.storeNumber,
    stored.storeAddress,
    stored.docType,
    stored.docNumber,
    source,
    now
  );
  db.prepare('DELETE FROM lines WHERE invoice_key = ?').run(key);
  const insertLine = db.prepare(
    `INSERT INTO lines (
      invoice_key, line_index, sku, product_number, product_name, quantity, price, color_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  invoice.lines.forEach((line, index) => {
    insertLine.run(
      key,
      index,
      line.sku,
      line.productNumber,
      line.productName,
      line.quantity,
      line.price,
      line.colorName
    );
  });
}

export function upsertSherwinInvoices(invoices, { source = 'csv', db } = {}) {
  const database = db || connect();
  database.exec('BEGIN');
  try {
    for (const invoice of invoices) writeInvoice(database, invoice, source);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return { invoices: invoices.length, lines: invoices.reduce((n, inv) => n + inv.lines.length, 0) };
}

export function importSherwinInvoiceCsv(text, opts = {}) {
  const invoices = parseSherwinInvoiceCsv(text);
  const saved = upsertSherwinInvoices(invoices, opts);
  return { ...saved, parsed: invoices.length };
}

/**
 * An emailed PDF uses a long document number. The CSV uses the short invoice
 * number. The same PO, date, and total is the same invoice, so the email
 * does not create a second copy.
 */
export function rememberSherwinEmailInvoices(invoices = [], { db } = {}) {
  const database = db || connect();
  let stored = 0;
  let linked = 0;
  for (const invoice of invoices) {
    if (!invoice?.docNumber) continue;
    const po = invoice.po || invoice.poNumber || null;
    const date = invoice.date || invoice.orderDate || null;
    const total = invoice.amount ?? invoice.orderTotal ?? null;
    const existing = database
      .prepare(
        `SELECT invoice_key, order_total FROM invoices
         WHERE source = 'csv' AND po_number IS ? AND order_date IS ?`
      )
      .all(po, date)
      .find((row) => moneyClose(row.order_total, total));
    if (existing) {
      database
        .prepare('UPDATE invoices SET doc_number = ?, updated_at = ? WHERE invoice_key = ?')
        .run(String(invoice.docNumber), new Date().toISOString(), existing.invoice_key);
      linked += 1;
      continue;
    }
    const lines = (invoice.lines || []).map((line) => ({
      sku: line.sku || line.salesNumber || null,
      productNumber: line.productNumber || line.product || null,
      productName: line.productName || line.description || null,
      quantity: line.quantity ?? line.qty ?? null,
      price: line.price ?? line.value ?? null,
      colorName: line.colorName || line.color || null,
    }));
    writeInvoice(
      database,
      {
        invoiceNumber: String(invoice.docNumber),
        orderNumber: null,
        poNumber: po,
        jobNumber: jobNumberFromPo(po),
        orderDate: date,
        orderTotal: total,
        taxes: null,
        accountNumber: null,
        sherwinJobNumber: null,
        jobName: null,
        storeNumber: null,
        storeAddress: null,
        docType: null,
        docNumber: String(invoice.docNumber),
        lines,
      },
      'email'
    );
    stored += 1;
  }
  return { stored, linked };
}

function invoiceFromRows(rows) {
  const invoices = new Map();
  for (const row of rows) {
    const key = row.invoice_key;
    if (!invoices.has(key)) {
      invoices.set(key, {
        invoiceNumber: row.invoice_number,
        orderNumber: row.order_number,
        poNumber: row.po_number,
        jobNumber: row.job_number,
        orderDate: row.order_date,
        orderTotal: row.order_total,
        taxes: row.taxes,
        storeNumber: row.store_number,
        storeAddress: row.store_address,
        docNumber: row.doc_number,
        lines: [],
      });
    }
    invoices.get(key).lines.push({
      productNumber: row.product_number,
      productName: row.product_name,
      quantity: row.quantity,
      price: row.price,
      colorName: row.color_name,
      sku: row.sku,
    });
  }
  return [...invoices.values()];
}

/**
 * Every word must appear on the invoice: PO, job number, color, or product.
 * No query returns the newest invoices.
 */
export function searchSherwinInvoices({ query = '', limit = 25, db } = {}) {
  const database = db || connect();
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1);
  const max = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const hay =
    `lower(i.invoice_number || ' ' || ifnull(i.po_number,'') || ' ' || ifnull(i.job_number,'') || ' ' || ifnull(i.doc_number,'') || ' ' || ifnull(l.product_name,'') || ' ' || ifnull(l.product_number,'') || ' ' || ifnull(l.color_name,''))`;
  const where = words.map(() => `instr(${hay}, ?)`).join(' AND ');
  const columns = `i.invoice_key, i.invoice_number, i.order_number, i.po_number, i.job_number, i.order_date,
       i.order_total, i.taxes, i.store_number, i.store_address, i.doc_number,
       l.sku, l.product_number, l.product_name, l.quantity, l.price, l.color_name`;
  const sql = where
    ? `SELECT ${columns} FROM lines l JOIN invoices i ON i.invoice_key = l.invoice_key
       WHERE ${where}
       ORDER BY i.order_date DESC, i.invoice_number, l.line_index`
    : `SELECT ${columns} FROM lines l JOIN invoices i ON i.invoice_key = l.invoice_key
       ORDER BY i.order_date DESC, i.invoice_number, l.line_index
       LIMIT ?`;
  const rows = where
    ? database.prepare(sql).all(...words)
    : database.prepare(sql).all(max * 20);
  const invoices = invoiceFromRows(rows).slice(0, max);
  return {
    query: query || null,
    count: invoices.length,
    invoices,
  };
}
