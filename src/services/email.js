/**
 * Transactional email via Resend HTTP API.
 * Requires RESEND_API_KEY.
 * Optional: BOOKKEEPING_NOTIFY_EMAIL, RESEND_FROM / BOOKKEEPING_EMAIL_FROM.
 *
 * Bootstrap (no custom domain): send from onboarding@resend.dev to the Resend
 * account inbox (brevee12@gmail.com). Later, verify a domain and point
 * BOOKKEEPING_NOTIFY_EMAIL / RESEND_FROM at @veenstrapainting.com.
 */

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function defaultNotifyEmail() {
  return (
    process.env.BOOKKEEPING_NOTIFY_EMAIL?.trim() ||
    'brevee12@gmail.com'
  );
}

export function defaultFromAddress() {
  return (
    process.env.RESEND_FROM?.trim() ||
    process.env.BOOKKEEPING_EMAIL_FROM?.trim() ||
    'Veenstra Bookkeeping <onboarding@resend.dev>'
  );
}

/**
 * @param {{ to?: string|string[], subject: string, text: string, html?: string }} opts
 */
export async function sendEmail({ to, subject, text, html } = {}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not set. Add it on Render (and locally) to send bookkeeping emails.'
    );
  }

  const recipients = Array.isArray(to)
    ? to.filter(Boolean)
    : [to || defaultNotifyEmail()].filter(Boolean);

  if (!recipients.length) {
    throw new Error('No email recipient (set BOOKKEEPING_NOTIFY_EMAIL)');
  }
  if (!subject) throw new Error('subject is required');
  if (!text && !html) throw new Error('text or html is required');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: defaultFromAddress(),
      to: recipients,
      subject: String(subject),
      text: text || undefined,
      html: html || undefined,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Resend error (${res.status}): ${body.message || JSON.stringify(body)}`
    );
  }

  return {
    id: body.id || null,
    to: recipients,
    subject,
  };
}
