/**
 * Match SimpleFIN rows against already-posted QBO activity so briefs only
 * show true outstanding (not every historical bank download).
 *
 * "Seen" (SIMPLEFIN_PROCESSED_IDS) is email/approve dedupe.
 * "Booked in QBO" means a Purchase / Deposit / Transfer already exists.
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
    .slice(0, 48);
}

function descOverlap(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 2;
  const as = new Set(a.split(' ').filter((w) => w.length > 2));
  const bs = b.split(' ').filter((w) => w.length > 2);
  let hits = 0;
  for (const w of bs) if (as.has(w)) hits += 1;
  return hits;
}

async function queryAll(entity, startDate, endDate) {
  const start = String(startDate).slice(0, 10);
  const end = endDate ? String(endDate).slice(0, 10) : null;
  const rows = [];
  let pos = 1;
  const page = 1000;

  for (let guard = 0; guard < 10; guard += 1) {
    let sql =
      `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' ` +
      (end ? `AND TxnDate <= '${end}' ` : '') +
      `ORDERBY TxnDate MAXRESULTS ${page}`;
    if (pos > 1) {
      sql =
        `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' ` +
        (end ? `AND TxnDate <= '${end}' ` : '') +
        `STARTPOSITION ${pos} MAXRESULTS ${page}`;
    }
    let qr;
    try {
      qr = await qboQuery(sql);
    } catch (err) {
      // Some companies disallow SELECT * on Transfer — retry slim columns.
      if (/Transfer/i.test(entity)) {
        const slim =
          `SELECT Id, TxnDate, Amount, PrivateNote FROM Transfer WHERE TxnDate >= '${start}' ` +
          (end ? `AND TxnDate <= '${end}' ` : '') +
          `MAXRESULTS ${page}`;
        qr = await qboQuery(slim);
      } else {
        throw err;
      }
    }
    const batch = qr[entity] || [];
    rows.push(...batch);
    if (batch.length < page) break;
    pos += batch.length;
  }
  return rows;
}

function pushCandidate(bag, { date, amount, description, id, type }) {
  const mk = moneyKey(amount);
  if (!date || !mk) return;
  const key = `${date}|${mk}`;
  if (!bag.has(key)) bag.set(key, []);
  bag.get(key).push({
    id: String(id),
    type,
    description: normalizeDesc(description),
  });
}

/**
 * Load posted QBO bank-ish activity into a match bag.
 */
export async function loadQboPostedMatchBag({ startDate, endDate } = {}) {
  if (!startDate) throw new Error('loadQboPostedMatchBag requires startDate');

  const bag = new Map();
  const stats = { purchase: 0, deposit: 0, transfer: 0 };

  const purchases = await queryAll('Purchase', startDate, endDate);
  stats.purchase = purchases.length;
  for (const p of purchases) {
    const entity =
      p.EntityRef?.name ||
      p.AccountRef?.name ||
      p.PaymentType ||
      '';
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
    });
  }

  const deposits = await queryAll('Deposit', startDate, endDate);
  stats.deposit = deposits.length;
  for (const d of deposits) {
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
    });
  }

  try {
    const transfers = await queryAll('Transfer', startDate, endDate);
    stats.transfer = transfers.length;
    for (const t of transfers) {
      pushCandidate(bag, {
        date: t.TxnDate,
        amount: t.Amount,
        description: t.PrivateNote || 'Transfer',
        id: t.Id,
        type: 'Transfer',
      });
    }
  } catch (err) {
    stats.transferError = err.message;
  }

  return { bag, stats };
}

/**
 * Annotate SimpleFIN txs with qboMatch; optionally filter to unmatched only.
 * @returns {{ transactions: object[], summary: object }}
 */
export function matchSimpleFinToQbo(transactions = [], bag, { onlyOutstanding = true } = {}) {
  const matched = [];
  const outstanding = [];

  // Work on a mutable copy of candidate lists.
  const local = new Map();
  for (const [k, arr] of bag.entries()) {
    local.set(k, [...arr]);
  }

  for (const tx of transactions) {
    const date = tx.date;
    const mk = moneyKey(tx.amount);
    const key = date && mk ? `${date}|${mk}` : null;
    const desc = normalizeDesc(tx.description);
    let hit = null;

    if (key && local.has(key) && local.get(key).length) {
      const candidates = local.get(key);
      let bestIdx = 0;
      let bestScore = -1;
      for (let i = 0; i < candidates.length; i += 1) {
        const score = descOverlap(desc, candidates[i].description);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      // Accept date+amount match even with weak description (common for feed clears).
      hit = candidates.splice(bestIdx, 1)[0];
    }

    if (hit) {
      matched.push({
        ...tx,
        alreadyInQbo: true,
        qboMatch: { id: hit.id, type: hit.type },
      });
    } else {
      outstanding.push({
        ...tx,
        alreadyInQbo: false,
        qboMatch: null,
      });
    }
  }

  const transactionsOut = onlyOutstanding ? outstanding : [...outstanding, ...matched];

  return {
    transactions: transactionsOut,
    summary: {
      simplefinTotal: transactions.length,
      alreadyInQbo: matched.length,
      outstanding: outstanding.length,
      onlyOutstanding,
    },
  };
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
      summary: {
        simplefinTotal: 0,
        alreadyInQbo: 0,
        outstanding: 0,
        onlyOutstanding,
        qbo: { purchase: 0, deposit: 0, transfer: 0 },
      },
    };
  }

  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  const effectiveStart = startDate || dates[0];
  const effectiveEnd = endDate || dates[dates.length - 1];
  const { bag, stats } = await loadQboPostedMatchBag({
    startDate: effectiveStart,
    endDate: effectiveEnd,
  });
  const matched = matchSimpleFinToQbo(transactions, bag, { onlyOutstanding });
  return {
    ...matched,
    summary: { ...matched.summary, qbo: stats },
  };
}
