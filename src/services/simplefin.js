import { readJson, writeJson } from '../lib/jsonStore.js';
import { persistEnvVars } from '../lib/durableTokens.js';

const ACCESS_URL_FILE = '.simplefin-access.json';
const PROCESSED_FILE = '.simplefin-processed.json';
/** Durable mirror on Render (JSON string array). Avoids re-emailing after deploys. */
const PROCESSED_ENV_KEY = 'SIMPLEFIN_PROCESSED_IDS';

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

/**
 * YYYY-MM-DD — SimpleFIN often returns no txs without an explicit start-date.
 * Default 45 days so stalled accounts (e.g. checking with no new posts for 2+ weeks)
 * still appear in the current bank-feed comparison window.
 */
export function defaultBankStartDate(daysBack = 45) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, Number(daysBack) || 45));
  return d.toISOString().slice(0, 10);
}

// SimpleFIN data refreshes once a day and the bridge warns above 24 req/day,
// so every caller shares one wide pull per TTL and filters it locally.
const CACHE_FILE = '.simplefin-cache.json';
const CACHE_WINDOW_DAYS = 90;
const cacheTtlMs = () =>
  Math.max(1, Number(process.env.SIMPLEFIN_CACHE_TTL_HOURS) || 4) * 3600 * 1000;
const maxDailyRequests = () =>
  Math.max(1, Number(process.env.SIMPLEFIN_MAX_DAILY_REQUESTS) || 12);

let memCache = null;

function loadCache() {
  if (!memCache) memCache = readJson(CACHE_FILE, null);
  return memCache;
}

function saveCache(cache) {
  memCache = cache;
  writeJson(CACHE_FILE, cache);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function getSimpleFinCacheInfo() {
  const c = loadCache();
  return {
    fetchedAt: c?.fetchedAt || null,
    windowStart: c?.windowStart || null,
    requestsToday: c?.counter?.day === todayUtc() ? c.counter.n : 0,
    maxDailyRequests: maxDailyRequests(),
    ttlHours: cacheTtlMs() / 3600000,
  };
}

function filterCached(data, { startDate, accountId } = {}) {
  const start = toUnixStart(startDate);
  return {
    ...data,
    accounts: (data.accounts || [])
      .filter((a) => !accountId || String(a.id) === String(accountId))
      .map((a) => ({
        ...a,
        transactions: (a.transactions || []).filter(
          (tx) => start == null || !Number(tx.posted) || Number(tx.posted) >= start
        ),
      })),
  };
}

/**
 * Cached SimpleFIN /accounts. Network only when the cache is older than the
 * TTL or doesn't reach back to startDate, and never past the daily cap
 * (stale data is served instead).
 */
async function fetchAccountsRaw({ startDate, accountId, forceRefresh = false } = {}) {
  const cache = loadCache();
  const wantStart = toUnixStart(startDate);
  const windowStart = defaultBankStartDate(CACHE_WINDOW_DAYS);
  const coversStart =
    cache && (wantStart == null || toUnixStart(cache.windowStart) <= wantStart);
  const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < cacheTtlMs();

  if (cache && coversStart && fresh && !forceRefresh) {
    return filterCached(cache.data, { startDate, accountId });
  }

  const counter =
    cache?.counter?.day === todayUtc() ? { ...cache.counter } : { day: todayUtc(), n: 0 };
  if (counter.n >= maxDailyRequests()) {
    if (cache) {
      console.warn(`SimpleFIN daily cap (${maxDailyRequests()}) reached — serving cache from ${cache.fetchedAt}`);
      return filterCached(cache.data, { startDate, accountId });
    }
    throw new Error(`SimpleFIN daily request cap (${maxDailyRequests()}) reached`);
  }

  const pullStart =
    wantStart != null && wantStart < toUnixStart(windowStart) ? startDate : windowStart;
  counter.n += 1;
  const data = await fetchAccountsNetwork({ startDate: pullStart });
  saveCache({
    fetchedAt: new Date().toISOString(),
    windowStart: String(pullStart).slice(0, 10),
    counter,
    data,
  });
  return filterCached(data, { startDate, accountId });
}

async function fetchAccountsNetwork({ startDate, accountId } = {}) {
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

function idsFromEnv() {
  const raw = process.env[PROCESSED_ENV_KEY]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // comma / whitespace separated fallback
    return raw.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function loadProcessed() {
  const stored = readJson(PROCESSED_FILE, { ids: [] });
  const set = new Set([...(stored.ids || []).map(String), ...idsFromEnv()]);
  return set;
}

function persistProcessedLocal(set) {
  const ids = [...set].sort();
  writeJson(PROCESSED_FILE, {
    ids,
    updatedAt: new Date().toISOString(),
  });
  return ids;
}

/**
 * Mark bank txs as already staged/approved so morning briefs skip them (local file).
 * @returns {number} total processed id count
 */
export function markTransactionsProcessed(transactionIds = []) {
  const set = loadProcessed();
  for (const id of transactionIds) {
    if (id) set.add(String(id));
  }
  return persistProcessedLocal(set).length;
}

/**
 * Same as markTransactionsProcessed, then persist SIMPLEFIN_PROCESSED_IDS on Render
 * so deploys do not re-stage the same lines (env sync only when the id set changes).
 */
export async function markTransactionsProcessedDurable(transactionIds = []) {
  const beforeIds = new Set(listProcessedTransactionIds());
  const beforeEnv = process.env[PROCESSED_ENV_KEY] || '';
  const count = markTransactionsProcessed(transactionIds);
  const ids = listProcessedTransactionIds();
  const added = ids.filter((id) => !beforeIds.has(id)).length;
  const next = JSON.stringify(ids);
  const durable =
    next !== beforeEnv
      ? await persistEnvVars(
          { [PROCESSED_ENV_KEY]: next },
          { onlyIfChanged: true }
        )
      : { synced: true, updated: [], skipped: [PROCESSED_ENV_KEY] };
  return { count, added, ids, durable };
}

export function isTransactionProcessed(id) {
  return loadProcessed().has(String(id));
}

export function listProcessedTransactionIds() {
  return [...loadProcessed()].sort();
}

/**
 * Fetch transactions; by default skip IDs already marked processed.
 */
export async function fetchSimpleFinTransactions({
  startDate,
  accountId,
  includeProcessed = false,
} = {}) {
  // Without start-date, SimpleFIN commonly returns an empty pending window.
  const effectiveStart = startDate || defaultBankStartDate(45);
  const data = await fetchAccountsRaw({ startDate: effectiveStart, accountId });
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
