/**
 * Gross pay for one person. QuickBooks payroll journals are the paycheck.
 * Jobber timesheets are the hourly rate times the hours when payroll is silent.
 */

import { listUsers, listUserTimesheets } from '../../jobber/client.js';
import { queryAll } from './qboPostedMatch.js';

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function chicagoDate(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function average(amounts) {
  const rows = amounts.filter((n) => n > 0);
  if (!rows.length) return null;
  return money(rows.reduce((sum, n) => sum + n, 0) / rows.length);
}

function nameHits(text, name) {
  const parts = String(name || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  const hay = String(text || '').toLowerCase();
  return parts.length > 0 && parts.every((word) => hay.includes(word));
}

function wageLine(line, name) {
  const detail = line.JournalEntryLineDetail;
  if (!detail || detail.PostingType !== 'Debit') return null;
  const account = detail.AccountRef?.name || '';
  if (/tax|liability|withholding/i.test(account)) return null;
  const who = `${detail.Entity?.EntityRef?.name || ''} ${line.Description || ''} ${account}`;
  if (!nameHits(who, name)) return null;
  if (!/wage|payroll|labor|labour|salary|gross/i.test(`${account} ${line.Description || ''}`)) return null;
  return money(line.Amount);
}

/** Sum the wage debits for this person on each journal date. */
export function paychecksFromJournals(journals = [], name) {
  const byDate = new Map();
  for (const journal of journals) {
    const date = journal.TxnDate;
    let gross = 0;
    for (const line of journal.Line || []) {
      gross += wageLine(line, name) || 0;
    }
    if (gross <= 0) continue;
    byDate.set(date, money((byDate.get(date) || 0) + gross));
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, gross]) => ({ date, gross }));
}

/** Week ending Saturday, America/Chicago. */
export function weeklyGross(entries = []) {
  const weeks = new Map();
  for (const entry of entries) {
    if (!entry.payable || !entry.startAt || !entry.labourRate) continue;
    const day = chicagoDate(entry.startAt);
    const noon = new Date(`${day}T12:00:00Z`);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(noon);
    const offset = { Sun: 6, Mon: 5, Tue: 4, Wed: 3, Thu: 2, Fri: 1, Sat: 0 }[weekday] ?? 0;
    noon.setUTCDate(noon.getUTCDate() + offset);
    const weekEnding = chicagoDate(noon.toISOString());
    const gross = money(entry.hours * entry.labourRate);
    const hit = weeks.get(weekEnding) || { weekEnding, hours: 0, gross: 0, rate: entry.labourRate };
    hit.hours = money(hit.hours + entry.hours);
    hit.gross = money(hit.gross + gross);
    weeks.set(weekEnding, hit);
  }
  return [...weeks.values()].sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
}

export async function workerWages({ name, start = '2025-01-01' } = {}) {
  const person = String(name || '').trim();
  if (!person) throw new Error('name is required');
  const users = await listUsers();
  const user = users.find((row) => nameHits(row.name, person));
  const [sheets, journals] = await Promise.all([
    user ? listUserTimesheets({ userId: user.id, start }) : Promise.resolve([]),
    queryAll('JournalEntry', start).catch((err) => ({ error: err.message })),
  ]);
  const journalRows = Array.isArray(journals) ? journals : [];
  const checks = paychecksFromJournals(journalRows, user?.name || person);
  const weeks = weeklyGross(sheets);
  const recentWeeks = weeks.filter((week) => week.weekEnding >= '2026-01-01');
  return {
    name: user?.name || person,
    foundUser: Boolean(user),
    journalError: Array.isArray(journals) ? null : journals.error,
    paychecks: checks.slice(-12),
    paycheckCount: checks.length,
    averageGrossPerPaycheck: average(checks.map((row) => row.gross)),
    timesheetWeeks: recentWeeks.slice(-12),
    timesheetWeekCount: recentWeeks.length,
    averageWeeklyGross: average(recentWeeks.map((week) => week.gross)),
    labourRate: recentWeeks.length ? recentWeeks[recentWeeks.length - 1].rate : null,
  };
}
