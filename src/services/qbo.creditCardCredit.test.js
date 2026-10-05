/**
 * Offline assertions for CreditCardCredit Purchase payload.
 * Run: node src/services/qbo.creditCardCredit.test.js
 */
import { buildCreditCardCreditPayload } from './qbo.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertThrows(fn, match, label) {
  try {
    fn();
    throw new Error(`${label}: expected throw`);
  } catch (err) {
    if (err.message === `${label}: expected throw`) throw err;
    assert(
      match.test(err.message),
      `${label}: expected message matching ${match}, got ${JSON.stringify(err.message)}`
    );
  }
}

{
  const payload = buildCreditCardCreditPayload({
    paymentAccountId: '88',
    categoryAccountId: '16',
    amount: 25.12,
    txnDate: '2026-09-22',
    memo: 'Walmart refund',
  });
  assertEq(payload.PaymentType, 'CreditCard', 'PaymentType');
  assertEq(payload.Credit, true, 'Credit flag');
  assertEq(payload.AccountRef.value, '88', 'CC AccountRef');
  assertEq(payload.TxnDate, '2026-09-22', 'TxnDate');
  assertEq(payload.PrivateNote, 'Walmart refund', 'memo');
  assertEq(payload.Line.length, 1, 'line count');
  assertEq(payload.Line[0].Amount, 25.12, 'positive amount');
  assertEq(
    payload.Line[0].DetailType,
    'AccountBasedExpenseLineDetail',
    'detail type'
  );
  assertEq(
    payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value,
    '16',
    'category account'
  );
}

// Absolute value — Spark must not send negative Purchase amounts (Error 6000).
{
  const payload = buildCreditCardCreditPayload({
    paymentAccountId: '91',
    categoryAccountId: '110',
    amount: -159.1,
    memo: 'Fastool refund',
  });
  assertEq(payload.Credit, true, 'negative input still Credit:true');
  assertEq(payload.Line[0].Amount, 159.1, 'abs amount');
  assertEq(payload.PaymentType, 'CreditCard', 'PaymentType on abs path');
}

assertThrows(
  () => buildCreditCardCreditPayload({ categoryAccountId: '16', amount: 1 }),
  /paymentAccountId/i,
  'missing CC account'
);
assertThrows(
  () => buildCreditCardCreditPayload({ paymentAccountId: '88', amount: 1 }),
  /categoryAccountId/i,
  'missing category'
);
assertThrows(
  () =>
    buildCreditCardCreditPayload({
      paymentAccountId: '88',
      categoryAccountId: '16',
      amount: 0,
    }),
  /non-zero/i,
  'zero amount'
);

console.log('qbo.creditCardCredit.test.js: all assertions passed');
