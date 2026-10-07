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
    [{ id: 'P1', type: 'Purchase', description: 'BURGER KING 27284' }],
  ],
  [
    '2026-09-30|26.93',
    [{ id: 'P2', type: 'Purchase', description: 'CASEYS 3566' }],
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
    date: '2026-09-30',
    amount: '-99.00',
    description: 'UNKNOWN PAYEE',
  },
];

const filtered = matchSimpleFinToQbo(txs, bag, { onlyOutstanding: true });
assert(filtered.summary.alreadyInQbo === 2, 'matched 2');
assert(filtered.summary.outstanding === 1, '1 outstanding');
assert(filtered.transactions.length === 1, 'filtered length');
assert(filtered.transactions[0].id === 'TRN-3', 'unknown remains');

const all = matchSimpleFinToQbo(txs, bag, { onlyOutstanding: false });
assert(all.transactions.length === 3, 'unfiltered keeps all');
assert(all.transactions.filter((t) => t.alreadyInQbo).length === 2, 'flags');

console.log('qboPostedMatch.test.js: all assertions passed');
