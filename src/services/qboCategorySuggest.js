/**
 * Map staged SimpleFIN rows to accounts that actually exist in the QBO chart
 * of accounts. Never invents an account name: if nothing in the COA fits, the
 * row is flagged "needs your pick" instead.
 *
 * Priority: transfer pair → payroll match → QBO payee history → rule → flag.
 */

import { getQboAccounts } from './qbo.js';
import { queryAll, checkNumberOf } from './qboPostedMatch.js';

const HISTORY_DAYS = 365;
const PAIR_WINDOW_DAYS = 3;

/** bankStaging rule category → QBO account name (looked up live in the COA). */
const RULE_CATEGORY_TO_QBO = {
  '110 – Small Tools & Equipment': 'Small Tools & Equipment',
  'Materials / Sherwin-Williams': 'Job Supplies',
  'Supplies (review)': 'Job Supplies',
  'Software / Subscriptions': 'Office Supplies & Software',
  Insurance: 'Insurance',
  'Meals & Entertainment': 'Meals & Entertainment',
  'Fuel / Auto': 'Car & Truck',
  'Vehicle / Repairs': 'Car & Truck',
  'Telephone / Utilities': 'Cell Phone Expense',
};

/** SimpleFIN feed name fragment → QBO account name, when digits don't line up. */
const DEFAULT_FEED_ALIASES = {
  'EZ BUS': 'Checking-Marion County Bank (3696)',
};

const PNL_TYPES = new Set([
  'Expense',
  'Cost of Goods Sold',
  'Other Expense',
  'Income',
  'Other Income',
]);
const FEED_ACCOUNT_TYPES = new Set([
  'Bank',
  'Credit Card',
  'Long Term Liability',
  'Other Current Liability',
]);
const LAZY_ACCOUNTS = /^(uncategorized|ask client|reconciliation)/i;

const STOP_WORDS = new Set([
  'POS', 'PURCHASE', 'DEBIT', 'CREDIT', 'CARD', 'ACH', 'WEB', 'PPD', 'CCD',
  'PAYPAL', 'TST', 'INC', 'LLC', 'THE', 'ONLINE', 'RECURRING', 'PMT',
  'PAYMENT', 'IOWA', 'AND', 'FOR', 'WWW', 'COM', 'USA',
]);

function words(s = '') {
  return String(s)
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function vendorKey(description = '') {
  return words(description)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 2);
}

function amountOf(tx) {
  const n = Number(tx.amountSigned ?? tx.amount);
  return Number.isFinite(n) ? n : 0;
}

