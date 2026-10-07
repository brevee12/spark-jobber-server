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

  return txs.map((tx, i) => ({
    n: i + 1,
    tx,
    accountName: accountNameOf(tx),
    label: lineLabelInAccount(tx),
    category: tx.suggestedCategory || null,
    treatment: shortTreatment(tx),
    doNotPostViaApi: Boolean(tx.doNotPostViaApi),
    qboWriteTool: tx.qboWriteTool || null,
  }));
}

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

function formatItemText(item) {
  const flags = [];
  if (item.doNotPostViaApi) flags.push('feed-only');
  if (item.qboWriteTool) flags.push(item.qboWriteTool);
  const lines = [`${item.n}. ${item.label}`];
  if (item.category) lines.push(`   Category: ${item.category}`);
  if (item.treatment) lines.push(`   ${item.treatment}`);
  if (flags.length) lines.push(`   [${flags.join(' · ')}]`);
  return lines;
}

function formatItemHtml(item) {
  const meta = [];
  if (item.category) meta.push(`<strong>${esc(item.category)}</strong>`);
  if (item.doNotPostViaApi) meta.push('feed-only');
  if (item.qboWriteTool) meta.push(esc(item.qboWriteTool));
  return `<li value="${item.n}"><code>${esc(item.label)}</code>${
    meta.length ? `<br/><span style="color:#444">${meta.join(' · ')}</span>` : ''
  }${
    item.treatment
      ? `<br/><span style="color:#555">${esc(item.treatment)}</span>`
      : ''
  }</li>`;
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
  const day = generatedAt.slice(0, 10);
  const cashLines = formatCashLines(review.qbo?.cashBalances);
  const errors = Array.isArray(review.errors) ? review.errors : [];
  const sherwinCount = review.qbo?.sherwinBills?.count;

  const subject =
    items.length === 0
      ? `Bookkeeping brief ${day} — no new bank lines`
      : `Bookkeeping brief ${day} — ${items.length} staged line${items.length === 1 ? '' : 's'} (${groups.length} account${groups.length === 1 ? '' : 's'})`;

  const textParts = [];
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
  if (!items.length) {
    textParts.push('  No new bank transactions to stage.');
  } else {
    for (const group of groups) {
      textParts.push('');
      textParts.push(`### ${group.accountName} (${group.items.length})`);
      for (const item of group.items) {
        textParts.push(...formatItemText(item));
      }
    }
    if (truncated > 0) {
      textParts.push('');
      textParts.push(`  … +${truncated} more not shown (raise maxItems)`);
    }
  }
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
        const lis = group.items.map(formatItemHtml).join('');
        return `<h3 style="font-size:1rem;margin:1.25rem 0 .4rem">${esc(group.accountName)} <span style="color:#666;font-weight:normal">(${group.items.length})</span></h3><ol>${lis}</ol>`;
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
<html><body style="font-family:system-ui,sans-serif;line-height:1.45;color:#111;max-width:42rem">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">Veenstra Painting — bookkeeping brief</h1>
<p style="margin:0 0 1rem;color:#555">Generated ${esc(generatedAt)}</p>
<h2 style="font-size:1.05rem">§1 Cash snapshot</h2>
${cashHtml}
${sherwinCount != null ? `<p>Sherwin bills (open sample): ${sherwinCount}</p>` : ''}
<h2 style="font-size:1.05rem">§2 Bank staging by account</h2>
<p style="color:#444">Reply in Cursor with <code>approve N</code> / <code>skip N</code> (numbers are global across accounts).</p>
${filterHtml}
${itemsHtml}
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
  };
}
