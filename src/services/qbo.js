import crypto from 'crypto';
import { readJson, writeJson, deleteJson } from '../lib/jsonStore.js';
import { persistEnvVars } from '../lib/durableTokens.js';

const TOKEN_FILE = '.qbo-tokens.json';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const pendingStates = new Map();

/** Single-flight lock so concurrent callers share one Intuit refresh. */
let refreshInFlight = null;

/** Tracks last refresh token we durable-synced (avoid TTL-only Render writes). */
let lastDurableRefreshToken =
  process.env.QBO_REFRESH_TOKEN != null
    ? String(process.env.QBO_REFRESH_TOKEN)
    : null;

/** @type {ReturnType<typeof setInterval>|null} */
let keepaliveTimer = null;

const DEFAULT_CASH_ACCOUNT_NAMES = [
  'Checking-Marion County Bank (3696)',
  'N/P-Marion County Bank (LOC 0549-100)',
];

function requireConfig() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Missing QBO_CLIENT_ID, QBO_CLIENT_SECRET, or QBO_REDIRECT_URI. Set them in .env / Render.'
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function environment() {
  const env = (process.env.QBO_ENVIRONMENT || 'production').toLowerCase();
  return env === 'sandbox' ? 'sandbox' : 'production';
}

function apiBase() {
  return environment() === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function minorVersion() {
  return process.env.QBO_MINOR_VERSION || '75';
}

function parseExpiresAt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tokensFromEnv() {
  if (!process.env.QBO_REFRESH_TOKEN && !process.env.QBO_ACCESS_TOKEN) {
    return null;
  }
  if (!process.env.QBO_REALM_ID && !process.env.QBO_REFRESH_TOKEN) {
    return null;
  }
  return {
    accessToken: process.env.QBO_ACCESS_TOKEN || null,
    refreshToken: process.env.QBO_REFRESH_TOKEN || null,
    realmId: process.env.QBO_REALM_ID || null,
    expiresAt: parseExpiresAt(process.env.QBO_EXPIRES_AT),
    refreshExpiresAt: parseExpiresAt(process.env.QBO_REFRESH_EXPIRES_AT),
    obtainedAt: null,
    source: 'env',
  };
}

/**
 * Prefer the freshest token set between ephemeral file and env.
 * Access tokens live in memory/file; only refresh tokens are durable on Render.
 */
export function loadQboTokens() {
  const fromFile = readJson(TOKEN_FILE);
  const fromEnv = tokensFromEnv();

  if (!fromFile && !fromEnv) return null;

  if (fromFile && fromEnv) {
    const fileExp = parseExpiresAt(fromFile.expiresAt) || 0;
    const envExp = parseExpiresAt(fromEnv.expiresAt) || 0;
    // Prefer file when it has a newer access-token expiry (post-refresh in this process)
    if (fileExp >= envExp && fromFile.refreshToken) {
      return {
        accessToken: fromFile.accessToken || fromEnv.accessToken,
        refreshToken: fromFile.refreshToken,
        realmId: fromFile.realmId || fromEnv.realmId,
        expiresAt: parseExpiresAt(fromFile.expiresAt),
        refreshExpiresAt:
          parseExpiresAt(fromFile.refreshExpiresAt) ||
          fromEnv.refreshExpiresAt,
        obtainedAt: fromFile.obtainedAt || null,
        source: 'file',
      };
    }
    return {
      accessToken: fromEnv.accessToken || fromFile.accessToken,
      refreshToken: fromEnv.refreshToken || fromFile.refreshToken,
      realmId: fromEnv.realmId || fromFile.realmId,
      expiresAt: fromEnv.expiresAt || parseExpiresAt(fromFile.expiresAt),
      refreshExpiresAt:
        fromEnv.refreshExpiresAt || parseExpiresAt(fromFile.refreshExpiresAt),
      obtainedAt: fromFile.obtainedAt || null,
      source: 'env',
    };
  }

  if (fromFile) {
    return {
      ...fromFile,
      expiresAt: parseExpiresAt(fromFile.expiresAt),
      refreshExpiresAt: parseExpiresAt(fromFile.refreshExpiresAt),
      source: 'file',
    };
  }

  return fromEnv;
}

export async function saveQboTokens(tokens) {
  const payload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    realmId: tokens.realmId,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt ?? null,
    obtainedAt: new Date().toISOString(),
    environment: environment(),
  };
  writeJson(TOKEN_FILE, payload);

  // Keep access token in process env for this instance only — do NOT sync it to
  // Render (env changes redeploy Free tier and race refresh-token rotation).
  if (payload.accessToken) process.env.QBO_ACCESS_TOKEN = String(payload.accessToken);
  if (payload.expiresAt != null) {
    process.env.QBO_EXPIRES_AT = String(payload.expiresAt);
  }

  // Durable: only sync when refresh token / realm actually change.
  // Include refresh expiry in the same write so we don't redeploy for TTL drift alone.
  const prevRefresh = lastDurableRefreshToken;
  const refreshChanged = prevRefresh !== String(payload.refreshToken || '');
  const realmChanged =
    process.env.QBO_REALM_ID !== String(payload.realmId || '');

  const durable = {};
  if (refreshChanged) {
    durable.QBO_REFRESH_TOKEN = payload.refreshToken;
    if (payload.refreshExpiresAt != null) {
      durable.QBO_REFRESH_EXPIRES_AT = payload.refreshExpiresAt;
    }
  }
  if (realmChanged) {
    durable.QBO_REALM_ID = payload.realmId;
  }

  let sync = { synced: true, updated: [], skipped: [] };
  if (Object.keys(durable).length) {
    sync = await persistEnvVars(durable, { onlyIfChanged: true });
    if (refreshChanged) lastDurableRefreshToken = String(payload.refreshToken || '');
  }
  payload.durableSync = sync;
  return payload;
}

