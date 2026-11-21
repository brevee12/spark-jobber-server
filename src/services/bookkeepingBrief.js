/**
 * Dense numbered bookkeeping brief (HTML + plain text) for email.
 * §1 cash · §2 bank staging by account (approve-by-number) · §3 notes + Cursor link.
 */

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(0, 10);
}

/** Calendar date in America/Chicago (the books' zone), YYYY-MM-DD. */
export function chicagoDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function calendarDaysBetween(earlier, later) {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * How far the open bank lines lag today.
 * Days are Chicago calendar days from the oldest staged line to the brief date.
 * No open lines means the books are current. A missing feed is unknown, not current.
 */
export function booksBehind(review = {}, opts = {}) {
  const today = chicagoDate(opts.asOf || review.generatedAt || new Date().toISOString());
  const bankError = (review.errors || []).some((e) => e.section === 'bankFeed' && !review.bankFeed);
  if (!review.bankFeed || bankError) {
    return { days: null, today, oldest: null, label: 'days behind unknown' };
  }
  const dates = (review.bankFeed.transactions || [])
    .map((tx) => fmtDate(tx.date))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!dates.length) {
    return { days: 0, today, oldest: null, label: 'current' };
  }
  const oldest = dates.reduce((a, b) => (a < b ? a : b));
  const days = Math.max(0, calendarDaysBetween(oldest, today) ?? 0);
  const label = days === 0 ? 'current' : days === 1 ? '1 day behind' : `${days} days behind`;
  return { days, today, oldest, label };
}

function behindLead(behind) {
  if (behind.days == null) return 'Days behind unknown — the bank feed did not load.';
  if (behind.oldest) {
    return `${behind.label} — oldest open line ${behind.oldest}.`;
  }
  return 'Current — no open bank lines.';
}

function shortTreatment(tx) {
  const t = String(tx.treatment || '').trim();
  if (!t) return '';
  const first = t.split(/(?<=\.)\s+/)[0] || t;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** Line under an account subsection — account name omitted (it's the header). */
function lineLabelInAccount(tx) {
  const parts = [
    fmtDate(tx.date),
    money(tx.amountSigned ?? tx.amount),
    String(tx.description || '').trim() || '(no description)',
  ];
  return parts.join(' · ');
}

function accountNameOf(tx) {
  return String(tx.accountName || tx.accountId || 'Unknown account').trim();
}

/** Stable section order: checking → CC → LOC/loan → other. */
function accountSortKey(name = '') {
  const n = String(name).toLowerCase();
  if (/checking|ez\s*bus|\boperat/.test(n)) return `1:${n}`;
  if (/spark|capital\s*one|credit\s*card|\bcc\b/.test(n)) return `2:${n}`;
  if (/loan|loc|n\/p|line of credit|0549/.test(n)) return `3:${n}`;
  return `4:${n}`;
}

function agentUrlFromEnv() {
  return (
    process.env.CURSOR_AGENT_URL?.trim() ||
    process.env.BOOKKEEPING_CURSOR_AGENT_URL?.trim() ||
    ''
  );
}

/**
 * Build approve-list items from a bookkeeping_review result.
 * Sorted by account subsection, then date desc; numbers are global 1..n.
 */
export function listStagingItems(review = {}) {
  const txs = [...(review?.bankFeed?.transactions || [])];
  txs.sort((a, b) => {
    const ak = accountSortKey(accountNameOf(a));
    const bk = accountSortKey(accountNameOf(b));
    if (ak !== bk) return ak < bk ? -1 : 1;
    return (b.posted || 0) - (a.posted || 0) || String(b.date).localeCompare(String(a.date));
  });

  const numberById = new Map(txs.map((tx, i) => [tx.id, i + 1]));
  return txs.map((tx, i) => {
    const pairN = tx.pairedTxId ? numberById.get(tx.pairedTxId) : null;
    const base = tx.suggestedCategory || null;
    return {
      n: i + 1,
      tx,
      accountName: accountNameOf(tx),
      label: lineLabelInAccount(tx),
      category: base && pairN ? `${base} (same transfer as #${pairN})` : base,
      qboAccount: tx.suggestedQboAccount || null,
      suggestionSource: tx.suggestionSource || null,
      treatment: shortTreatment(tx),
      doNotPostViaApi: Boolean(tx.doNotPostViaApi),
      qboWriteTool: tx.qboWriteTool || null,
    };
  });
}

const CATEGORY_LEGEND =
  'Suggested category = an existing QBO account (from your COA / past payee history). "Match:" = match to an existing QBO record in Banking, don\'t categorize. "Needs your pick" = no confident QBO account; tell me which one.';

/** Group numbered items into account subsections (order preserved). */
export function groupItemsByAccount(items = []) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const name = item.accountName || 'Unknown account';
    if (!index.has(name)) {
      const g = { accountName: name, items: [] };
      index.set(name, g);
      groups.push(g);
    }
    index.get(name).items.push(item);
  }
  return groups;
}

