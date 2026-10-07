/**
 * Run: node src/services/qboCategorySuggest.test.js
 */
import {
  suggestQboAccounts,
  buildPayeeHistory,
  qboAccountForFeed,
  vendorKey,
} from './qboCategorySuggest.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const accounts = [
  { id: '124', name: 'Checking-Marion County Bank (3696)', accountType: 'Bank' },
  { id: '82', name: 'CC-Capital One (4558)', accountType: 'Credit Card' },
  { id: '101', name: 'CC-Capital One Spark (7296)', accountType: 'Credit Card' },
  { id: '1150040000', name: 'N/P-Marion County Bank (F150 0549-90)', accountType: 'Long Term Liability' },
  { id: '77', name: 'N/P-Marion County Bank (LOC 0549-100)', accountType: 'Long Term Liability' },
  { id: '110', name: 'Small Tools & Equipment', accountType: 'Cost of Goods Sold' },
  { id: '16', name: 'Job Supplies', accountType: 'Cost of Goods Sold' },
  { id: '4', name: 'Car & Truck', accountType: 'Expense' },
  { id: '14', name: 'Rent & Lease', accountType: 'Expense' },
  { id: '25', name: 'Uncategorized Expense', accountType: 'Expense' },
];

const purchases = [
  {
    Id: 'p1', TxnDate: '2026-07-01', TotalAmt: 42, EntityRef: { name: "Casey's" },
    Line: [{ Amount: 42, Description: 'CASEYS #3566', AccountBasedExpenseLineDetail: { AccountRef: { value: '4' } } }],
  },
  {
    Id: 'p2', TxnDate: '2026-07-03', TotalAmt: 30, EntityRef: { name: "Casey's" },
    Line: [{ Amount: 30, Description: 'CASEYS', AccountBasedExpenseLineDetail: { AccountRef: { value: '25' } } }],
  },
  {
    Id: 'p3', TxnDate: '2026-08-01', TotalAmt: 1285, PaymentType: 'Check', DocNumber: '1470',
    EntityRef: { name: 'Shop Landlord' },
    Line: [{ Amount: 1285, AccountBasedExpenseLineDetail: { AccountRef: { value: '14' } } }],
  },
];
accounts.push({ id: '5', name: 'Bank Charges & Fees', accountType: 'Expense' });
purchases.push({
  Id: 'p4', TxnDate: '2026-09-18', TotalAmt: 25,
  Line: [{ Amount: 25, Description: 'OVERDRAFT FEE PER PAID ITEM INTUIT 05553090 PAYROLL', AccountBasedExpenseLineDetail: { AccountRef: { value: '5' } } }],
});
const history = buildPayeeHistory(purchases, accounts);
assertEq(history.length, 3, 'uncategorized history ignored');
assertEq(vendorKey('PAYPAL *FASTOOL INC FA').join(' '), 'FASTOOL', 'vendor key strips paypal');

assertEq(qboAccountForFeed('Spark Cash Plus (7296)', accounts)?.id, '101', 'spark feed');
assertEq(qboAccountForFeed('EZ BUS 3969 *3969 (3969)', accounts)?.id, '124', 'checking alias');
assertEq(qboAccountForFeed('Loan *0549-90 (0549)', accounts)?.id, '1150040000', 'f150 loan');
assertEq(qboAccountForFeed('Loan *0549-110 (0549)', accounts), null, 'unknown loan is not guessed');

const txs = [
  { id: 'a', accountName: 'Spark Cash Plus (7296)', date: '2026-09-15', amount: 11433.24, description: 'CAPITAL ONE AUTOPAY PYMT' },
  { id: 'b', accountName: 'EZ BUS 3969 *3969 (3969)', date: '2026-09-15', amount: -11433.24, description: 'CAPITAL ONE CRCARDPMT' },
  { id: 'c', accountName: 'EZ BUS 3969 *3969 (3969)', date: '2026-09-17', amount: -1685.28, description: 'INTUIT 05553090 PAYROLL' },
  { id: 'd', accountName: 'Spark Cash Plus (7296)', date: '2026-09-20', amount: -55, description: 'CASEYS #3566 KNOXVILLE' },
  { id: 'e', accountName: 'EZ BUS 3969 *3969 (3969)', date: '2026-09-14', amount: -1285, description: 'CK # 1483' },
  { id: 'f', accountName: 'EZ BUS 3969 *3969 (3969)', date: '2026-09-22', amount: -3000, description: 'CK # 1491' },
  { id: 'g', accountName: 'Spark Cash Plus (7296)', date: '2026-09-23', amount: 159.1, description: 'PAYPAL *FASTOOL INC FA', suggestedCategory: '110 – Small Tools & Equipment', accountKind: 'credit_card' },
  { id: 'h', accountName: 'Loan *0549-110 (0549)', date: '2026-09-15', amount: -9900, description: 'Advance-Advance' },
  { id: 'i', accountName: 'EZ BUS 3969 *3969 (3969)', date: '2026-08-24', amount: -3093.9, description: 'CAPITAL ONE CRCARDPMT' },
];
const out = Object.fromEntries(
  suggestQboAccounts(txs, { accounts, history }).map((t) => [t.id, t])
);

assertEq(out.a.suggestedCategory, 'Transfer ↔ Checking-Marion County Bank (3696)', 'cc side of autopay');
assertEq(out.a.pairedTxId, 'b', 'autopay paired');
assertEq(out.b.suggestedQboAccount.id, '101', 'checking side → spark');
assertEq(out.c.suggestionSource, 'match-payroll', 'payroll → match');
assertEq(out.d.suggestedQboAccount.id, '4', 'caseys from history');
assertEq(out.d.suggestionSource, 'history', 'history source');
assertEq(out.e.suggestedQboAccount.id, '14', 'check by recurring amount');
assertEq(out.f.suggestionSource, 'needs-input', 'unknown check flagged');
assertEq(out.g.suggestedCategory, 'Small Tools & Equipment', 'rule → real COA name');
assertEq(out.h.suggestionSource, 'needs-input', 'unmapped loan flagged');
assertEq(out.i.suggestionSource, 'needs-input', 'unpaired card payment asks which card');

for (const t of Object.values(out)) {
  if (t.suggestedQboAccount) {
    const real = accounts.find((a) => a.id === t.suggestedQboAccount.id);
    assertEq(real?.name, t.suggestedQboAccount.name, `account ${t.id} exists in COA`);
  }
}

console.log('qboCategorySuggest tests passed');
