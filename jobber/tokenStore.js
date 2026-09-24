import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { persistEnvVars } from '../src/lib/durableTokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '.jobber-tokens.json');

/**
 * Prefer freshest tokens between ephemeral file and env.
 * Access tokens stay instance-local; only the refresh token is durable on Render.
 */
export function loadTokens() {
  let fromFile = null;
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch {
      fromFile = null;
    }
  }

  const fromEnv = process.env.JOBBER_REFRESH_TOKEN || process.env.JOBBER_ACCESS_TOKEN
    ? {
        accessToken: process.env.JOBBER_ACCESS_TOKEN || null,
        refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
        obtainedAt: null,
      }
    : null;

  if (!fromFile && !fromEnv) return null;

  if (fromFile && fromEnv) {
    // Prefer file after an in-process refresh (newer obtainedAt)
    if (fromFile.refreshToken && fromFile.obtainedAt) {
      return {
        accessToken: fromFile.accessToken || fromEnv.accessToken,
        refreshToken: fromFile.refreshToken,
        obtainedAt: fromFile.obtainedAt,
      };
    }
    return {
      accessToken: fromEnv.accessToken || fromFile.accessToken,
      refreshToken: fromEnv.refreshToken || fromFile.refreshToken,
      obtainedAt: fromFile.obtainedAt || null,
    };
  }

  return fromFile || fromEnv;
}

export async function saveTokens({ accessToken, refreshToken }) {
  const payload = {
    accessToken,
    refreshToken,
    obtainedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2), 'utf8');

  // Instance-local access token only — syncing it to Render causes redeploys
  if (accessToken) process.env.JOBBER_ACCESS_TOKEN = String(accessToken);

  const sync = await persistEnvVars(
    { JOBBER_REFRESH_TOKEN: refreshToken },
    { onlyIfChanged: true }
  );
  payload.durableSync = sync;

  return payload;
}

export function clearTokens() {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  delete process.env.JOBBER_ACCESS_TOKEN;
  delete process.env.JOBBER_REFRESH_TOKEN;
}

export function hasTokens() {
  const tokens = loadTokens();
  return Boolean(tokens?.refreshToken || tokens?.accessToken);
}
