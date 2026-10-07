/**
 * Run: node src/services/qboPostedMatch.test.js
 */
import { matchSimpleFinToQbo } from './qboPostedMatch.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const bag = new Map([
  [
    '2026-09-30|14.11',
    [{ id: 'P1', type: 'Purchase', description: 'BURGER KING 27284', date: '2026-09-30', amount: '14.11' }],
  ],
  [
    '2026-09-29|26.93',
    [{ id: 'P2', type: 'Purchase', description: 'CASEYS 3566', date: '2026-09-29', amount: '26.93' }],
  ],
  [
    '2026-09-17|1685.28',
    [{ id: 'JE1', type: 'JournalEntry', description: 'PAYROLL', date: '2026-09-17', amount: '1685.28' }],
  ],
]);

const txs = [
  {
    id: 'TRN-1',
    date: '2026-09-30',
    amount: '-14.11',
    description: 'BURGER KING #27284',
  },
  {
    id: 'TRN-2',
    date: '2026-09-30',
    amount: '-26.93',
    description: 'CASEYS #3566',
  },
  {
    id: 'TRN-3',
    date: '2026-09-17',
    amount: '-1685.28',
    description: 'INTUIT 05553090 PAYROLL',
  },
  {
    id: 'TRN-4',
    date: '2026-09-30',
    amount: '-99.00',
    description: 'UNKNOWN PAYEE',
  },
];

const filtered = matchSimpleFinToQbo(txs, bag, { onlyOutstanding: true });
assert(filtered.summary.alreadyInQbo === 3, `matched 3 got ${filtered.summary.alreadyInQbo}`);
assert(filtered.summary.outstanding === 1, '1 outstanding');
assert(filtered.transactions[0].id === 'TRN-4', 'unknown remains');
assert(filtered.matched.find((t) => t.id === 'TRN-2')?.qboMatch?.dateOffset === -1, '±1 day match');
assert(filtered.summary.byAccount, 'byAccount stats');

// One QBO transfer clears both feed sides; a Purchase only clears one line.
{
  const tBag = new Map([
    ['2026-09-15|9900.00', [{ id: 'T1', type: 'Transfer', description: 'TRANSFER', date: '2026-09-15', amount: '9900.00', uses: 2 }]],
    ['2026-09-20|50.00', [{ id: 'P9', type: 'Purchase', description: 'CASEYS', date: '2026-09-20', amount: '50.00', uses: 1 }]],
  ]);
  const r = matchSimpleFinToQbo(
    [
      { id: 'chk', accountName: 'EZ BUS', date: '2026-09-15', amount: '9900', description: 'FUNDS TRANSFER FROM LNS' },
      { id: 'loan', accountName: 'Loan *0549-110', date: '2026-09-15', amount: '-9900', description: 'Advance-Advance' },
      { id: 'c1', accountName: 'Spark', date: '2026-09-20', amount: '-50', description: 'CASEYS' },
      { id: 'c2', accountName: 'Spark', date: '2026-09-20', amount: '-50', description: 'CASEYS' },
    ],
    tBag
  );
  assert(r.matched.filter((t) => t.qboMatch.id === 'T1').length === 2, 'transfer clears both sides');
  assert(r.outstanding.map((t) => t.id).join() === 'c2', 'purchase consumed once');
  assert(tBag.get('2026-09-15|9900.00')[0].uses === 2, 'bag not mutated');
}

// Checks match on check number + amount even when QBO date is weeks earlier.
{
  const checkIndex = new Map([['1489|1330.00', { id: 'P50', type: 'Purchase (check #1489, 2026-08-30)', date: '2026-08-30', amount: '1330.00' }]]);
  const r = matchSimpleFinToQbo(
    [{ id: 'ck', date: '2026-09-18', amount: '-1330', description: 'CK # 1489' }],
    new Map(),
    { checkIndex }
  );
  assert(r.matched[0]?.qboMatch?.id === 'P50', 'check matched by number');
}

console.log('qboPostedMatch.test.js: all assertions passed');
