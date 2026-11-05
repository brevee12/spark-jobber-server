/**
 * Job file: Sherwin invoice lines, the job they belong to, and the OneDrive
 * link for the original PDF. The PDF bytes live in OneDrive, not on the server.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function archiveDbPath() {
  return (
    process.env.JOB_ARCHIVE_DB?.trim() ||
    path.join(__dirname, '../../data/job-archive.sqlite')
  );
}

let shared = null;

export function openArchive(dbPath = archiveDbPath()) {
  if (dbPath === ':memory:') return createArchive(dbPath);
  if (!shared || shared.path !== dbPath) {
    shared = { path: dbPath, db: createArchive(dbPath) };
  }
  return shared.db;
}

export function createArchive(dbPath = archiveDbPath()) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      doc_number TEXT,
      po_number TEXT,
      job_number TEXT,
      doc_date TEXT,
      total REAL,
      client_name TEXT,
      filename TEXT,
      sha256 TEXT,
      drive_item_id TEXT,
      drive_url TEXT,
      body TEXT,
      updated_at TEXT,
      UNIQUE(source, doc_number)
    );
    CREATE TABLE IF NOT EXISTS lines (
      document_id INTEGER NOT NULL,
      line_index INTEGER NOT NULL,
      sku TEXT,
      product TEXT,
      description TEXT,
      color TEXT,
      quantity REAL,
      price REAL,
      PRIMARY KEY (document_id, line_index)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      job_number TEXT PRIMARY KEY,
      title TEXT,
      client_name TEXT,
      address TEXT,
      jobber_url TEXT,
      start_at TEXT,
      end_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_documents_job ON documents(job_number);
    CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(doc_date);
    CREATE INDEX IF NOT EXISTS idx_lines_product ON lines(product);
  `);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

export function rememberDocument(db, doc = {}) {
  const source = String(doc.source || 'sherwin');
  const docNumber = doc.docNumber ? String(doc.docNumber) : null;
  const existing = docNumber
    ? db.prepare('SELECT id, drive_item_id, drive_url, sha256 FROM documents WHERE source = ? AND doc_number = ?').get(source, docNumber)
    : null;

  const fields = {
    po_number: doc.poNumber || doc.po || null,
    job_number: doc.jobNumber || null,
    doc_date: doc.date || null,
    total: doc.total == null ? null : Number(doc.total),
    client_name: doc.clientName || null,
    filename: doc.filename || null,
    sha256: doc.sha256 || existing?.sha256 || null,
    drive_item_id: doc.driveItemId || existing?.drive_item_id || null,
    drive_url: doc.driveUrl || existing?.drive_url || null,
    body: doc.body || null,
    updated_at: nowIso(),
  };

  let id = existing?.id;
  if (id) {
    db.prepare(`UPDATE documents SET
      po_number = COALESCE(?, po_number),
      job_number = COALESCE(?, job_number),
      doc_date = COALESCE(?, doc_date),
      total = COALESCE(?, total),
      client_name = COALESCE(?, client_name),
      filename = COALESCE(?, filename),
      sha256 = COALESCE(?, sha256),
      drive_item_id = COALESCE(?, drive_item_id),
      drive_url = COALESCE(?, drive_url),
      body = COALESCE(?, body),
      updated_at = ?
      WHERE id = ?`).run(
      fields.po_number,
      fields.job_number,
      fields.doc_date,
      fields.total,
      fields.client_name,
      fields.filename,
      fields.sha256,
      fields.drive_item_id,
      fields.drive_url,
      fields.body,
      fields.updated_at,
      id
    );
    db.prepare('DELETE FROM lines WHERE document_id = ?').run(id);
  } else {
    const result = db.prepare(`INSERT INTO documents (
      source, doc_number, po_number, job_number, doc_date, total, client_name,
      filename, sha256, drive_item_id, drive_url, body, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      source,
      docNumber,
      fields.po_number,
      fields.job_number,
      fields.doc_date,
      fields.total,
      fields.client_name,
      fields.filename,
      fields.sha256,
      fields.drive_item_id,
      fields.drive_url,
      fields.body,
      fields.updated_at
    );
    id = Number(result.lastInsertRowid);
  }

  const insertLine = db.prepare(`INSERT INTO lines (
    document_id, line_index, sku, product, description, color, quantity, price
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  (doc.lines || []).forEach((line, index) => {
    insertLine.run(
      id,
      index,
      line.sku || line.salesNumber || null,
      line.product || null,
      line.description || null,
      line.color || null,
      line.quantity == null ? line.qty ?? null : line.quantity,
      line.price == null ? line.value ?? null : line.price
    );
  });
  return id;
}

export function rememberJob(db, job = {}) {
  if (!job.jobNumber) return null;
  db.prepare(`INSERT INTO jobs (
    job_number, title, client_name, address, jobber_url, start_at, end_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(job_number) DO UPDATE SET
    title = COALESCE(excluded.title, jobs.title),
    client_name = COALESCE(excluded.client_name, jobs.client_name),
    address = COALESCE(excluded.address, jobs.address),
    jobber_url = COALESCE(excluded.jobber_url, jobs.jobber_url),
    start_at = COALESCE(excluded.start_at, jobs.start_at),
    end_at = COALESCE(excluded.end_at, jobs.end_at),
    updated_at = excluded.updated_at`).run(
    String(job.jobNumber),
    job.title || null,
    job.clientName || null,
    job.address || null,
    job.jobberUrl || null,
    job.startAt || null,
    job.endAt || null,
    nowIso()
  );
  if (job.clientName) {
    db.prepare(`UPDATE documents SET client_name = COALESCE(client_name, ?) WHERE job_number = ?`).run(
      job.clientName,
      String(job.jobNumber)
    );
  }
  return String(job.jobNumber);
}

export function vocabulary(db) {
  const column = (sql) => db.prepare(sql).all().map((row) => row.value).filter(Boolean);
  return {
    products: column(`SELECT DISTINCT product AS value FROM lines`),
    colors: column(`SELECT DISTINCT color AS value FROM lines`),
    clients: column(`SELECT DISTINCT client_name AS value FROM documents
      UNION SELECT DISTINCT client_name AS value FROM jobs`),
    titles: column(`SELECT DISTINCT title AS value FROM jobs`),
  };
}

export function archiveCounts(db) {
  return {
    documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
    lines: db.prepare('SELECT COUNT(*) AS n FROM lines').get().n,
    jobs: db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
    withFile: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE drive_url IS NOT NULL').get().n,
  };
}

function like(value) {
  return `%${String(value).replace(/[%_]/g, '')}%`;
}

/**
 * Lines that match the interpreted question. Dates are inclusive ISO days.
 */
