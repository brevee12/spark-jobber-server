/**
 * Inbound mail via Resend Receiving.
 * Gmail forwards veenstrapainting@gmail.com to the Resend address
 * (paint@….resend.app). Listing is team-wide; this client does not send mail.
 */

const RESEND_API = 'https://api.resend.com';

function resendHeaders() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not set. Sherwin invoice emails are received in Resend.'
    );
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'veenstra-bookkeeping/1.0',
  };
}

async function resendGet(path, fetchImpl) {
  const res = await fetchImpl(`${RESEND_API}${path}`, { headers: resendHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.message || body.name || body.detail || 'request failed';
    throw new Error(`Resend error (${res.status}): ${message}`);
  }
  return body;
}

export async function listReceivedEmails({ limit = 30, fetchImpl = fetch } = {}) {
  const emails = [];
  let after = null;
  while (emails.length < limit) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(100, limit - emails.length)));
    if (after) params.set('after', after);
    const page = await resendGet(`/emails/receiving?${params}`, fetchImpl);
    const data = page.data || [];
    emails.push(...data);
    if (!page.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return emails.slice(0, limit);
}

export async function getReceivedEmail(id, { fetchImpl = fetch } = {}) {
  return resendGet(`/emails/receiving/${encodeURIComponent(id)}`, fetchImpl);
}

export async function listReceivedAttachments(id, { fetchImpl = fetch } = {}) {
  const page = await resendGet(
    `/emails/receiving/${encodeURIComponent(id)}/attachments`,
    fetchImpl
  );
  return page.data || [];
}

/** Signed CDN URL. Do not send the Resend API key. */
export async function downloadAttachment(attachment, fetchImpl = fetch) {
  const url = attachment?.download_url;
  if (!url) throw new Error('attachment has no download url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('attachment download url is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('attachment download url must be https');
  }
  const res = await fetchImpl(parsed.toString());
  if (!res.ok) {
    throw new Error(`attachment download failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}
