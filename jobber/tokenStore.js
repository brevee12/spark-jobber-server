import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { persistEnvVars } from '../src/lib/durableTokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '.jobber-tokens.json');

export function loadTokens() {
  if (process.env.JOBBER_ACCESS_TOKEN) {
    return {
      accessToken: process.env.JOBBER_ACCESS_TOKEN,
      refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
      obtainedAt: null,
    };
  }

  if (!fs.existsSync(TOKEN_PATH)) return null;

  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveTokens({ accessToken, refreshToken }) {
  const payload = {
    accessToken,
    refreshToken,
    obtainedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2), 'utf8');

  const sync = await persistEnvVars({
    JOBBER_ACCESS_TOKEN: accessToken,
    JOBBER_REFRESH_TOKEN: refreshToken,
  });
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
  return Boolean(tokens?.accessToken);
}