export function clearQboTokens() {
  deleteJson(TOKEN_FILE);
  delete process.env.QBO_ACCESS_TOKEN;
  delete process.env.QBO_REFRESH_TOKEN;
  delete process.env.QBO_REALM_ID;
  delete process.env.QBO_EXPIRES_AT;
  delete process.env.QBO_REFRESH_EXPIRES_AT;
}

export function hasQboTokens() {
  const t = loadQboTokens();
  return Boolean(t?.refreshToken && t?.realmId);
}

export function getQboAuthStatus() {
  const t = loadQboTokens();
  if (!t?.refreshToken || !t?.realmId) {
    return { connected: false, reason: 'not_connected' };
  }
  const now = Date.now();
  const accessExpiresInMs =
    t.expiresAt != null ? t.expiresAt - now : null;
  const refreshExpiresInMs =
    t.refreshExpiresAt != null ? t.refreshExpiresAt - now : null;
  return {
    connected: true,
    realmId: t.realmId,
    source: t.source || null,
    accessExpiresAt: t.expiresAt || null,
    accessExpiresInMinutes:
      accessExpiresInMs != null
        ? Math.round(accessExpiresInMs / 60000)
        : null,
    refreshExpiresAt: t.refreshExpiresAt || null,
    refreshExpiresInDays:
      refreshExpiresInMs != null
        ? Math.round(refreshExpiresInMs / 86400000)
        : null,
    needsReauth:
      refreshExpiresInMs != null ? refreshExpiresInMs < 7 * 86400000 : false,
  };
}

export function buildQboAuthorizeUrl() {
  const { clientId, redirectUri } = requireConfig();
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    state,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const { clientId, clientSecret } = requireConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `QBO token error (${res.status}): ${data.error_description || data.error || JSON.stringify(data)}`
    );
    err.code = data.error || null;
    err.status = res.status;
    throw err;
  }
  return data;
}

function buildTokenPayload(data, realmId, previousRefreshToken = null) {
  const now = Date.now();
  const expiresAt = now + (Number(data.expires_in) || 3600) * 1000;
  // Intuit refresh tokens typically last ~100 days; response includes x_refresh_token_expires_in
  const refreshTtlSec = Number(data.x_refresh_token_expires_in);
  const refreshExpiresAt = Number.isFinite(refreshTtlSec) && refreshTtlSec > 0
    ? now + refreshTtlSec * 1000
    : null;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken,
    realmId: String(realmId),
    expiresAt,
    refreshExpiresAt,
  };
}

export async function exchangeQboCode({ code, state, realmId }) {
  const { redirectUri } = requireConfig();
  if (!pendingStates.has(state)) {
    // Allow callback without in-memory state on multi-instance / restart (still validate presence)
    console.warn('QBO OAuth state not found in memory; continuing with code exchange');
  } else {
    pendingStates.delete(state);
  }

  if (!realmId) {
    throw new Error('QBO callback missing realmId (company ID)');
  }

  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  return saveQboTokens(buildTokenPayload(data, realmId));
}

