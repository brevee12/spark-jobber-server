import { readJson, writeJson } from '../lib/jsonStore.js';

const ACCESS_URL_FILE = '.simplefin-access.json';
const PROCESSED_FILE = '.simplefin-processed.json';

/**
 * Claim a one-time SimpleFIN setup token → permanent access URL.
 * Setup token is base64 of a claim URL; POST once with empty body.
 */
export async function claimSetupToken(setupToken) {
  const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim();
  if (!claimUrl.startsWith('https://')) {
    throw new Error('SimpleFIN setup token did not decode to an https claim URL');
  }

  const res = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });

  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(
      `SimpleFIN claim failed (${res.status}): ${body || res.statusText}. ` +
        'Token may be invalid or already claimed — generate a new one at bridge.simplefin.org.'
    );
  }

  if (!body.startsWith('https://') || !body.includes('@')) {
    throw new Error(`SimpleFIN claim returned unexpected access URL: ${body}`);
  }

  saveAccessUrl(body);
  return body;
}

export function saveAccessUrl(accessUrl) {
  writeJson(ACCESS_URL_FILE, {
    accessUrl,
    savedAt: new Date().toISOString(),
  });
  return accessUrl;
}

export function getAccessUrl() {
  if (process.env.SIMPLEFIN_ACCESS_URL) {
    return process.env.SIMPLEFIN_ACCESS_URL.trim();
  }
  const stored = readJson(ACCESS_URL_FILE);
  return stored?.accessUrl || null;
}

/**
 * Ensure we have an access URL: prefer env/file, else claim SIMPLEFIN_SETUP_TOKEN once.
 */
export async function ensureAccessUrl() {
  const existing = getAccessUrl();
  if (existing) return existing;

  const setup = process.env.SIMPLEFIN_SETUP_TOKEN;
  if (!setup) {
    throw new Error(
      'SimpleFIN not configured. Set SIMPLEFIN_ACCESS_URL, or SIMPLEFIN_SETUP_TOKEN to claim once.'
    );
  }

  return claimSetupToken(setup);
}

function parseAccessUrl(accessUrl) {
  const u = new URL(accessUrl);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const base = u.toString().replace(/\/$/, '');
  return { base, username, password };
}

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Convert YYYY-MM-DD (or unix seconds / Date) → unix seconds for SimpleFIN start-date.
 */
export function toUnixStart(startDate) {
  if (startDate == null || startDate === '') return null;
  if (typeof startDate === 'number') return Math.floor(startDate);
  if (/^\d+$/.test(String(startDate))) return Number(startDate);

  const d = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid startDate: ${startDate} (use YYYY-MM-DD)`);
  }
  return Math.floor(d.getTime() / 1000);
}

async function fetchAccountsRaw({ startDate, accountId } = {}) {
  const accessUrl = await ensureAccessUrl();
  const { base, username, password } = parseAccessUrl(accessUrl);

  const params = new URLSearchParams({ 'pending': '1' });
  const start = toUnixStart(startDate);
  if (start != null) params.set('start-date', String(start));
  if (accountId) params.set('account', String(accountId));

  const url = `${base}/accounts?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuthHeader(username, password) },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SimpleFIN /accounts failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('SimpleFIN returned non-JSON response');
  }

  if (data.errors?.length) {
    console.warn('SimpleFIN account errors:', data.errors);
  }

  return data;
}

export async function fetchSimpleFinAccounts() {
  const data = await fetchAccountsRaw();
  return (data.accounts || []).map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    balance: a.balance,
    'available-balance': a['available-balance'],
    org: a.org,
  }));
}

function loadProcessed() {
  const stored = readJson(PROCESSED_FILE, { ids: [] });
  return new Set(stored.ids || []);
}

export function markTransactionsProcessed(transactionIds = []) {
  const set = loadProcessed();
  for (const id of transactionIds) {
    if (id) set.add(String(id));
  }
  writeJson(PROCESSED_FILE, {
    ids: [...set],
    updatedAt: new Date().toISOString(),
  });
  return set.size;
}

export function isTransactionProcessed(id) {
  return loadProcessed().has(String(id));
}

/**
 * Fetch transactions; by default skip IDs already marked processed.
 */
export async function fetchSimpleFinTransactions({
  startDate,
  accountId,
  includeProcessed = false,
} = {}) {
  const data = await fetchAccountsRaw({ startDate, accountId });
  const processed = loadProcessed();
  const rows = [];

  for (const account of data.accounts || []) {
    if (accountId && String(account.id) !== String(accountId)) continue;

    for (const tx of account.transactions || []) {
      if (!includeProcessed && processed.has(String(tx.id))) continue;

      const postedUnix = Number(tx.posted);
      const postedIso = Number.isFinite(postedUnix)
        ? new Date(postedUnix * 1000).toISOString().slice(0, 10)
        : null;

      rows.push({
        id: tx.id,
        accountId: account.id,
        accountName: account.name,
        posted: postedUnix,
        date: postedIso,
        amount: tx.amount,
        description: tx.description || tx.payee || '',
        pending: Boolean(tx.pending),
      });
    }
  }

  rows.sort((a, b) => (b.posted || 0) - (a.posted || 0));
  return rows;
}

export function hasSimpleFinAccess() {
  return Boolean(getAccessUrl() || process.env.SIMPLEFIN_SETUP_TOKEN);
}
