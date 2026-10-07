/**
 * Run: node src/services/simplefin.test.js
 */
import { deleteJson } from '../lib/jsonStore.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

process.env.SIMPLEFIN_ACCESS_URL = 'https://user:pass@bridge.example/simplefin';
process.env.SIMPLEFIN_MAX_DAILY_REQUESTS = '2';
deleteJson('.simplefin-cache.json');

const now = Math.floor(Date.now() / 1000);
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        accounts: [
          {
            id: 'A1',
            name: 'EZ BUS 3969',
            transactions: [
              { id: 't-new', posted: now - 86400, amount: '-10', description: 'NEW' },
              { id: 't-old', posted: now - 30 * 86400, amount: '-20', description: 'OLD' },
            ],
          },
        ],
      }),
  };
};

const { fetchSimpleFinTransactions, getSimpleFinCacheInfo } = await import('./simplefin.js');

const iso = (daysBack) => new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

const first = await fetchSimpleFinTransactions({ includeProcessed: true });
assertEq(first.length, 2, 'default window returns both');
for (let i = 0; i < 10; i += 1) await fetchSimpleFinTransactions({ includeProcessed: true });
assertEq(calls, 1, 'repeat reviews reuse the cache');

const recent = await fetchSimpleFinTransactions({ startDate: iso(7), includeProcessed: true });
assertEq(recent.map((t) => t.id).join(), 't-new', 'startDate filtered locally');
assertEq(calls, 1, 'narrower window still cached');

await fetchSimpleFinTransactions({ startDate: iso(200), includeProcessed: true });
assertEq(calls, 2, 'older-than-cache window refetches');

await fetchSimpleFinTransactions({ startDate: iso(300), includeProcessed: true });
assertEq(calls, 2, 'daily cap serves stale cache instead of calling');
assertEq(getSimpleFinCacheInfo().requestsToday, 2, 'counter tracked');

deleteJson('.simplefin-cache.json');
console.log('simplefin.test.js: all assertions passed');
