import crypto from 'crypto';
import { saveTokens, loadTokens, clearTokens, getJobberAuthStatus } from './tokenStore.js';
import { newerDurableToken } from '../src/lib/durableTokens.js';

const AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

/** In-memory PKCE state for the current OAuth attempt */
const pendingAuth = new Map();

function requireConfig() {
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  const redirectUri = process.env.JOBBER_REDIRECT_URI;

  const missing = [];
  if (!clientId) missing.push('JOBBER_CLIENT_ID');
  if (!clientSecret) missing.push('JOBBER_CLIENT_SECRET');
  if (!redirectUri) missing.push('JOBBER_REDIRECT_URI');

  if (missing.length) {
    throw new Error(
      `Missing env var(s): ${missing.join(', ')}. Set them in Render → Environment, then redeploy.`
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkce() {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl() {
  const { clientId, redirectUri } = requireConfig();
  const state = base64Url(crypto.randomBytes(16));
  const { codeVerifier, codeChallenge } = createPkce();

  pendingAuth.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || res.statusText;
    const err = new Error(`Jobber token exchange failed: ${detail}`);
    err.status = res.status;
    err.code = data.error || null;
    throw err;
  }

  return data;
}

function isInvalidGrant(err) {
  return (
    err?.status === 401 ||
    err?.code === 'invalid_grant' ||
    /unauthorized|invalid_grant|invalid.?token/i.test(err?.message || '')
  );
}

export async function exchangeCodeForTokens(code, state) {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const pending = pendingAuth.get(state);

  if (!pending) {
    throw new Error('Invalid or expired OAuth state. Start again at /oauth/start');
  }

  pendingAuth.delete(state);

  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: pending.codeVerifier,
  });

  return saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  });
}

export async function refreshAccessToken() {
  const { clientId, clientSecret } = requireConfig();
  const current = loadTokens();

  if (!current?.refreshToken) {
    throw new Error('No Jobber refresh token. Visit /oauth/start to connect.');
  }

  try {
    const data = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    // Jobber rotates refresh tokens — always persist both (and durable-sync)
    return saveTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || current.refreshToken,
    });
  } catch (err) {
    if (isInvalidGrant(err)) {
      const newer = await newerDurableToken('JOBBER_REFRESH_TOKEN', current.refreshToken);
      if (newer) {
        const data = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: newer,
          client_id: clientId,
          client_secret: clientSecret,
        });
        return saveTokens({
          accessToken: data.access_token,
          refreshToken: data.refresh_token || newer,
        });
      }
      // Dead refresh token in Render env is the usual loop: health says
      // connected, every tool call returns Unauthorized until reauth.
      await clearTokens({ clearDurable: true });
      throw new Error(
        'Jobber refresh token is no longer valid (revoked, expired, or already rotated). Reconnect at /oauth/start'
      );
    }
    throw err;
  }
}

/**
 * Boot / health: prove the stored refresh token still works.
 * Clears durable dead tokens so redeploys stop reloading Unauthorized.
 */
export async function ensureJobberSession() {
  const status = getJobberAuthStatus();
  if (!status.connected) {
    return { ok: false, ...status };
  }

  const current = loadTokens();
  if (current?.accessToken && current.refreshToken) {
    // Access token presence is not proof — always refresh once on boot
    // so we detect rotated-away secrets immediately.
  }

  try {
    await refreshAccessToken();
    return { ok: true, connected: true, reason: 'refreshed', validated: true };
  } catch (err) {
    return {
      ok: false,
      connected: false,
      reason: 'token_invalid',
      validated: true,
      error: err.message,
      reconnect: '/oauth/start',
    };
  }
}

export async function probeJobberAuth() {
  return ensureJobberSession();
}
