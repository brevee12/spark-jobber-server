/**
 * OneDrive is the filing cabinet. The server uploads a Sherwin PDF into
 * Veenstra Jobs / {job} / Sherwin / and keeps the link. Tokens follow the
 * same durable refresh-token pattern as Jobber.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { persistEnvVars, clearEnvVars } from '../lib/durableTokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '../../.onedrive-tokens.json');
const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPES = 'offline_access Files.ReadWrite User.Read';

const pendingAuth = new Map();

function requireConfig() {
  const clientId = process.env.ONEDRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.ONEDRIVE_REDIRECT_URI?.trim();
  const missing = [];
  if (!clientId) missing.push('ONEDRIVE_CLIENT_ID');
  if (!clientSecret) missing.push('ONEDRIVE_CLIENT_SECRET');
  if (!redirectUri) missing.push('ONEDRIVE_REDIRECT_URI');
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(', ')}. Add them in Render → Environment, then open /onedrive/start.`
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function loadOneDriveTokens() {
  let fromFile = null;
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch {
      fromFile = null;
    }
  }
  const fromEnv = process.env.ONEDRIVE_REFRESH_TOKEN
    ? {
        refreshToken: process.env.ONEDRIVE_REFRESH_TOKEN,
        accessToken: process.env.ONEDRIVE_ACCESS_TOKEN || null,
        obtainedAt: null,
      }
    : null;
  if (fromFile?.refreshToken) {
    return {
      accessToken: fromFile.accessToken || fromEnv?.accessToken || null,
      refreshToken: fromFile.refreshToken,
      obtainedAt: fromFile.obtainedAt || null,
    };
  }
  return fromEnv;
}

export async function saveOneDriveTokens({ accessToken, refreshToken }) {
  const payload = {
    accessToken: accessToken || null,
    refreshToken: refreshToken || loadOneDriveTokens()?.refreshToken || null,
    obtainedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2));
  if (accessToken) process.env.ONEDRIVE_ACCESS_TOKEN = String(accessToken);
  if (payload.refreshToken) {
    payload.durableSync = await persistEnvVars(
      { ONEDRIVE_REFRESH_TOKEN: payload.refreshToken },
      { onlyIfChanged: true }
    );
  }
  return payload;
}

export function oneDriveStatus() {
  const tokens = loadOneDriveTokens();
  let configured = true;
  try {
    requireConfig();
  } catch {
    configured = false;
  }
  return {
    configured,
    connected: Boolean(tokens?.refreshToken || tokens?.accessToken),
  };
}

export function buildOneDriveAuthorizeUrl() {
  const { clientId, redirectUri } = requireConfig();
  const state = crypto.randomBytes(16).toString('hex');
  pendingAuth.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeOneDriveCode(code, state, { fetchImpl = fetch } = {}) {
  if (!state || !pendingAuth.has(state)) {
    throw new Error('OneDrive sign-in expired. Open /onedrive/start again.');
  }
  pendingAuth.delete(state);
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code: String(code),
      scope: SCOPES,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'OneDrive token exchange failed');
  }
  return saveOneDriveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  });
}

async function refreshAccessToken(fetchImpl) {
  const tokens = loadOneDriveTokens();
  if (!tokens?.refreshToken) return null;
  const freshEnough =
    tokens.accessToken &&
    tokens.obtainedAt &&
    Date.now() - new Date(tokens.obtainedAt).getTime() < 45 * 60 * 1000;
  if (freshEnough) return tokens.accessToken;

  const { clientId, clientSecret, redirectUri } = requireConfig();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      scope: SCOPES,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'OneDrive refresh failed');
  }
  const saved = await saveOneDriveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
  });
  return saved.accessToken;
}

export function oneDrivePath({ jobNumber, clientName, filename }) {
  const clean = (value) =>
    String(value || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const folder = clean([jobNumber, clientName].filter(Boolean).join(' ')) || 'No job number';
  const file = clean(filename) || 'invoice.pdf';
  return `Veenstra Jobs/${folder}/Sherwin/${file}`;
}

export async function uploadOneDriveFile({ path: filePath, bytes, contentType, fetchImpl = fetch } = {}) {
  const accessToken = await refreshAccessToken(fetchImpl);
  if (!accessToken) {
    return { stored: false, reason: 'onedrive_not_connected' };
  }
  const encoded = filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const res = await fetchImpl(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encoded}:/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType || 'application/pdf',
      },
      body: bytes,
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `OneDrive upload failed (${res.status})`);
  }
  return {
    stored: true,
    driveItemId: data.id || null,
    driveUrl: data.webUrl || null,
  };
}

export async function disconnectOneDrive() {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  delete process.env.ONEDRIVE_ACCESS_TOKEN;
  delete process.env.ONEDRIVE_REFRESH_TOKEN;
  return clearEnvVars(['ONEDRIVE_REFRESH_TOKEN', 'ONEDRIVE_ACCESS_TOKEN']);
}
