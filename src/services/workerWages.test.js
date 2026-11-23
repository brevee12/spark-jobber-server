/**
 * Run: node src/services/workerWages.test.js
 */
import { paychecksFromJournals, weeklyGross } from './workerWages.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const checks = paychecksFromJournals([
  {
    TxnDate: '2026-11-07',
    Line: [
      {
        Amount: 980,
        Description: 'Regular pay',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { name: 'Wages' },
          Entity: { EntityRef: { name: 'Sean Dougherty' } },
        },
      },
      {
        Amount: 120,
        Description: 'Payroll tax',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { name: 'Payroll Tax Expense' },
          Entity: { EntityRef: { name: 'Sean Dougherty' } },
        },
      },
    ],
  },
  {
    TxnDate: '2026-11-21',
    Line: [
      {
        Amount: 1020,
        Description: 'Gross wages',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { name: 'Wages' },
          Entity: { EntityRef: { name: 'Sean Dougherty' } },
        },
      },
    ],
  },
], 'Sean Dougherty');
assert(checks.length === 2, 'two paychecks');
assert(checks[0].gross === 980, 'tax line is not wages');
assert(checks[1].gross === 1020, 'second paycheck');

const weeks = weeklyGross([
  { payable: true, startAt: '2026-11-06T19:26:19Z', hours: 8, labourRate: 25 },
  { payable: false, startAt: '2026-11-06T19:26:19Z', hours: 4, labourRate: 25 },
]);
assert(weeks.length === 1 && weeks[0].weekEnding === '2026-11-07', `week ending ${weeks[0] && weeks[0].weekEnding}`);
assert(weeks[0].gross === 200, 'only payable hours');

console.log('workerWages.test.js: all assertions passed');