function dayDiff(a, b) {
  return Math.abs(
    (new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000
  );
}

function shiftDate(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function accountView(a) {
  return a ? { id: String(a.id), name: a.name, accountType: a.accountType } : null;
}

function byName(accounts, name) {
  const n = String(name || '').toLowerCase();
  return accounts.find((a) => String(a.name).toLowerCase() === n) || null;
}

/** QBO bank/CC/loan account for a SimpleFIN feed name, or null if ambiguous. */
export function qboAccountForFeed(feedName = '', accounts = [], aliases = DEFAULT_FEED_ALIASES) {
  const feedAccounts = accounts.filter((a) => FEED_ACCOUNT_TYPES.has(a.accountType));
  const loanNo = String(feedName).match(/\b(\d{4}-\d{2,3})\b/)?.[1];
  if (loanNo) {
    const hits = feedAccounts.filter((a) => a.name.includes(loanNo));
    if (hits.length === 1) return hits[0];
  }
  const digits = [...String(feedName).matchAll(/\b(\d{4})\b/g)].map((m) => m[1]);
  for (const d of new Set(digits)) {
    const hits = feedAccounts.filter((a) => a.name.includes(d));
    if (hits.length === 1) return hits[0];
  }
  for (const [frag, qboName] of Object.entries(aliases || {})) {
    if (String(feedName).toUpperCase().includes(frag.toUpperCase())) {
      const hit = byName(accounts, qboName);
      if (hit) return hit;
    }
  }
  return null;
}

function feedAliases() {
  try {
    const extra = JSON.parse(process.env.QBO_FEED_ACCOUNT_ALIASES || '{}');
    return { ...DEFAULT_FEED_ALIASES, ...extra };
  } catch {
    return DEFAULT_FEED_ALIASES;
  }
}

/** Expense-line account history from posted Purchases (payee → account). */
export function buildPayeeHistory(purchases = [], accounts = []) {
  const byId = new Map(accounts.map((a) => [String(a.id), a]));
  const history = [];
  for (const p of purchases) {
    const lines = (p.Line || []).filter((l) => l.AccountBasedExpenseLineDetail?.AccountRef);
    if (!lines.length) continue;
    const top = lines.reduce((m, l) => (Number(l.Amount) > Number(m.Amount) ? l : m));
    const acct = byId.get(String(top.AccountBasedExpenseLineDetail.AccountRef.value));
    if (!acct || !PNL_TYPES.has(acct.accountType) || LAZY_ACCOUNTS.test(acct.name)) continue;
    history.push({
      text: words(
        `${p.EntityRef?.name || ''} ${lines.map((l) => l.Description || '').join(' ')} ${p.PrivateNote || ''}`
      ).join(' '),
      payee: p.EntityRef?.name || null,
      account: acct,
      amount: Number(p.TotalAmt),
      isCheck: p.PaymentType === 'Check',
      docNumber: p.DocNumber || null,
      date: p.TxnDate,
    });
  }
  return history;
}

function historyPick(tx, history) {
  const key = vendorKey(tx.description);
  if (!key.length) return null;
  const attempt = (tokens) => {
    const counts = new Map();
    for (const h of history) {
      const ws = h.text.split(' ');
      if (!tokens.every((t) => ws.some((w) => w.startsWith(t) || (w.length >= 4 && t.startsWith(w))))) continue;
      const c = counts.get(h.account.id) || { account: h.account, n: 0, payee: h.payee };
      c.n += 1;
      counts.set(h.account.id, c);
    }
    const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
    if (!ranked.length) return null;
    const total = ranked.reduce((s, r) => s + r.n, 0);
    return { ...ranked[0], total };
  };
  return attempt(key) || (key.length > 1 && key[0].length >= 5 ? attempt([key[0]]) : null);
}

function checkAmountPick(tx, history) {
  const amt = Math.abs(amountOf(tx));
  const hits = history.filter((h) => h.isCheck && Math.abs(h.amount - amt) < 0.005);
  if (!hits.length) return null;
  const last = hits.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return last;
}

const isPayroll = (d) => /intuit.*\bpayroll\b|\bpayroll\b.*intuit/i.test(d);
const isPayrollTax = (d) => /intuit.*\btax\b/i.test(d);
const isTransferLike = (d) =>
  /capital\s*one|autopay|crcardpmt|\bLNS?\b|\btransfer\b|\bxfer\b|advance|payment\s+from\s+chk/i.test(d);

function suggestion(source, display, account = null, note = null) {
  return {
    suggestedCategory: display,
    suggestedQboAccount: accountView(account),
    suggestionSource: source,
    suggestionNote: note,
  };
}

function needsPick(reason) {
  return suggestion('needs-input', `Needs your pick: ${reason}`, null, reason);
}

/**
 * Pure mapping step. `feedLines` = every SimpleFIN line in the window (incl.
 * already-in-QBO ones) so transfer pairs can be found across accounts.
 */
export function suggestQboAccounts(
  transactions = [],
  { accounts = [], history = [], feedLines = [], aliases = DEFAULT_FEED_ALIASES } = {}
) {
  const pool = feedLines.length ? feedLines : transactions;
  const ccAccounts = accounts.filter((a) => a.accountType === 'Credit Card');

  return transactions.map((tx) => {
    const desc = String(tx.description || '');
    const amount = amountOf(tx);
    const ownAccount = qboAccountForFeed(tx.accountName, accounts, aliases);
    const isLoanFeed = /\bloan\b/i.test(tx.accountName || '');

    const pair = pool.find(
      (o) =>
        o.id !== tx.id &&
        (o.accountName || '') !== (tx.accountName || '') &&
        Math.abs(amountOf(o) + amount) < 0.005 &&
        dayDiff(o.date, tx.date) <= PAIR_WINDOW_DAYS
    );
    if (pair && (isTransferLike(desc) || isTransferLike(pair.description || '') || isLoanFeed)) {
      const other = qboAccountForFeed(pair.accountName, accounts, aliases);
      const pairNote = pair.alreadyInQbo
        ? 'other side already in QBO — match this line to that transfer'
        : 'one QBO transfer clears both feed lines';
      if (other && ownAccount) {
        return {
          ...tx,
          ...suggestion('transfer-pair', `Transfer ↔ ${other.name}`, other, pairNote),
          pairedTxId: pair.id,
        };
      }
      return {
        ...tx,
        ...needsPick(`transfer to/from "${pair.accountName}" — no single QBO account matches that feed`),
        pairedTxId: pair.id,
      };
    }

    if (isPayroll(desc)) {
      return {
        ...tx,
        ...suggestion('match-payroll', 'Match: QBO payroll paycheck', null,
          'Payroll paychecks are not visible to the API — match in Banking, do not categorize'),
      };
    }
    if (isPayrollTax(desc)) {
      return {
        ...tx,
        ...suggestion('match-payroll', 'Match: QBO payroll tax payment', null,
          'Payroll tax payments are not visible to the API — match in Banking, do not categorize'),
      };
    }

    if (isLoanFeed) {
      if (!ownAccount) {
        const base = String(tx.accountName).match(/\b(\d{4})-\d{2,3}\b/)?.[1];
        const near = base
          ? accounts.filter((a) => FEED_ACCOUNT_TYPES.has(a.accountType) && a.name.includes(base))
          : [];
        const hint = near.length ? ` — is it ${near.map((a) => a.name).join(' or ')}?` : '';
        return { ...tx, ...needsPick(`loan feed "${tx.accountName}" has no exact QBO account${hint}`) };
      }
      const checking = qboAccountForFeed('EZ BUS', accounts, aliases);
      return {
        ...tx,
        ...suggestion('transfer-loan', `Transfer ↔ ${checking?.name || 'checking'}`, ownAccount,
          `loan line on ${ownAccount.name}`),
      };
    }

    if (/crcardpmt|autopay|capital\s*one/i.test(desc) && amount < 0) {
      if (ccAccounts.length === 1) {
        return { ...tx, ...suggestion('transfer-cc', `Transfer ↔ ${ccAccounts[0].name}`, ccAccounts[0]) };
      }
      return {
        ...tx,
        ...needsPick(`card payment — which card? (${ccAccounts.map((a) => a.name).join(' or ')})`),
      };
    }

    const checkNo = checkNumberOf(desc);
    if (checkNo) {
      const prior = checkAmountPick(tx, history);
      if (prior) {
        return {
          ...tx,
          ...suggestion('check-history', prior.account.name, prior.account,
            `same amount as check #${prior.docNumber || '?'} to ${prior.payee || 'unknown payee'} on ${prior.date}`),
        };
      }
      return { ...tx, ...needsPick(`check #${checkNo} not in QBO — who was it paid to?`) };
    }

    const hist = historyPick(tx, history);
    if (hist) {
      return {
        ...tx,
        ...suggestion('history', hist.account.name, hist.account,
          `${hist.n}/${hist.total} past ${hist.payee || 'payee'} purchases went here`),
      };
    }

    const ruleName = RULE_CATEGORY_TO_QBO[tx.suggestedCategory];
    const ruleAccount = ruleName ? byName(accounts, ruleName) : null;
    if (ruleAccount) {
      return { ...tx, ...suggestion('rule', ruleAccount.name, ruleAccount, 'no QBO history for this payee') };
    }

    if (amount > 0 && !/credit_card/.test(tx.accountKind || '')) {
      return { ...tx, ...needsPick('deposit — match to a customer payment, or pick an income account') };
    }
    return { ...tx, ...needsPick('no QBO history or rule for this payee') };
  });
}

/** Live COA + payee history from QBO. */
export async function loadSuggestionContext({ endDate } = {}) {
  const accounts = await getQboAccounts();
  const end = endDate || new Date().toISOString().slice(0, 10);
  let purchases = [];
  let historyError = null;
  try {
    purchases = await queryAll('Purchase', shiftDate(end, -HISTORY_DAYS), end);
  } catch (err) {
    historyError = err.message;
  }
  return {
    accounts,
    history: buildPayeeHistory(purchases, accounts),
    aliases: feedAliases(),
    historyError,
  };
}
