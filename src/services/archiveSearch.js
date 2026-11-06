/**
 * Plain-language questions over the job archive.
 * A model may interpret the wording when a key is set. The answer is always
 * the rows that matched. A misspelled product is matched to a real name on file.
 * Nothing is invented when the file has no row.
 */

import { findJobsInRange, findLines, vocabulary } from './jobArchive.js';

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const STOP = new Set(`a an and any at bought buy color colours did do does for from
  have how in invoice invoices job jobs last latest me most of on or our paint
  please product products show that the this time to use used using was we were
  what when where which with year years bought purchase purchased sherwin
  bill bills much many`.split(/\s+/));

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDay(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addMonths(year, month, count) {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Most recent March that has already started, or the previous one when the phrase says "last" during that month. */
export function monthRange(monthName, { today, last = false } = {}) {
  const month = MONTHS[String(monthName || '').toLowerCase()];
  if (!month) return null;
  const current = today instanceof Date ? today : new Date();
  const yearNow = current.getFullYear();
  const monthNow = current.getMonth() + 1;
  let year = month < monthNow || (month === monthNow && !last) ? yearNow : yearNow - 1;
  if (last && month === monthNow) year = yearNow - 1;
  const end = addMonths(year, month, 1);
  return { from: isoDay(year, month, 1), to: isoDay(end.year, end.month, 1), label: `${monthName} ${year}` };
}

function yearRange(year) {
  const y = Number(year);
  if (!y) return null;
  return { from: `${y}-01-01`, to: `${y + 1}-01-01`, label: String(y) };
}

function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  const rows = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

function similarity(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length >= 4 && (right.includes(left) || left.includes(right))) return 0.92;
  const dist = levenshtein(left, right);
  if (dist <= 2 && Math.min(left.length, right.length) >= 6) return 0.86;
  return 1 - dist / Math.max(left.length, right.length);
}

export function bestKnownName(text, names = []) {
  const hay = String(text || '').toLowerCase();
  const words = hay.split(/\s+/).filter(Boolean);
  const pieces = [];
  for (let size = 1; size <= Math.min(4, words.length); size += 1) {
    for (let i = 0; i <= words.length - size; i += 1) {
      pieces.push(words.slice(i, i + size).join(' '));
    }
  }
  let best = null;
  for (const name of names) {
    const value = String(name || '').trim();
    if (value.length < 3) continue;
    const folded = value.toLowerCase();
    const words = folded.split(/\s+/).filter((word) => word.length >= 4);
    let score = hay.includes(folded) ? 0.97 : 0;
    for (const piece of pieces) {
      score = Math.max(score, similarity(piece, folded));
      for (const word of words) score = Math.max(score, similarity(piece, word));
    }
    if (!best || score > best.score) best = { name: value, score };
  }
  if (!best || best.score < 0.8) return null;
  return best.name;
}

function unusedWords(question, used = []) {
  const skip = new Set(used.join(' ').toLowerCase().split(/\s+/));
  return String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s#-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP.has(word) && !MONTHS[word] && !/^\d{4}$/.test(word) && !skip.has(word));
}

/**
 * Turn a question into a search. `today` decides which March "last March" means.
 * vocabulary is the real products, colors, and customers on file.
 */
export function interpretQuestion(question, vocabulary = {}, { today = new Date() } = {}) {
  const text = String(question || '').trim();
  const lower = text.toLowerCase();
  const jobNumber = lower.match(/\b(\d{4,6})\b/)?.[1] || null;
  const explicitYear = lower.match(/\b(20\d{2})\b/)?.[1] || null;
  const monthName = Object.keys(MONTHS).find((name) => new RegExp(`\\b${name}\\b`).test(lower));
  const saysLast = /\blast\b/.test(lower);
  let range = null;
  if (monthName && explicitYear) {
    range = {
      ...monthRange(monthName, { today: new Date(`${explicitYear}-06-15T00:00:00`), last: false }),
      label: `${monthName} ${explicitYear}`,
    };
    range.from = `${explicitYear}-${String(MONTHS[monthName]).padStart(2, '0')}-01`;
    const end = addMonths(Number(explicitYear), MONTHS[monthName], 1);
    range.to = isoDay(end.year, end.month, 1);
  } else if (monthName) {
    range = monthRange(monthName, { today, last: saysLast });
  } else if (explicitYear && !jobNumber) {
    range = yearRange(explicitYear);
  } else if (/\blast year\b/.test(lower)) {
    range = yearRange(today.getFullYear() - 1);
  }

  const intent = /\b(jobs|work)\b/.test(lower) && !/\bjob\s*#?\s*\d{4,6}\b/.test(lower)
    ? 'jobs'
    : /\b(when|last time|most recent|latest)\b/.test(lower) || (saysLast && /\b(use|used|buy|bought)\b/.test(lower))
      ? 'latest'
      : jobNumber && unusedWords(text, [jobNumber]).length === 0
        ? 'job'
        : 'search';

  const product = bestKnownName(lower, vocabulary.products || []);
  const color = bestKnownName(lower, vocabulary.colors || []);
  const client = bestKnownName(lower, [...(vocabulary.clients || []), ...(vocabulary.titles || [])]);

  return {
    intent,
    jobNumber: intent === 'jobs' ? null : jobNumber,
    product,
    color: color && color !== product ? color : null,
    client: client && client !== product ? client : null,
    from: range?.from || null,
    to: range?.to || null,
    label: range?.label || null,
    original: text,
  };
}

function money(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function lineSummary(row) {
  const bits = [
    row.date,
    row.jobNumber ? `job ${row.jobNumber}` : null,
    row.jobTitle || null,
    row.clientName || row.jobClient || null,
    row.product,
    row.color,
    row.quantity != null ? `qty ${row.quantity}` : null,
    row.price != null ? money(row.price) : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

export function answerQuestion(db, question, options = {}) {
  const interpreted = options.interpreted || interpretQuestion(question, vocabulary(db), options);
  const nothing = {
    interpreted,
    answer: 'Nothing on file matches that.',
    rows: [],
    jobs: [],
  };

  const hasFilter = interpreted.jobNumber || interpreted.product || interpreted.color || interpreted.client || interpreted.from;
  if (!hasFilter) return nothing;

  if (interpreted.intent === 'jobs' && interpreted.from) {
    const jobs = findJobsInRange(db, interpreted);
    if (!jobs.length) {
      return {
        ...nothing,
        answer: `Nothing on file for ${interpreted.label}. That uses the invoice date, which is when the paint was bought.`,
      };
    }
    const lines = jobs.map((job) => {
      const who = [job.title, job.clientName].filter(Boolean).join(' — ');
      return `Job ${job.jobNumber}${who ? ` · ${who}` : ''} · ${job.invoices} Sherwin invoice${job.invoices === 1 ? '' : 's'} · ${job.firstDate}`;
    });
    return {
      interpreted,
      answer: `Jobs with a Sherwin invoice in ${interpreted.label}:\n${lines.join('\n')}`,
      rows: [],
      jobs,
    };
  }

  const rows = findLines(db, {
    ...interpreted,
    limit: interpreted.intent === 'latest' ? 8 : 40,
  });
  if (!rows.length) return nothing;

  if (interpreted.intent === 'latest') {
    const newest = rows[0];
    const sameDay = rows.filter((row) => row.documentId === newest.documentId);
    const detail = sameDay.map((row) => [row.product, row.color, row.quantity != null ? `qty ${row.quantity}` : null].filter(Boolean).join(', ')).join('; ');
    const where = [newest.jobNumber ? `job ${newest.jobNumber}` : null, newest.jobTitle, newest.clientName || newest.jobClient].filter(Boolean).join(' · ');
    return {
      interpreted,
      answer: `Last on file is ${newest.date || 'an undated invoice'}${where ? ` for ${where}` : ''}. ${detail}${newest.driveUrl ? `\nInvoice: ${newest.driveUrl}` : ''}`,
      rows: sameDay,
      jobs: [],
    };
  }

  const shown = rows.slice(0, 12);
  const more = rows.length > shown.length ? `\n${rows.length - shown.length} more rows are on file.` : '';
  return {
    interpreted,
    answer: shown.map(lineSummary).join('\n') + more,
    rows,
    jobs: [],
  };
}

export async function interpretWithModel(question, vocab, { fetchImpl = fetch, today = new Date() } = {}) {
  const key = process.env.ARCHIVE_LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const model = process.env.ARCHIVE_LLM_MODEL?.trim() || 'gpt-4o-mini';
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Turn a painting-company question into JSON. Use only this shape:
{"intent":"latest|jobs|job|search","jobNumber":null,"product":null,"color":null,"client":null,"month":null,"year":null}
intent latest = when did we last use/buy something. jobs = what jobs in a month or year.
product, color, and client must be copied from the lists when one fits, including misspellings in the question.
Do not invent a product that is not on the lists. Today is ${today.toISOString().slice(0, 10)}.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            question,
            products: (vocab.products || []).slice(0, 200),
            colors: (vocab.colors || []).slice(0, 200),
            clients: (vocab.clients || []).slice(0, 200),
          }),
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || 'null');
  } catch {
    return null;
  }
}

