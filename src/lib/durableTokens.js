/**
 * Persist long-lived OAuth secrets across Render deploys.
 *
 * Render Free has an ephemeral filesystem, so .*-tokens.json is wiped on every
 * deploy. This module:
 *  1. Updates process.env immediately (current instance keeps working)
 *  2. Optionally PUTs values to Render's env-var API so the *next* boot survives
 *
 * IMPORTANT: Updating Render env vars triggers a redeploy. Only sync long-lived
 * secrets (refresh tokens / realm ids), and only when the value actually changes.
 * Never sync short-lived access tokens on every refresh — that causes hourly
 * redeploys and races Intuit/Jobber refresh-token rotation.
 *
 * Setup (one time in Render Environment):
 *   RENDER_API_KEY     = API key from https://dashboard.render.com/u/settings#api-keys
 *   RENDER_SERVICE_ID  = service id from the service URL / Settings (srv-...)
 */

/** @type {Record<string, string>} */
const lastSyncedValues = {};

export function durableSyncConfigured() {
  return Boolean(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);
}

/**
 * @param {Record<string, string|number|null|undefined>} vars
 * @param {{ onlyIfChanged?: boolean }} [options]
 * @returns {Promise<{ synced: boolean, updated: string[], skipped: string[], error?: string }>}
 */
export async function persistEnvVars(vars, { onlyIfChanged = true } = {}) {
  const updated = [];
  const skipped = [];

  for (const [key, value] of Object.entries(vars)) {
    if (value == null || value === '') continue;
    const next = String(value);
    const prev =
      lastSyncedValues[key] !== undefined
        ? lastSyncedValues[key]
        : process.env[key] != null
          ? String(process.env[key])
          : undefined;

    process.env[key] = next;

    if (onlyIfChanged && prev === next) {
      skipped.push(key);
      continue;
    }

    updated.push(key);
  }

  if (!updated.length) {
    return { synced: true, updated: [], skipped };
  }

  if (!durableSyncConfigured()) {
    // Still stamped so later identical writes skip the Render API once configured
    for (const key of updated) lastSyncedValues[key] = process.env[key];
    return {
      synced: false,
      updated,
      skipped,
      error:
        'Set RENDER_API_KEY and RENDER_SERVICE_ID to auto-save tokens across deploys',
    };
  }

  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;

  try {
    for (const key of updated) {
      const res = await fetch(
        `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ value: process.env[key] }),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Render env update failed for ${key} (${res.status}): ${body.slice(0, 200)}`
        );
      }

      lastSyncedValues[key] = process.env[key];
    }

    console.log(`Durable token sync OK: ${updated.join(', ')}`);
    return { synced: true, updated, skipped };
  } catch (err) {
    console.error('Durable token sync failed:', err.message);
    return { synced: false, updated, skipped, error: err.message };
  }
}