function formatCashLines(cash) {
  if (!cash) return [];
  const lines = [];
  for (const row of cash.checking || []) {
    lines.push(`Checking · ${row.name}: ${money(row.balance)}`);
  }
  for (const row of cash.lineOfCredit || []) {
    lines.push(`LOC · ${row.name}: ${money(row.balance)}`);
  }
  for (const row of cash.creditCards || []) {
    lines.push(`CC · ${row.name}: ${money(row.balance)}`);
  }
  return lines;
}

function itemAmount(item) {
  return money(item.tx?.amountSigned ?? item.tx?.amount);
}

function itemDescription(item) {
  return String(item.tx?.description || '').trim() || '(no description)';
}

function itemDate(item) {
  return fmtDate(item.tx?.date);
}

function itemCategory(item) {
  return item.category || '(review)';
}

/** Plain-text table for one account subsection (# = global approve number). */
function formatAccountTableText(items) {
  const rows = items.map((item) => ({
    n: String(item.n),
    date: itemDate(item),
    desc: itemDescription(item),
    amt: itemAmount(item),
    cat: itemCategory(item),
  }));
  const cols = [
    { key: 'n', title: '#', w: 4 },
    { key: 'date', title: 'Date', w: 10 },
    { key: 'desc', title: 'Description', w: 36 },
    { key: 'amt', title: 'Amount', w: 12 },
    { key: 'cat', title: 'Suggested category', w: 48 },
  ];
  const pad = (s, w) => {
    const str = String(s);
    return str.length > w ? `${str.slice(0, w - 1)}…` : str.padEnd(w);
  };
  const lines = [];
  lines.push(cols.map((c) => pad(c.title, c.w)).join('  '));
  lines.push(cols.map((c) => '-'.repeat(Math.min(c.w, 40))).join('  '));
  for (const row of rows) {
    lines.push(cols.map((c) => pad(row[c.key], c.w)).join('  '));
  }
  return lines;
}

