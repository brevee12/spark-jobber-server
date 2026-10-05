/**
 * Lightweight assertions for QBO staging annotations used by bookkeeping_review.
 * Run: node src/services/bankStaging.test.js
 */
import { stageBankTransaction, buildStagingReport } from './bankStaging.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Fastool PayPal refund on Spark Cash — Banking feed preferred; CreditCardCredit ahead-of-feed.
{
  const tx = stageBankTransaction({
    id: '1',
    accountName: 'Spark Cash Plus (7296)',
    date: '2026-09-23',
    amount: '159.10',
    description: 'PAYPAL *FASTOOL INC FA',
  });
  assertEq(tx.doNotPostViaApi, true, 'fastool refund doNotPostViaApi');
  assertEq(tx.qboWriteTool, 'create_credit_card_credit', 'fastool refund qboWriteTool');
  assertEq(tx.suggestedCategory, '110 – Small Tools & Equipment', 'fastool category');
  assert(tx.accountKind === 'credit_card', 'fastool accountKind');
  assert(/Banking feed/i.test(tx.treatment), 'fastool treatment mentions Banking feed');
  assert(/create_credit_card_credit/i.test(tx.treatment), 'fastool mentions CreditCardCredit op');
  assert(/Error 6000/i.test(tx.treatment), 'fastool warns Error 6000');
  assert(/Error 6430/i.test(tx.treatment), 'fastool warns Error 6430');
}

// Walmart CC refund — same Banking-feed / CreditCardCredit policy; supplies category.
{
  const tx = stageBankTransaction({
    id: '2',
    accountName: 'Spark Cash Plus (4558)',
    date: '2026-09-22',
    amount: '25.12',
    description: 'WALMART REFUND',
  });
  assertEq(tx.doNotPostViaApi, true, 'walmart refund doNotPostViaApi');
  assertEq(tx.qboWriteTool, 'create_credit_card_credit', 'walmart refund qboWriteTool');
  assert(/Supplies/i.test(tx.suggestedCategory), 'walmart category');
  assert(/Banking feed/i.test(tx.treatment), 'walmart treatment mentions Banking feed');
}

// CC charge — prefer feed; expense tool only as ahead-of-feed option.
{
  const tx = stageBankTransaction({
    accountName: 'Capital One Spark Cash',
    amount: '-42.50',
    description: 'SHERWIN WILLIAMS 7051',
  });
  assertEq(tx.doNotPostViaApi, true, 'cc charge prefer feed');
  assertEq(tx.qboWriteTool, 'qbo_create_expense', 'cc charge optional tool');
  assert(/Materials \/ Sherwin/i.test(tx.suggestedCategory), 'sherwin category');
}

// Checking → CC autopay — transfer is the allowed write.
{
  const tx = stageBankTransaction({
    accountName: 'Operating Checking',
    amount: '-450.00',
    description: 'CAPITAL ONE AUTOPAY',
  });
  assertEq(tx.doNotPostViaApi, false, 'cc autopay may use API transfer');
  assertEq(tx.qboWriteTool, 'qbo_create_transfer', 'cc autopay tool');
}

// Matching CC payment credit on the card side — transfer via Banking feed only.
{
  const tx = stageBankTransaction({
    accountName: 'Spark Cash Plus',
    amount: '450.00',
    description: 'PAYMENT THANK YOU',
  });
  assertEq(tx.doNotPostViaApi, true, 'cc payment credit doNotPost');
  assertEq(tx.qboWriteTool, null, 'cc payment credit no write tool');
  assert(/Transfer/i.test(tx.treatment), 'cc payment credit treatment');
}

// Jobber SaaS charge vs Jobber payout deposit (must not share Software category).
{
  const saas = stageBankTransaction({
    accountName: 'Spark Cash Plus',
    amount: '-129.00',
    description: 'JOBBER.COM SUBSCRIPTION',
  });
  assertEq(saas.suggestedCategory, 'Software / Subscriptions', 'jobber saas category');

  const payout = stageBankTransaction({
    accountName: 'Operating Checking',
    amount: '1200.00',
    description: 'JOBBER PAYOUT',
  });
  assertEq(
    payout.suggestedCategory,
    'Income / Undeposited Funds (review)',
    'jobber payout must not be Software'
  );
}

// Report groups by account and exposes policy guardrails.
{
  const report = buildStagingReport([
    {
      id: 'a',
      accountName: 'Spark Cash Plus (7296)',
      amount: '159.10',
      description: 'PAYPAL *FASTOOL INC FA',
    },
    {
      id: 'b',
      accountName: 'Operating Checking',
      amount: '200.00',
      description: 'Customer deposit',
    },
  ]);
  assertEq(report.accountCount, 2, 'accountCount');
  assertEq(report.transactionCount, 2, 'transactionCount');
  assert(report.policy?.creditCardCredits, 'policy.creditCardCredits');
  assert(/Banking feed/i.test(report.policy.creditCardCredits), 'policy prefers Banking feed');
  assert(
    /create_credit_card_credit/i.test(report.policy.creditCardCredits),
    'policy documents CreditCardCredit op'
  );
}

console.log('bankStaging.test.js: all assertions passed');