export function findLines(db, query = {}) {
  const where = [];
  const args = [];
  if (query.jobNumber) {
    where.push('d.job_number = ?');
    args.push(String(query.jobNumber));
  }
  if (query.from) {
    where.push('d.doc_date >= ?');
    args.push(String(query.from).slice(0, 10));
  }
  if (query.to) {
    where.push('d.doc_date < ?');
    args.push(String(query.to).slice(0, 10));
  }
  if (query.product) {
    where.push('(l.product LIKE ? OR l.description LIKE ? OR d.body LIKE ?)');
    args.push(like(query.product), like(query.product), like(query.product));
  }
  if (query.color) {
    where.push('(l.color LIKE ? OR l.description LIKE ? OR d.body LIKE ?)');
    args.push(like(query.color), like(query.color), like(query.color));
  }
  if (query.client) {
    where.push(`(
      d.client_name LIKE ? OR j.client_name LIKE ? OR j.title LIKE ? OR d.body LIKE ?
    )`);
    args.push(like(query.client), like(query.client), like(query.client), like(query.client));
  }
  const sql = `
    SELECT d.id AS documentId, d.source, d.doc_number AS docNumber, d.po_number AS poNumber,
      d.job_number AS jobNumber, d.doc_date AS date, d.total, d.client_name AS clientName,
      d.filename, d.drive_url AS driveUrl,
      j.title AS jobTitle, j.client_name AS jobClient, j.jobber_url AS jobberUrl,
      j.start_at AS jobStart,
      l.product, l.description, l.color, l.quantity, l.price
    FROM lines l
    JOIN documents d ON d.id = l.document_id
    LEFT JOIN jobs j ON j.job_number = d.job_number
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.doc_date DESC, d.id DESC, l.line_index ASC
    LIMIT ?
  `;
  args.push(Math.min(Number(query.limit) || 40, 80));
  return db.prepare(sql).all(...args);
}

export function findJobsInRange(db, { from, to, limit = 40 } = {}) {
  return db.prepare(`
    SELECT d.job_number AS jobNumber,
      COALESCE(j.title, '') AS title,
      COALESCE(j.client_name, d.client_name, '') AS clientName,
      j.jobber_url AS jobberUrl,
      MIN(d.doc_date) AS firstDate,
      MAX(d.doc_date) AS lastDate,
      COUNT(DISTINCT d.id) AS invoices
    FROM documents d
    LEFT JOIN jobs j ON j.job_number = d.job_number
    WHERE d.job_number IS NOT NULL
      AND d.doc_date >= ?
      AND d.doc_date < ?
    GROUP BY d.job_number
    ORDER BY lastDate DESC
    LIMIT ?
  `).all(String(from).slice(0, 10), String(to).slice(0, 10), limit);
}