function formatAccountTableHtml(items) {
  const body = items
    .map(
      (item) =>
        `<tr>` +
        `<td style="padding:4px 8px;border:1px solid #ddd;text-align:right;color:#666">${item.n}</td>` +
        `<td style="padding:4px 8px;border:1px solid #ddd;white-space:nowrap">${esc(itemDate(item))}</td>` +
        `<td style="padding:4px 8px;border:1px solid #ddd">${esc(itemDescription(item))}</td>` +
        `<td style="padding:4px 8px;border:1px solid #ddd;white-space:nowrap;text-align:right">${esc(itemAmount(item))}</td>` +
        `<td style="padding:4px 8px;border:1px solid #ddd">${esc(itemCategory(item))}</td>` +
        `</tr>`
    )
    .join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:.9rem;margin:0 0 .75rem">
<thead><tr>
<th style="padding:4px 8px;border:1px solid #ddd;text-align:right;background:#f5f5f5">#</th>
<th style="padding:4px 8px;border:1px solid #ddd;text-align:left;background:#f5f5f5">Date</th>
<th style="padding:4px 8px;border:1px solid #ddd;text-align:left;background:#f5f5f5">Description</th>
<th style="padding:4px 8px;border:1px solid #ddd;text-align:right;background:#f5f5f5">Amount</th>
<th style="padding:4px 8px;border:1px solid #ddd;text-align:left;background:#f5f5f5">Suggested category</th>
</tr></thead>
<tbody>${body}</tbody>
</table>`;
}

/**
 * @param {object} review — output of runBookkeepingReview
 * @param {{ agentUrl?: string, maxItems?: number }} [opts]
 */
export function formatBookkeepingBrief(review = {}, opts = {}) {
  const agentUrl = opts.agentUrl ?? agentUrlFromEnv();
  const maxItems = opts.maxItems ?? 80;
  const allItems = listStagingItems(review);
  const items = allItems.slice(0, maxItems);
  const truncated = allItems.length - items.length;
  const groups = groupItemsByAccount(items);
  const generatedAt = review.generatedAt || new Date().toISOString();
  const behind = booksBehind(review, { asOf: generatedAt });
  const day = behind.today || generatedAt.slice(0, 10);
  const cashLines = formatCashLines(review.qbo?.cashBalances);
  const errors = Array.isArray(review.errors) ? review.errors : [];
  const sherwinCount = review.qbo?.sherwinBills?.count;
  const countLabel =
    items.length === 0
      ? 'no new bank lines'
      : `${items.length} staged line${items.length === 1 ? '' : 's'} (${groups.length} account${groups.length === 1 ? '' : 's'})`;

  const subject = `Bookkeeping brief ${day} — ${behind.label} — ${countLabel}`;

  const textParts = [];
  textParts.push(behindLead(behind));
  textParts.push(`Veenstra Painting — bookkeeping brief`);
  textParts.push(`Generated: ${generatedAt}`);
  textParts.push('');
  textParts.push('§1 Cash snapshot');
  if (cashLines.length) {
    textParts.push(...cashLines.map((l) => `  ${l}`));
  } else {
    textParts.push('  (cash balances unavailable)');
  }
  if (sherwinCount != null) {
    textParts.push(`  Sherwin bills (open sample): ${sherwinCount}`);
  }
  textParts.push('');
  textParts.push('§2 Bank staging by account — reply in Cursor with approve N / skip N');
  const qboMatch = review?.bankFeed?.qboMatch;
  if (qboMatch && qboMatch.simplefinTotal != null) {
    textParts.push(
      `  Filter: ${qboMatch.outstanding} outstanding of ${qboMatch.simplefinTotal} SimpleFIN rows ` +
        `(${qboMatch.alreadyInQbo} already booked in QBO).`
    );
  }
  const byAccount = qboMatch?.byAccount || {};
  if (!items.length) {
    textParts.push('  No new bank transactions to stage.');
  } else {
    for (const group of groups) {
      const stats = byAccount[group.accountName];
      const headerStats = stats
        ? `${stats.need} need · ${stats.matched} matched in QBO · ${stats.feed} in feed`
        : `${group.items.length} need`;
      textParts.push('');
      textParts.push(`### ${group.accountName}`);
      textParts.push(`  (${headerStats})`);
      textParts.push(...formatAccountTableText(group.items));
    }
    if (truncated > 0) {
      textParts.push('');
      textParts.push(`  … +${truncated} more not shown (raise maxItems)`);
    }
  }
  textParts.push('');
  textParts.push(`  ${CATEGORY_LEGEND}`);
  textParts.push('');
  textParts.push('§3 How to approve');
  textParts.push(
    '  Open the Cursor agent link and reply with numbers, e.g. "approve 1,3" or "skip 2".'
  );
  textParts.push(
    '  Numbers are global across accounts. Stage-only: nothing posts to QuickBooks until you approve writes in chat.'
  );
  if (agentUrl) {
    textParts.push(`  Cursor: ${agentUrl}`);
  } else {
    textParts.push(
      '  Cursor: (set CURSOR_AGENT_URL on the server / automation to include a direct link)'
    );
  }
  if (review.bankFeed?.policy?.creditCardCredits) {
    textParts.push(`  Policy: ${review.bankFeed.policy.creditCardCredits}`);
  }
  if (errors.length) {
    textParts.push('');
    textParts.push('Warnings:');
    for (const e of errors) {
      textParts.push(`  - ${e.section}: ${e.error}`);
    }
  }

  const text = textParts.join('\n');

  const cashHtml = cashLines.length
    ? `<ul>${cashLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p><em>(cash balances unavailable)</em></p>';

  let itemsHtml;
  if (!items.length) {
    itemsHtml = '<p>No new bank transactions to stage.</p>';
  } else {
    const sections = groups
      .map((group) => {
        const stats = byAccount[group.accountName];
        const headerStats = stats
          ? `${stats.need} need · ${stats.matched} matched in QBO · ${stats.feed} in feed`
          : `${group.items.length} need`;
        const table = formatAccountTableHtml(group.items);
        return `<h3 style="font-size:1rem;margin:1.25rem 0 .25rem">${esc(group.accountName)}</h3><p style="margin:0 0 .4rem;color:#666;font-size:.9rem">${esc(headerStats)}</p>${table}`;
      })
      .join('');
    itemsHtml = `${sections}${
      truncated > 0 ? `<p><em>… +${truncated} more not shown</em></p>` : ''
    }`;
  }

  const filterHtml =
    qboMatch && qboMatch.simplefinTotal != null
      ? `<p style="color:#444">Filter: ${qboMatch.outstanding} outstanding of ${qboMatch.simplefinTotal} SimpleFIN rows (${qboMatch.alreadyInQbo} already booked in QBO).</p>`
      : '';

  const agentHtml = agentUrl
    ? `<p><a href="${esc(agentUrl)}">Open Cursor agent to approve by number</a></p>`
    : '<p><em>Set CURSOR_AGENT_URL to include a direct Cursor link.</em></p>';

  const warnHtml = errors.length
    ? `<h3>Warnings</h3><ul>${errors
        .map((e) => `<li>${esc(e.section)}: ${esc(e.error)}</li>`)
        .join('')}</ul>`
    : '';

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.45;color:#111;max-width:52rem">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">Veenstra Painting — bookkeeping brief</h1>
<p style="margin:0 0 .35rem;font-size:1.05rem"><strong>${esc(behindLead(behind))}</strong></p>
<p style="margin:0 0 1rem;color:#555">Generated ${esc(generatedAt)}</p>
<h2 style="font-size:1.05rem">§1 Cash snapshot</h2>
${cashHtml}
${sherwinCount != null ? `<p>Sherwin bills (open sample): ${sherwinCount}</p>` : ''}
<h2 style="font-size:1.05rem">§2 Bank staging by account</h2>
<p style="color:#444">Reply in Cursor with <code>approve N</code> / <code>skip N</code> using the <strong>#</strong> column (global across accounts).</p>
${filterHtml}
${itemsHtml}
<p style="font-size:.9rem;color:#444">${esc(CATEGORY_LEGEND)}</p>
<h2 style="font-size:1.05rem">§3 How to approve</h2>
<p>Stage-only run — nothing posts to QuickBooks until you approve writes in chat.</p>
${agentHtml}
${
  review.bankFeed?.policy?.creditCardCredits
    ? `<p style="font-size:.9rem;color:#444">${esc(review.bankFeed.policy.creditCardCredits)}</p>`
    : ''
}
${warnHtml}
</body></html>`;

  return {
    subject,
    text,
    html,
    itemCount: allItems.length,
    items,
    groups,
    agentUrl: agentUrl || null,
    generatedAt,
    behind,
  };
}
