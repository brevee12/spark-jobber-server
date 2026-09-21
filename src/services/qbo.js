import crypto from 'crypto';
import { readJson, writeJson, deleteJson } from '../lib/jsonStore.js';

const TOKEN_FILE = '.qbo-tokens.json';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const pendingStates = new Map();

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

export function loadQboTokens() {
  if (process.env.QBO_ACCESS_TOKEN && process.env.QBO_REALM_ID) {
    return {
      accessToken: process.env.QBO_ACCESS_TOKEN,
      refreshToken: process.env.QBO_REFRESH_TOKEN || null,
      realmId: process.env.QBO_REALM_ID,
      expiresAt: process.env.QBO_EXPIRES_AT
        ? Number(process.env.QBO_EXPIRES_AT)
        : null,
    };
  }
  return readJson(TOKEN_FILE);
}

export function saveQboTokens(tokens) {
  const payload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    realmId: tokens.realmId,
    expiresAt: tokens.expiresAt,
    obtainedAt: new Date().toISOString(),
    environment: environment(),
  };
  writeJson(TOKEN_FILE, payload);
  return payload;
}

export function clearQboTokens() {
  deleteJson(TOKEN_FILE);
}

export function hasQboTokens() {
  const t = loadQboTokens();
  return Boolean(t?.accessToken && t?.realmId);
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
    throw new Error(
      `QBO token error (${res.status}): ${data.error_description || data.error || JSON.stringify(data)}`
    );
  }
  return data;
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

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;

  return saveQboTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    realmId: String(realmId),
    expiresAt,
  });
}

export async function refreshQboAccessToken() {
  const current = loadQboTokens();
  if (!current?.refreshToken) {
    throw new Error('No QBO refresh token. Visit /qbo/auth to connect QuickBooks.');
  }

  const data = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;

  return saveQboTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    realmId: current.realmId,
    expiresAt,
  });
}

async function getValidAccessToken() {
  let tokens = loadQboTokens();
  if (!tokens?.accessToken || !tokens?.realmId) {
    throw new Error('QuickBooks is not connected. Open /qbo/auth to authorize.');
  }

  // Refresh ~5 minutes before expiry (or if unknown expiry and file-based)
  const skewMs = 5 * 60 * 1000;
  if (tokens.expiresAt && Date.now() >= tokens.expiresAt - skewMs) {
    tokens = await refreshQboAccessToken();
  }

  return tokens;
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