export function interpretedFromModel(parsed, vocab, { today = new Date() } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const month = parsed.month && MONTHS[String(parsed.month).toLowerCase()] ? String(parsed.month).toLowerCase() : null;
  const year = parsed.year ? Number(parsed.year) : null;
  let range = null;
  if (month && year) {
    range = monthRange(month, { today: new Date(`${year}-06-15T00:00:00`) });
    range.label = `${month} ${year}`;
    range.from = `${year}-${pad(MONTHS[month])}-01`;
    const end = addMonths(year, MONTHS[month], 1);
    range.to = isoDay(end.year, end.month, 1);
  } else if (month) {
    range = monthRange(month, { today, last: parsed.intent === 'jobs' });
  } else if (year) {
    range = yearRange(year);
  }
  const product = bestKnownName(parsed.product || '', vocab.products || []) || (parsed.product ? bestKnownName(String(parsed.product), vocab.products || []) : null);
  return {
    intent: ['latest', 'jobs', 'job', 'search'].includes(parsed.intent) ? parsed.intent : 'search',
    jobNumber: parsed.jobNumber ? String(parsed.jobNumber) : null,
    product,
    color: parsed.color ? bestKnownName(parsed.color, vocab.colors || []) : null,
    client: parsed.client ? bestKnownName(parsed.client, vocab.clients || []) : null,
    from: range?.from || null,
    to: range?.to || null,
    label: range?.label || null,
    original: parsed.original || '',
  };
}

export async function askArchive(db, question, options = {}) {
  const vocab = vocabulary(db);
  let interpreted = null;
  if (options.useModel !== false) {
    const parsed = await interpretWithModel(question, vocab, options);
    interpreted = interpretedFromModel({ ...parsed, original: question }, vocab, options);
  }
  return answerQuestion(db, question, { ...options, interpreted: interpreted || undefined });
}
