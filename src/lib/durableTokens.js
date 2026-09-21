/**
 * Persist OAuth tokens across Render deploys.
 *
 * Render Free has an ephemeral filesystem, so .*-tokens.json is wiped on every
 * deploy. This module:
 *  1. Updates process.env immediately (current instance keeps working)
 *  2. Optionally PUTs values to Render's env-var API so the *next* boot survives
 *
 * Setup (one time in Render Environment):
 *   RENDER_API_KEY     = API key from https://dashboard.render.com/u/settings#api-keys
 *   RENDER_SERVICE_ID  = service id from the service URL / Settings (srv-...)
 */

export function durableSyncConfigured() {
  return Boolean(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);
}

/**
 * @param {Record<string, string|number|null|undefined>} vars
 * @returns {Promise<{ synced: boolean, updated: string[], error?: string }>}
 */
export async function persistEnvVars(vars) {
  const updated = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value == null || value === '') continue;
    process.env[key] = String(value);
    updated.push(key);
  }

  if (!durableSyncConfigured()) {
    return {
      synced: false,
      updated,
      error: 'Set RENDER_API_KEY and RENDER_SERVICE_ID to auto-save tokens across deploys',
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
        throw new Error(`Render env update failed for ${key} (${res.status}): ${body.slice(0, 200)}`);
      }
    }

    console.log(`Durable token sync OK: ${updated.join(', ')}`);
    return { synced: true, updated };
  } catch (err) {
    console.error('Durable token sync failed:', err.message);
    return { synced: false, updated, error: err.message };
  }
}
