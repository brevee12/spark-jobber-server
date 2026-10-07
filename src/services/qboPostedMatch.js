/**
 * Verify SimpleFIN rows against posted QBO activity.
 *
 * QBO's Banking "For Review" queue is NOT exposed by the API. The reliable
 * approach: SimpleFIN downloads − already-posted QBO txs = still needs
 * categorizing (either sitting in For Review, or not yet accepted).
 *
 * Match key: amount + TxnDate (±1 day). Description is a tie-breaker only.
 * Entities: Purchase, Deposit, Transfer, JournalEntry, BillPayment, Payment.
 */

import { qboQuery } from './qbo.js';

function moneyKey(n) {
  const v = Math.abs(Number(n));
  if (!Number.isFinite(v)) return null;
  return v.toFixed(2);
}

function normalizeDesc(s = '') {
  return String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 64);
}

function descOverlap(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 3;
  const as = new Set(a.split(' ').filter((w) => w.length > 2));
  const bs = b.split(' ').filter((w) => w.length > 2);
  let hits = 0;
  for (const w of bs) if (as.has(w)) hits += 1;
  return hits;
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function queryAll(entity, startDate, endDate, { slimSql } = {}) {
  const start = String(startDate).slice(0, 10);
  const end = endDate ? String(endDate).slice(0, 10) : null;
  const rows = [];
  let pos = 1;
  const page = 1000;

  for (let guard = 0; guard < 15; guard += 1) {
    const where =
      `WHERE TxnDate >= '${start}'` +
      (end ? ` AND TxnDate <= '${end}'` : '');
    let sql =
      slimSql ||
      `SELECT * FROM ${entity} ${where} STARTPOSITION ${pos} MAXRESULTS ${page}`;
    if (!slimSql && pos === 1) {
      sql = `SELECT * FROM ${entity} ${where} MAXRESULTS ${page}`;
    } else if (!slimSql) {
      sql = `SELECT * FROM ${entity} ${where} STARTPOSITION ${pos} MAXRESULTS ${page}`;
    } else if (pos > 1) {
      sql = `${slimSql.replace(/MAXRESULTS \d+/i, `STARTPOSITION ${pos} MAXRESULTS ${page}`)}`;
      if (!/STARTPOSITION/i.test(sql)) {
        sql = slimSql.replace(
          /MAXRESULTS \d+/i,
          `STARTPOSITION ${pos} MAXRESULTS ${page}`
        );
      }
    }

    let qr;
    try {
      qr = await qboQuery(sql);
    } catch (err) {
      if (slimSql || guard > 0) throw err;
      // Fall back to Id/TxnDate/amount fields only.
      const fallback =
        entity === 'JournalEntry'
          ? `SELECT Id, TxnDate, PrivateNote, Line FROM JournalEntry ${where} MAXRESULTS ${page}`
          : entity === 'Transfer'
            ? `SELECT Id, TxnDate, Amount, PrivateNote FROM Transfer ${where} MAXRESULTS ${page}`
            : null;
      if (!fallback) throw err;
      qr = await qboQuery(fallback);
    }

    const batch = qr[entity] || [];
    rows.push(...batch);
    if (batch.length < page) break;
    pos += batch.length;
  }
  return rows;
}

// One QBO record between two fed accounts (checking ↔ CC / loan) clears a
// feed line on each side, so it may satisfy two SimpleFIN rows.
const BALANCE_SHEET_ACCOUNT_RE = /^(N\/P|CC-|Checking|Loan|LOC)\b/i;

function linesTouchBalanceSheet(lines = []) {
  return lines.some((l) => {
    const ref =
      l.AccountBasedExpenseLineDetail?.AccountRef ||
      l.DepositLineDetail?.AccountRef ||
      l.JournalEntryLineDetail?.AccountRef;
    return BALANCE_SHEET_ACCOUNT_RE.test(String(ref?.name || ''));
  });
}

function pushCandidate(bag, { date, amount, description, id, type, uses = 1 }) {
  const mk = moneyKey(amount);
  if (!date || !mk) return;
  const key = `${date}|${mk}`;
  if (!bag.has(key)) bag.set(key, []);
  bag.get(key).push({
    id: String(id),
    type,
    description: normalizeDesc(description),
    date,
    amount: mk,
    uses,
  });
}

const CHECK_NO_RE = /\b(?:CK|CHECK|CHK)\s*#?\s*(\d{3,6})\b/i;

export function checkNumberOf(description = '') {
  return String(description).match(CHECK_NO_RE)?.[1] || null;
}

function pushEntitySafe(stats, key, count) {
  stats[key] = (stats[key] || 0) + count;
}

/**
 * Load posted QBO activity into a date|amount match bag.
 */
export async function loadQboPostedMatchBag({ startDate, endDate } = {}) {
  if (!startDate) throw new Error('loadQboPostedMatchBag requires startDate');

  // Widen QBO pull by 1 day on each side for bank vs book date skew.
  const qboStart = shiftDate(String(startDate).slice(0, 10), -1) || startDate;
  const qboEnd = endDate
    ? shiftDate(String(endDate).slice(0, 10), 1) || endDate
    : endDate;

  const bag = new Map();
  const stats = {};
  const errors = [];

  async function load(entity, mapFn) {
    try {
      const rows = await queryAll(entity, qboStart, qboEnd);
      pushEntitySafe(stats, entity, rows.length);
      for (const row of rows) mapFn(row);
    } catch (err) {
      pushEntitySafe(stats, entity, 0);
      errors.push({ entity, error: err.message });
    }
  }

  await load('Purchase', (p) => {
    const entity =
      p.EntityRef?.name || p.AccountRef?.name || p.PaymentType || '';
    const lineDesc = (p.Line || [])
      .map((l) => l.Description)
      .filter(Boolean)
      .join(' ');
    pushCandidate(bag, {
      date: p.TxnDate,
      amount: p.TotalAmt,
      description: `${entity} ${lineDesc} ${p.PrivateNote || ''}`,
      id: p.Id,
      type: 'Purchase',
      uses: linesTouchBalanceSheet(p.Line) ? 2 : 1,
    });
  });

  await load('Deposit', (d) => {
    const lineDesc = (d.Line || [])
      .map((l) => l.Description || l.DepositLineDetail?.Entity?.name)
      .filter(Boolean)
      .join(' ');
    pushCandidate(bag, {
      date: d.TxnDate,
      amount: d.TotalAmt,
      description: `${lineDesc} ${d.PrivateNote || ''}`,
      id: d.Id,
      type: 'Deposit',
      uses: linesTouchBalanceSheet(d.Line) ? 2 : 1,
    });
  });

  await load('Transfer', (t) => {
    pushCandidate(bag, {
      date: t.TxnDate,
      amount: t.Amount,
      description: t.PrivateNote || 'Transfer',
      id: t.Id,
      type: 'Transfer',
      uses: 2,
    });
  });

  await load('BillPayment', (bp) => {
    pushCandidate(bag, {
      date: bp.TxnDate,
      amount: bp.TotalAmt,
      description: `${bp.VendorRef?.name || ''} ${bp.PrivateNote || ''} BillPayment`,
      id: bp.Id,
      type: 'BillPayment',
    });
  });

  await load('Payment', (pay) => {
    pushCandidate(bag, {
      date: pay.TxnDate,
      amount: pay.TotalAmt,
      description: `${pay.CustomerRef?.name || ''} ${pay.PrivateNote || ''} Payment`,
      id: pay.Id,
      type: 'Payment',
    });
  });

  // Payroll / LOC / misc often land as journal entries — index every line amount.
  await load('JournalEntry', (je) => {
    const note = je.PrivateNote || '';
    const lines = je.Line || [];
    if (!lines.length) {
      pushCandidate(bag, {
        date: je.TxnDate,
        amount: je.TotalAmt || je.HomeTotalAmt,
        description: note || 'JournalEntry',
        id: je.Id,
        type: 'JournalEntry',
      });
      return;
    }
    const seen = new Set();
    for (const line of lines) {
      const amt = line.Amount;
      const mk = moneyKey(amt);
      if (!mk || seen.has(mk)) continue;
      seen.add(mk);
      pushCandidate(bag, {
        date: je.TxnDate,
        amount: amt,
        description: `${note} ${line.Description || ''} JournalEntry`,
        id: `${je.Id}:${mk}`,
        type: 'JournalEntry',
        uses: 2,
      });
    }
  });

  return { bag, stats, errors, qboStart, qboEnd };
}

function findBestHit(local, date, mk, desc) {
  if (!date || !mk) return null;
  const dayOffsets = [0, -1, 1];
  let best = null;

  for (const offset of dayOffsets) {
    const day = offset === 0 ? date : shiftDate(date, offset);
    if (!day) continue;
    const key = `${day}|${mk}`;
    const candidates = local.get(key);
    if (!candidates?.length) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      // Prefer exact date, then description overlap.
      const score =
        (offset === 0 ? 10 : 5) + descOverlap(desc, candidates[i].description);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const candidate = candidates[bestIdx];
    const ranked = {
      candidate,
      key,
      bestIdx,
      score: bestScore,
      dateOffset: offset,
    };
    if (!best || ranked.score > best.score) best = ranked;
  }

  if (!best) return null;
  const list = local.get(best.key);
  const hit = list[best.bestIdx];
  hit.uses = (hit.uses ?? 1) - 1;
  if (hit.uses <= 0) list.splice(best.bestIdx, 1);
  return { ...hit, dateOffset: best.dateOffset, score: best.score };
}

/**
 * Annotate SimpleFIN txs with qboMatch; optionally filter to unmatched only.
 */
export function matchSimpleFinToQbo(
  transactions = [],
  bag,
  { onlyOutstanding = true, checkIndex = null } = {}
) {
  const matched = [];
  const outstanding = [];

  const local = new Map();
  for (const [k, arr] of bag.entries()) {
    local.set(k, arr.map((c) => ({ ...c })));
  }

  const checks = new Map(checkIndex || []);

  for (const tx of transactions) {
    const mk = moneyKey(tx.amount);
    const desc = normalizeDesc(tx.description);
    const checkNo = checkNumberOf(tx.description);
    let hit = null;
    if (checkNo && checks.has(`${checkNo}|${mk}`)) {
      hit = { ...checks.get(`${checkNo}|${mk}`), dateOffset: null, score: 'checkNumber' };
      checks.delete(`${checkNo}|${mk}`);
    }
    if (!hit) hit = findBestHit(local, tx.date, mk, desc);

    if (hit) {
      matched.push({
        ...tx,
        alreadyInQbo: true,
        qboMatch: {
          id: hit.id,
          type: hit.type,
          dateOffset: hit.dateOffset,
          score: hit.score,
        },
      });
    } else {
      outstanding.push({
        ...tx,
        alreadyInQbo: false,
        qboMatch: null,
        verifyNote: 'No Purchase/Deposit/Transfer/JE/BillPayment/Payment with same amount within ±1 day',
      });
    }
  }

  const transactionsOut = onlyOutstanding
    ? outstanding
    : [...outstanding, ...matched];

  /** Per SimpleFIN account: feed size vs already in QBO vs still need categorize */
  const byAccount = {};
  for (const tx of transactions) {
    const name = tx.accountName || tx.accountId || 'Unknown account';
    if (!byAccount[name]) {
      byAccount[name] = { feed: 0, matched: 0, need: 0 };
    }
    byAccount[name].feed += 1;
  }
  for (const tx of matched) {
    const name = tx.accountName || tx.accountId || 'Unknown account';
    byAccount[name].matched += 1;
  }
  for (const tx of outstanding) {
    const name = tx.accountName || tx.accountId || 'Unknown account';
    byAccount[name].need += 1;
  }

  return {
    transactions: transactionsOut,
    matched,
    outstanding,
    summary: {
      simplefinTotal: transactions.length,
      alreadyInQbo: matched.length,
      outstanding: outstanding.length,
      onlyOutstanding,
      byAccount,
    },
  };
}

// Checks are often written in QBO well before they clear the bank.
const CHECK_LOOKBACK_DAYS = 120;

/** DocNumber|amount → posted check (Purchase or BillPayment), any date in window. */
export async function loadQboCheckIndex({ startDate, endDate } = {}) {
  const index = new Map();
  for (const entity of ['Purchase', 'BillPayment']) {
    const rows = await queryAll(entity, startDate, endDate);
    for (const row of rows) {
      const doc = String(row.DocNumber || '').trim();
      const mk = moneyKey(row.TotalAmt);
      if (!/^\d{3,6}$/.test(doc) || !mk) continue;
      index.set(`${doc}|${mk}`, {
        id: String(row.Id),
        type: `${entity} (check #${doc}, ${row.TxnDate})`,
        date: row.TxnDate,
        amount: mk,
      });
    }
  }
  return index;
}

/**
 * Fetch QBO posted activity and filter SimpleFIN to outstanding rows.
 */
export async function filterOutstandingAgainstQbo(
  transactions = [],
  { startDate, endDate, onlyOutstanding = true } = {}
) {
  if (!transactions.length) {
    return {
      transactions: [],
      matched: [],
      outstanding: [],
      summary: {
        simplefinTotal: 0,
        alreadyInQbo: 0,
        outstanding: 0,
        onlyOutstanding,
        qbo: {},
      },
    };
  }

  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  const effectiveStart = startDate || dates[0];
  const effectiveEnd = endDate || dates[dates.length - 1];
  const { bag, stats, errors, qboStart, qboEnd } = await loadQboPostedMatchBag({
    startDate: effectiveStart,
    endDate: effectiveEnd,
  });
  let checkIndex = null;
  if (transactions.some((t) => checkNumberOf(t.description))) {
    try {
      checkIndex = await loadQboCheckIndex({
        startDate: shiftDate(String(effectiveStart).slice(0, 10), -CHECK_LOOKBACK_DAYS),
        endDate: qboEnd,
      });
    } catch (err) {
      errors.push({ entity: 'checkNumbers', error: err.message });
    }
  }
  const matched = matchSimpleFinToQbo(transactions, bag, { onlyOutstanding, checkIndex });
  return {
    ...matched,
    summary: {
      ...matched.summary,
      qbo: stats,
      qboErrors: errors,
      qboWindow: { start: qboStart, end: qboEnd },
    },
  };
}
