/**
 * Run: node src/lib/durableTokens.test.js
 */
import { newerDurableToken } from './durableTokens.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

process.env.RENDER_API_KEY = 'test';
process.env.RENDER_SERVICE_ID = 'srv-test';
let stored = 'rotated-by-other-instance';
globalThis.fetch = async () => ({ ok: true, json: async () => ({ key: 'QBO_REFRESH_TOKEN', value: stored }) });

process.env.QBO_REFRESH_TOKEN = 'stale-boot-copy';
assertEq(await newerDurableToken('QBO_REFRESH_TOKEN', 'stale-boot-copy'), 'rotated-by-other-instance', 'newer token adopted');
assertEq(process.env.QBO_REFRESH_TOKEN, 'rotated-by-other-instance', 'process env updated');

stored = 'same';
assertEq(await newerDurableToken('QBO_REFRESH_TOKEN', 'same'), null, 'no newer token → caller may clear');

globalThis.fetch = async () => ({ ok: false, status: 500 });
assertEq(await newerDurableToken('QBO_REFRESH_TOKEN', 'x'), null, 'Render API failure → null');

console.log('durableTokens.test.js: all assertions passed');