export async function refreshQboAccessToken() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const current = loadQboTokens();
    if (!current?.refreshToken) {
      throw new Error('No QBO refresh token. Visit /qbo/auth to connect QuickBooks.');
    }
    if (!current.realmId) {
      throw new Error('No QBO realmId. Visit /qbo/auth to connect QuickBooks.');
    }

    try {
      const data = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });

      return await saveQboTokens(
        buildTokenPayload(data, current.realmId, current.refreshToken)
      );
    } catch (err) {
      // invalid_grant = refresh token revoked/expired/already rotated — force reauth
      if (
        err.code === 'invalid_grant' ||
        /invalid_grant/i.test(err.message || '')
      ) {
        clearQboTokens();
        throw new Error(
          'QuickBooks refresh token is no longer valid (revoked, expired, or already used). Reconnect at /qbo/auth'
        );
      }
      throw err;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function getValidAccessToken() {
  let tokens = loadQboTokens();
  if (!tokens?.refreshToken || !tokens?.realmId) {
    throw new Error('QuickBooks is not connected. Open /qbo/auth to authorize.');
  }

  // Refresh ~5 min before expiry, or immediately when access token / expiry unknown
  const skewMs = 5 * 60 * 1000;
  const needsRefresh =
    !tokens.accessToken ||
    !tokens.expiresAt ||
    Date.now() >= tokens.expiresAt - skewMs;

  if (needsRefresh) {
    tokens = await refreshQboAccessToken();
  }

  return tokens;
}

/**
 * On boot: hydrate a valid access token from the durable refresh token.
 */
export async function ensureQboSession() {
  const tokens = loadQboTokens();
  if (!tokens?.refreshToken || !tokens?.realmId) {
    return { ok: false, reason: 'not_connected' };
  }
  try {
    await getValidAccessToken();
    return { ok: true, ...getQboAuthStatus() };
  } catch (err) {
    console.error('QBO session restore failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Periodically touch the access token so Free-tier idle + hourly expiry
 * don't leave us stranded on a stale refresh chain.
 */
export function startQboTokenKeepalive(intervalMs = 45 * 60 * 1000) {
  if (keepaliveTimer) clearInterval(keepaliveTimer);

  const tick = async () => {
    try {
      if (!hasQboTokens()) return;
      await getValidAccessToken();
    } catch (err) {
      console.warn('QBO keepalive failed:', err.message);
    }
  };

  // Don't block listen(); run shortly after boot, then on interval
  setTimeout(tick, 5_000);
  keepaliveTimer = setInterval(tick, intervalMs);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
  return keepaliveTimer;
}

export async function qboRequest(method, path, { query, body } = {}) {
  let tokens = await getValidAccessToken();
  const url = new URL(`${apiBase()}${path}`);
  url.searchParams.set('minorversion', minorVersion());
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const doFetch = async (accessToken) => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { res, data };
  };

  let { res, data } = await doFetch(tokens.accessToken);

  if (res.status === 401 && tokens.refreshToken) {
    tokens = await refreshQboAccessToken();
    ({ res, data } = await doFetch(tokens.accessToken));
  }

  if (!res.ok) {
    const fault = data?.Fault?.Error?.[0];
    const msg = fault
      ? `${fault.Message || fault.Detail || 'QBO error'} (${fault.code || res.status})`
      : `QBO HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`;
    throw new Error(msg);
  }

  return data;
}

export async function qboQuery(sql) {
  const tokens = await getValidAccessToken();
  const data = await qboRequest(
    'GET',
    `/v3/company/${tokens.realmId}/query`,
    { query: { query: sql } }
  );
  return data?.QueryResponse || {};
}

function parsePoFromNote(note = '') {
  const text = String(note || '');
  const po =
    text.match(/PO[#:\s-]*([A-Za-z0-9-]+)/i)?.[1] ||
    text.match(/P\.?O\.?\s*#?\s*([A-Za-z0-9-]+)/i)?.[1] ||
    null;
  const job =
    text.match(/Job[#:\s-]*([A-Za-z0-9-]+)/i)?.[1] ||
    text.match(/Jobber[#:\s-]*([A-Za-z0-9-]+)/i)?.[1] ||
    null;
  return { poNumber: po, jobNumber: job };
}

/**
 * Recent Sherwin-Williams bills (VendorRef default 24).
 */
export async function getSherwinWilliamsBills({ maxResults = 20 } = {}) {
  const vendorId = process.env.QBO_SHERWIN_VENDOR_ID || '24';
  const limit = Math.min(Math.max(Number(maxResults) || 20, 1), 100);

  const sql =
    `SELECT * FROM Bill WHERE VendorRef = '${vendorId}' ` +
    `ORDERBY TxnDate DESC MAXRESULTS ${limit}`;

  const qr = await qboQuery(sql);
  const bills = qr.Bill || [];

  return bills.map((bill) => {
    const note = bill.PrivateNote || bill.Memo || '';
    const { poNumber, jobNumber } = parsePoFromNote(note);
    const lines = (bill.Line || [])
      .filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail' || l.DetailType === 'AccountBasedExpenseLineDetail')
      .map((l) => ({
        description: l.Description || null,
        amount: l.Amount,
        detailType: l.DetailType,
        item:
          l.ItemBasedExpenseLineDetail?.ItemRef?.name ||
          l.AccountBasedExpenseLineDetail?.AccountRef?.name ||
          null,
      }));

    return {
      id: bill.Id,
      docNumber: bill.DocNumber || null,
      txnDate: bill.TxnDate,
      totalAmount: bill.TotalAmt,
      balance: bill.Balance,
      vendor: bill.VendorRef?.name || 'Sherwin-Williams',
      privateNote: note || null,
      poNumber,
      jobNumber,
      salesTax: bill.TxnTaxDetail?.TotalTax ?? null,
      lines,
    };
  });
}

function inferPaymentType(paymentAccountId, explicit) {
  if (explicit) return explicit;
  // Caller can set QBO_CC_ACCOUNT_IDS=1,2,3 for credit cards
  const ccIds = (process.env.QBO_CC_ACCOUNT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ccIds.includes(String(paymentAccountId))) return 'CreditCard';
  return 'Check';
}

/**
 * Create a QBO Purchase (expense / check / CC charge).
 */
export async function postQboExpense({
  accountId,
  paymentAccountId,
  categoryAccountId,
  vendorName,
  payeeName,
  amount,
  txnDate,
  memo,
  paymentType,
}) {
  const tokens = await getValidAccessToken();
  const payAccount = paymentAccountId || accountId;
  if (!payAccount) throw new Error('paymentAccountId is required');
  if (!categoryAccountId) throw new Error('categoryAccountId is required');
  if (amount == null || Number.isNaN(Number(amount))) {
    throw new Error('amount is required');
  }

  const type = inferPaymentType(payAccount, paymentType);
  const entityName = payeeName || vendorName || undefined;

  const payload = {
    PaymentType: type,
    AccountRef: { value: String(payAccount) },
    TxnDate: txnDate || new Date().toISOString().slice(0, 10),
    PrivateNote: memo || undefined,
    Line: [
      {
        Amount: Number(amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: memo || undefined,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: String(categoryAccountId) },
        },
      },
    ],
  };

  if (entityName) {
    const safe = String(entityName).replace(/'/g, "\\'");
    const vendors = await qboQuery(
      `SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1`
    );
    const vendor = vendors.Vendor?.[0];
    if (vendor?.Id) {
      payload.EntityRef = { value: String(vendor.Id), name: vendor.DisplayName, type: 'Vendor' };
    } else {
      payload.EntityRef = { name: entityName, type: 'Vendor' };
    }
  }

  const data = await qboRequest(
    'POST',
    `/v3/company/${tokens.realmId}/purchase`,
    { body: payload }
  );

  const purchase = data?.Purchase;
  return {
    id: purchase?.Id,
    syncToken: purchase?.SyncToken,
    paymentType: purchase?.PaymentType,
    totalAmt: purchase?.TotalAmt,
    txnDate: purchase?.TxnDate,
    status: purchase?.Id ? 'created' : 'unknown',
  };
}

/**
 * Create a QBO Bank Deposit (incoming funds: owner loans, refunds, non-invoice income).
 * depositAccountId = bank/checking receiving the money
 * sourceAccountId  = equity/liability/income account the money comes from (e.g. Loan from Shareholder)
 */
export async function postQboDeposit({
  depositAccountId,
  sourceAccountId,
  amount,
  txnDate,
  payeeName,
  memo,
}) {
  const tokens = await getValidAccessToken();
  if (!depositAccountId) throw new Error('depositAccountId is required');
  if (!sourceAccountId) throw new Error('sourceAccountId is required');
  if (amount == null || Number.isNaN(Number(amount))) {
    throw new Error('amount is required');
  }

  const lineDetail = {
    AccountRef: { value: String(sourceAccountId) },
  };

  if (payeeName) {
    const safe = String(payeeName).replace(/'/g, "\\'");
    const vendors = await qboQuery(
      `SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${safe}' MAXRESULTS 1`
    );
    const vendor = vendors.Vendor?.[0];
    if (vendor?.Id) {
      lineDetail.Entity = {
        value: String(vendor.Id),
        name: vendor.DisplayName,
        type: 'VENDOR',
      };
    } else {
      const customers = await qboQuery(
        `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 1`
      );
      const customer = customers.Customer?.[0];
      if (customer?.Id) {
        lineDetail.Entity = {
          value: String(customer.Id),
          name: customer.DisplayName,
          type: 'CUSTOMER',
        };
      }
    }
  }

  const payload = {
    DepositToAccountRef: { value: String(depositAccountId) },
    TxnDate: txnDate || new Date().toISOString().slice(0, 10),
    PrivateNote: memo || undefined,
    Line: [
      {
        Amount: Number(amount),
        DetailType: 'DepositLineDetail',
        Description: memo || payeeName || undefined,
        DepositLineDetail: lineDetail,
      },
    ],
  };

  const data = await qboRequest(
    'POST',
    `/v3/company/${tokens.realmId}/deposit`,
    { body: payload }
  );

  const deposit = data?.Deposit;
  return {
    id: deposit?.Id,
    syncToken: deposit?.SyncToken,
    totalAmt: deposit?.TotalAmt,
    txnDate: deposit?.TxnDate,
    depositToAccountId: deposit?.DepositToAccountRef?.value || String(depositAccountId),
    status: deposit?.Id ? 'created' : 'unknown',
  };
}

async function findAccountsByNames(names) {
  const qr = await qboQuery('SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, Active FROM Account MAXRESULTS 1000');
  const accounts = qr.Account || [];
  const wanted = names.map((n) => n.toLowerCase());

  return accounts.filter(
    (a) =>
      a.Active !== false &&
      wanted.some(
        (w) =>
          String(a.Name || '').toLowerCase() === w ||
          String(a.Name || '').toLowerCase().includes(w)
      )
  );
}

/**
 * Live cash / LOC / card balances from QBO Account objects.
 */
export async function getQboCashSummary() {
  const extraNames = (process.env.QBO_CASH_ACCOUNT_NAMES || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const names = [...DEFAULT_CASH_ACCOUNT_NAMES, ...extraNames];

  // Also pull Capital One style credit cards by subtype / name match
  const qr = await qboQuery(
    'SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, CurrentBalanceWithSubAccounts, Active FROM Account MAXRESULTS 1000'
  );
  const accounts = (qr.Account || []).filter((a) => a.Active !== false);

  const byName = await findAccountsByNames(names);

  const capitalOne = accounts.filter(
    (a) =>
      /capital\s*one/i.test(a.Name || '') ||
      (a.AccountType === 'Credit Card' && /capital/i.test(a.Name || ''))
  );

  const uniq = new Map();
  for (const a of [...byName, ...capitalOne]) {
    uniq.set(a.Id, a);
  }

  const list = [...uniq.values()].map((a) => ({
    id: a.Id,
    name: a.Name,
    accountType: a.AccountType,
    accountSubType: a.AccountSubType,
    balance: a.CurrentBalanceWithSubAccounts ?? a.CurrentBalance ?? null,
  }));

  const checking = list.filter((a) => /checking/i.test(a.name));
  const loc = list.filter((a) => /N\/P|LOC|line of credit/i.test(a.name));
  const cards = list.filter(
    (a) => a.accountType === 'Credit Card' || /capital\s*one/i.test(a.name)
  );

  return {
    checking,
    lineOfCredit: loc,
    creditCards: cards,
    all: list,
  };
}

export async function getQboProfitAndLoss({ startDate, endDate } = {}) {
  const tokens = await getValidAccessToken();
  const end = endDate || new Date().toISOString().slice(0, 10);
  const start =
    startDate ||
    new Date(new Date(end).setMonth(new Date(end).getMonth() - 1))
      .toISOString()
      .slice(0, 10);

  const data = await qboRequest(
    'GET',
    `/v3/company/${tokens.realmId}/reports/ProfitAndLoss`,
    {
      query: {
        start_date: start,
        end_date: end,
        summarize_column_by: 'Total',
      },
    }
  );

  return {
    startDate: start,
    endDate: end,
    header: data?.Header || null,
    rows: data?.Rows || null,
  };
}

/**
 * Transfer funds between QBO accounts (CC payment, LOC draw/paydown, etc.).
 */
export async function postQboTransfer({
  fromAccountId,
  toAccountId,
  amount,
  txnDate,
  memo,
}) {
  const tokens = await getValidAccessToken();
  if (!fromAccountId) throw new Error('fromAccountId is required');
  if (!toAccountId) throw new Error('toAccountId is required');
  if (amount == null || Number.isNaN(Number(amount))) {
    throw new Error('amount is required');
  }

  const payload = {
    FromAccountRef: { value: String(fromAccountId) },
    ToAccountRef: { value: String(toAccountId) },
    Amount: Number(amount),
    TxnDate: txnDate || new Date().toISOString().slice(0, 10),
    PrivateNote: memo || undefined,
  };

  const data = await qboRequest(
    'POST',
    `/v3/company/${tokens.realmId}/transfer`,
    { body: payload }
  );

  const transfer = data?.Transfer;
  return {
    id: transfer?.Id,
    syncToken: transfer?.SyncToken,
    amount: transfer?.Amount,
    txnDate: transfer?.TxnDate,
    fromAccountId: transfer?.FromAccountRef?.value || String(fromAccountId),
    toAccountId: transfer?.ToAccountRef?.value || String(toAccountId),
    status: transfer?.Id ? 'created' : 'unknown',
  };
}

const DELETEABLE_TYPES = {
  purchase: 'purchase',
  deposit: 'deposit',
};

/**
 * Delete a QBO Purchase or Deposit (fetches SyncToken first).
 */
export async function deleteQboTransaction({ transactionId, transactionType }) {
  const tokens = await getValidAccessToken();
  if (!transactionId) throw new Error('transactionId is required');

  const typeKey = String(transactionType || '').toLowerCase();
  const entity = DELETEABLE_TYPES[typeKey];
  if (!entity) {
    throw new Error("transactionType must be 'purchase' or 'deposit'");
  }

  const read = await qboRequest(
    'GET',
    `/v3/company/${tokens.realmId}/${entity}/${transactionId}`
  );

  const entityKey = entity.charAt(0).toUpperCase() + entity.slice(1);
  const current = read?.[entityKey];
  if (!current?.Id || current.SyncToken == null) {
    throw new Error(`Could not load ${entity} ${transactionId} for delete (missing SyncToken)`);
  }

  const data = await qboRequest(
    'POST',
    `/v3/company/${tokens.realmId}/${entity}`,
    {
      query: { operation: 'delete' },
      body: {
        Id: String(current.Id),
        SyncToken: String(current.SyncToken),
      },
    }
  );

  const deleted = data?.[entityKey];
  return {
    id: deleted?.Id || String(transactionId),
    transactionType: typeKey,
    status: deleted?.status || 'Deleted',
  };
}

/**
 * List active QBO accounts, optionally filtered by name text and/or accountType.
 */
export async function getQboAccounts({ filter, accountType } = {}) {
  const qr = await qboQuery(
    'SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, CurrentBalanceWithSubAccounts, Active FROM Account WHERE Active = true MAXRESULTS 1000'
  );

  let accounts = qr.Account || [];

  if (accountType) {
    const t = String(accountType).toLowerCase();
    accounts = accounts.filter(
      (a) =>
        String(a.AccountType || '').toLowerCase() === t ||
        String(a.AccountSubType || '').toLowerCase() === t ||
        String(a.AccountType || '').toLowerCase().includes(t)
    );
  }

  if (filter) {
    const f = String(filter).toLowerCase();
    accounts = accounts.filter((a) => String(a.Name || '').toLowerCase().includes(f));
  }

  return accounts.map((a) => ({
    id: a.Id,
    name: a.Name,
    accountType: a.AccountType,
    accountSubType: a.AccountSubType,
    balance: a.CurrentBalanceWithSubAccounts ?? a.CurrentBalance ?? null,
  }));
}
