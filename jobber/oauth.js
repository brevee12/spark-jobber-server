import crypto from 'crypto';
import { saveTokens, loadTokens } from './tokenStore.js';

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
    throw new Error(`Jobber token exchange failed: ${detail}`);
  }

  return data;
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

  const data = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  // Jobber rotates refresh tokens — always persist both
  return saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
  });
}
