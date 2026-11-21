/**
 * Run: node src/services/bookkeepingBrief.test.js
 */
import { booksBehind, formatBookkeepingBrief, listStagingItems } from './bookkeepingBrief.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const review = {
  generatedAt: '2026-10-07T12:00:00.000Z',
  bankFeed: {
    policy: {
      creditCardCredits: 'Never post CC refunds via API.',
    },
    transactions: [
      {
        date: '2026-10-05',
        accountName: 'CC-Capital One Spark (7296)',
        amount: '-95.92',
        amountSigned: -95.92,
        description: 'CASEYS #3566',
        suggestedCategory: 'Fuel / Auto',
        treatment: 'Card charge. Prefer clearing via the QBO Banking feed.',
        doNotPostViaApi: true,
        qboWriteTool: 'qbo_create_expense',
      },
      {
        date: '2026-09-22',
        accountName: 'EZ BUS 3969 *3969 (3969)',
        amount: '-3000.00',
        amountSigned: -3000,
        description: 'CK # 1491',
        suggestedCategory: 'Expense / Owner draw (review)',
        treatment: 'Checking outflow.',
        doNotPostViaApi: true,
      },
      {
        date: '2026-09-23',
        accountName: 'CC-Capital One Spark (7296)',
        amount: '159.10',
        amountSigned: 159.1,
        description: 'PAYPAL *FASTOOL INC FA',
        suggestedCategory: '110 – Small Tools & Equipment',
        treatment:
          'Card credit/refund. QBO has no reliable MCP credit-card-credit write — clear this in the QBO Banking feed.',
        doNotPostViaApi: true,
        qboWriteTool: null,
      },
    ],
  },
  qbo: {
    cashBalances: {
      checking: [
        {
          name: 'Checking-Marion County Bank (3696)',
          balance: 14505.78,
        },
      ],
      lineOfCredit: [],
      creditCards: [
        { name: 'CC-Capital One Spark (7296)', balance: -13168.98 },
      ],
    },
    sherwinBills: { count: 2, bills: [] },
  },
  errors: [],
};

const items = listStagingItems(review);
assert(items.length === 3, 'three staging items');
assert(items[0].n === 1, '1-indexed');
assert(/EZ BUS/i.test(items[0].accountName), 'checking account first');

const brief = formatBookkeepingBrief(review, {
  agentUrl: 'https://cursor.com/agents/example',
});

assert(/Bookkeeping brief 2026-10-07 — 15 days behind — 3 staged lines/.test(brief.subject), 'subject has date and lag');
assert(brief.text.startsWith('15 days behind — oldest open line 2026-09-22.'), 'first line is the lag');
assert(brief.html.includes('15 days behind'), 'html leads with the lag');
assert(brief.behind?.days === 15, 'behind days');
assert(brief.itemCount === 3, 'itemCount');
assert(brief.groups?.length === 2, 'two account subsections');
assert(brief.text.includes('§1 Cash snapshot'), '§1');
assert(brief.text.includes('§2 Bank staging by account'), '§2');
assert(brief.text.includes('### EZ BUS'), 'checking subsection');
assert(brief.text.includes('### CC-Capital One Spark'), 'cc subsection');
assert(brief.groups?.every((g) => brief.text.includes(`### ${g.accountName}`)), 'account headers');
assert(brief.text.includes('§3 How to approve'), '§3');
assert(brief.text.includes('Date'), 'table header Date');
assert(brief.text.includes('Suggested category'), 'table header category');
assert(brief.text.includes('CASEYS #3566'), 'payee in text');
assert(brief.text.includes('CK # 1491'), 'checking row in table');
assert(brief.text.includes('https://cursor.com/agents/example'), 'agent url');
assert(brief.html.includes('<table'), 'html table');
assert(brief.html.includes('<th'), 'html table header');
assert(brief.html.includes('<h3'), 'html account headers');
assert(brief.html.includes('approve'), 'html approve hint');
assert(brief.html.includes('Open Cursor agent'), 'html agent link');

const empty = formatBookkeepingBrief({
  generatedAt: '2026-10-07T12:00:00.000Z',
  bankFeed: { transactions: [] },
  qbo: {},
  errors: [],
});
assert(/current — no new bank lines/i.test(empty.subject), 'empty subject is current');
assert(empty.text.startsWith('Current — no open bank lines.'), 'empty first line');

const lateUtc = formatBookkeepingBrief(
  {
    generatedAt: '2026-10-08T03:00:00.000Z',
    bankFeed: {
      transactions: [{ date: '2026-10-07', accountName: 'Checking', amount: '-1', description: 'X' }],
    },
    qbo: {},
    errors: [],
  }
);
assert(lateUtc.behind.today === '2026-10-07', 'brief date is Chicago, not UTC');
assert(/current/.test(lateUtc.subject), 'same Chicago day is current');

const unknown = booksBehind({
  generatedAt: '2026-10-07T12:00:00.000Z',
  errors: [{ section: 'bankFeed', error: 'down' }],
});
assert(unknown.label === 'days behind unknown', 'failed feed is not current');

console.log('bookkeepingBrief.test.js: all assertions passed');
