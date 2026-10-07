/**
 * Stage-only bookkeeping review → email brief (Resend).
 * Health-gated: will not send if SimpleFIN/QBO prerequisites fail.
 */

import { hasQboTokens, getQboAuthStatus, ensureQboSession } from './qbo.js';
import { hasSimpleFinAccess } from './simplefin.js';
import {
  emailConfigured,
  defaultNotifyEmail,
  sendEmail,
} from './email.js';
import { formatBookkeepingBrief } from './bookkeepingBrief.js';

/**
 * @param {{ requireBank?: boolean, requireQbo?: boolean, probeQbo?: boolean }} [opts]
 */
export async function checkBookkeepingNotifyHealth(opts = {}) {
  const requireBank = opts.requireBank !== false;
  const requireQbo = opts.requireQbo !== false;
  const probeQbo = Boolean(opts.probeQbo);

  const issues = [];
  const simplefinOk = hasSimpleFinAccess();
  if (requireBank && !simplefinOk) {
    issues.push('SimpleFIN not configured (SIMPLEFIN_ACCESS_URL / claim)');
  }

  let qboOk = hasQboTokens();
  if (requireQbo && probeQbo && qboOk) {
    try {
      const session = await ensureQboSession();
      qboOk = Boolean(session?.ok ?? hasQboTokens());
    } catch (err) {
      qboOk = false;
      issues.push(`QBO session failed: ${err.message}`);
    }
  }
  if (requireQbo && !qboOk) {
    const status = getQboAuthStatus();
    if (!issues.some((i) => i.startsWith('QBO'))) {
      issues.push(
        `QBO not connected${status?.reason ? ` (${status.reason})` : ''}`
      );
    }
  }

  if (!emailConfigured()) {
    issues.push('RESEND_API_KEY not set');
  }

  return {
    ok: issues.length === 0,
    issues,
    simplefinConfigured: simplefinOk,
    qboConnected: hasQboTokens(),
    emailConfigured: emailConfigured(),
  };
}

function reviewUnusable(review, { wantBank, wantCash }) {
  const errors = review.errors || [];
  const bankFailed =
    wantBank &&
    errors.some((e) => e.section === 'bankFeed') &&
    !review.bankFeed;
  const cashFailed =
    wantCash &&
    errors.some((e) => e.section === 'qbo.cashBalances') &&
    !review.qbo?.cashBalances;

  // Block when every requested core section failed (no useful email body).
  if (wantBank && wantCash) return bankFailed && cashFailed;
  if (wantBank) return bankFailed;
  if (wantCash) return cashFailed;
  return false;
}

/**
 * Run stage-only review, format brief, email Brennan (or opts.to).
 *
 * @param {object} args
 * @param {Function} args.runReview — async (reviewArgs) => review object
 * @param {string} [args.to]
 * @param {string} [args.agentUrl]
 * @param {boolean} [args.dryRun] — format only, do not send
 * @param {boolean} [args.skipHealthGate]
 * @param {boolean} [args.probeQbo]
 * @param {number} [args.maxItems]
 * @param {object} [args.reviewArgs] — forwarded to bookkeeping review (stage defaults applied)
 */
export async function runBookkeepingNotify(args = {}) {
  const {
    runReview,
    to = defaultNotifyEmail(),
    agentUrl,
    dryRun = false,
    skipHealthGate = false,
    probeQbo = false,
    maxItems,
    reviewArgs = {},
  } = args;

  if (typeof runReview !== 'function') {
    throw new Error('runBookkeepingNotify requires runReview()');
  }

  const wantBank = reviewArgs.includeBankFeed !== false;
  const wantCash = reviewArgs.includeCashBalances !== false;

  const health = skipHealthGate
    ? { ok: true, issues: [], skipped: true }
    : await checkBookkeepingNotifyHealth({
        requireBank: wantBank,
        requireQbo: wantCash,
        probeQbo,
      });

  // dryRun may preview without Resend; still require data sources.
  const blockingIssues = dryRun
    ? health.issues.filter((i) => !i.includes('RESEND_API_KEY'))
    : health.issues;

  if (blockingIssues.length) {
    return {
      ok: false,
      sent: false,
      blocked: true,
      reason: 'health_gate',
      issues: blockingIssues,
      health,
    };
  }

  // Stage-only defaults: read bank + cash; never markSeen; no QBO writes.
  const review = await runReview({
    includeBankFeed: true,
    includeCashBalances: true,
    includeSherwinBills: true,
    includeAccounts: false,
    includeProfitAndLoss: false,
    includeProcessed: false,
    ...reviewArgs,
    markSeen: false,
  });

  if (reviewUnusable(review, { wantBank, wantCash })) {
    return {
      ok: false,
      sent: false,
      blocked: true,
      reason: 'review_failed',
      issues: (review.errors || []).map((e) => `${e.section}: ${e.error}`),
      review,
      health,
    };
  }

  const brief = formatBookkeepingBrief(review, { agentUrl, maxItems });

  if (dryRun) {
    return {
      ok: true,
      sent: false,
      dryRun: true,
      to,
      brief: {
        subject: brief.subject,
        text: brief.text,
        html: brief.html,
        itemCount: brief.itemCount,
        agentUrl: brief.agentUrl,
      },
      health,
      reviewErrors: review.errors || [],
    };
  }

  if (!emailConfigured()) {
    return {
      ok: false,
      sent: false,
      blocked: true,
      reason: 'missing_resend_api_key',
      issues: ['RESEND_API_KEY not set'],
      brief: {
        subject: brief.subject,
        text: brief.text,
        itemCount: brief.itemCount,
      },
      health,
    };
  }

  const sent = await sendEmail({
    to,
    subject: brief.subject,
    text: brief.text,
    html: brief.html,
  });

  return {
    ok: true,
    sent: true,
    email: sent,
    to: sent.to,
    brief: {
      subject: brief.subject,
      itemCount: brief.itemCount,
      agentUrl: brief.agentUrl,
      textPreview: brief.text.slice(0, 500),
    },
    health,
    reviewErrors: review.errors || [],
  };
}
