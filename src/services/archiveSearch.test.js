import assert from 'node:assert/strict';
import { createArchive, rememberDocument, rememberJob } from './jobArchive.js';
import { answerQuestion, bestKnownName } from './archiveSearch.js';

const today = new Date('2026-11-05T12:00:00Z');
const db = createArchive(':memory:');

rememberDocument(db, {
  source: 'sherwin-csv',
  docNumber: '111',
  jobNumber: '26054',
  date: '2026-07-08',
  total: 86.39,
  clientName: 'DeHuizen Carpentry',
  lines: [{ product: 'Cashmere Low Lustre', color: 'Alabaster', quantity: 1, price: 58.44 }],
});
rememberDocument(db, {
  source: 'sherwin-csv',
  docNumber: '222',
  jobNumber: '25099',
  date: '2026-03-12',
  total: 309.16,
  clientName: 'Doug & Diane Gumm',
  lines: [{ product: 'Emerald Interior - Matte', color: 'Techno Gray', quantity: 4, price: 77.29 }],
});
rememberDocument(db, {
  source: 'sherwin-csv',
  docNumber: '333',
  jobNumber: '26111',
  date: '2026-03-20',
  total: 40,
  lines: [{ product: 'ProMar 400', color: 'Ceiling White', quantity: 1, price: 35.5 }],
});
rememberJob(db, {
  jobNumber: '26054',
  title: 'Olsen Bathroom and Office Door',
  clientName: 'DeHuizen Carpentry',
});

assertEq(bestKnownName('when did we last use cashmeer', ['Cashmere Low Lustre', 'ProMar 400']), 'Cashmere Low Lustre', 'misspelling finds Cashmere');

const last = answerQuestion(db, 'when did we last use cashmeer', { today, useModel: false });
assertEq(last.interpreted.intent, 'latest', 'last-use is a latest question');
assertEq(last.interpreted.product, 'Cashmere Low Lustre', 'product is the real name');
assertEq(last.answer.includes('2026-07-08'), true, 'newest Cashmere date');
assertEq(last.answer.includes('26054'), true, 'job number is included');
assertEq(last.answer.includes('guess'), false, 'answer does not guess');

const march = answerQuestion(db, 'what jobs did we do last march', { today, useModel: false });
assertEq(march.interpreted.intent, 'jobs', 'march is a jobs question');
assertEq(march.interpreted.label, 'march 2026', 'last March from November is March 2026');
assertEq(march.jobs.map((job) => job.jobNumber).sort().join(','), '25099,26111', 'both March jobs');
assertEq(march.answer.includes('26054'), false, 'July job is not in March');

const older = answerQuestion(db, 'jobs in march 2025', { today, useModel: false });
assertEq(older.jobs.length, 0, 'March 2025 is empty');
assertEq(older.answer.startsWith('Nothing on file'), true, 'empty month says nothing on file');

const color = answerQuestion(db, 'techno gray', { today, useModel: false });
assertEq(color.rows[0].jobNumber, '25099', 'color finds the Gumm invoice');

const job = answerQuestion(db, 'job 26054', { today, useModel: false });
assertEq(job.rows.every((row) => row.jobNumber === '26054'), true, 'job number limits the rows');

const empty = answerQuestion(db, 'when did we last use ben moore', { today, useModel: false });
assertEq(empty.answer, 'Nothing on file matches that.', 'unknown product is not invented');

const noise = answerQuestion(db, 'hello', { today, useModel: false });
assertEq(noise.rows.length, 0, 'a question with no product or date returns nothing');

function assertEq(actual, expected, message) {
  assert.equal(actual, expected, `${message}: ${actual} !== ${expected}`);
}

console.log('archiveSearch.test.js: all assertions passed');
