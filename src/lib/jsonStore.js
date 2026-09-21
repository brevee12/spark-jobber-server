import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../..');

/**
 * Tiny JSON file store for tokens / processed IDs.
 * Prefer env vars on Render (ephemeral disk).
 */
export function readJson(filename, fallback = null) {
  const full = path.join(DATA_DIR, filename);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filename, data) {
  const full = path.join(DATA_DIR, filename);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function deleteJson(filename) {
  const full = path.join(DATA_DIR, filename);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}
