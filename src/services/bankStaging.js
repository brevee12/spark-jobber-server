/**
 * Annotate SimpleFIN bank rows with CFO staging hints for Spark.
 * Credits on credit-card accounts must never be posted via qbo_create_* —
 * clear them in the QBO Banking feed against the original expense account.
 */

const CC_ACCOUNT_RE = /spark\s*cash|capital\s*one|credit\s*card|\bcc\b/i;
const CHECKING_ACCOUNT_RE = /checking|ez\s*bus|\boperat/i;

/** Payee → chart-of-accounts style suggestions (Veenstra Painting). */
const CATEGORY_RULES = [
  {
    test: /fastool|harbor\s*freight|northern\s*tool|tool\s*barn/i,
    category: '110 – Small Tools & Equipment',
    note: 'Tool purchase or tool return refund',
  },
  {
    test: /sherwin/i,
    category: 'Materials / Sherwin-Williams',
    note: 'Paint & supplies — match bill or expense account used for Sherwin',
  },
  {
    test: /jobber/i,
    category: 'Software / Subscriptions',
    note: 'Jobber SaaS subscription',
  },
  {
    test: /quickbooks|intuit/i,
    category: 'Software / Subscriptions',
    note: 'QuickBooks / Intuit subscription',
  },
  {
    test: /microsoft|google\s*\*|adobe|openai|cursor|simplefin/i,
    category: 'Software / Subscriptions',
    note: 'Software / SaaS',
  },
  {
    test: /state\s*farm|geico|progressive|insurance/i,
    category: 'Insurance',
    note: 'Insurance premium',
  },
  {
    test: /casey|kwik\s*star|shell|bp\s|#\d{3,}|fuel|gas\s/i,
    category: 'Fuel / Auto',
    note: 'Fuel or convenience — confirm job vs personal',
  },
  {
    test: /verizon|vzwrlss|at&t|t-mobile|comcast/i,
    category: 'Telephone / Utilities',
    note: 'Phone / connectivity',
  },
  {
    test: /amazon|wal-?mart|wm\s*super|theisen|farm\s*and\s*home|knoxville\s*farm/i,
    category: 'Supplies (review)',
    note: 'Retail — split job materials vs office/tools if needed',
  },
  {
    test: /taco\s*bell|burger\s*king|rib\s*shack|mcdonald|subway|chipotle/i,
    category: 'Meals & Entertainment',
    note: 'Meal — confirm business purpose',
  },
  {
    test: /ulrich\s*ford|ford|lincoln|auto\s*repair|napa|o'?reilly/i,
    category: 'Vehicle / Repairs',
    note: 'Vehicle-related',
  },
];

function isCreditCardAccount(accountName = '') {
  return CC_ACCOUNT_RE.test(accountName);
}

function isCheckingAccount(accountName = '') {
  return CHECKING_ACCOUNT_RE.test(accountName);
}

function amountNumber(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

function matchCategory(description = '') {
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(description)) {
      return { suggestedCategory: rule.category, categoryNote: rule.note };
    }
  }
  return { suggestedCategory: null, categoryNote: null };
}

function isCcPayment(description = '') {
  return /capital\s*one|autopay|crcardpmt|credit\s*card\s*pmt|cc\s*payment|payment\s*thank/i.test(
    description
  );
}

/**
 * Build staging fields for one SimpleFIN transaction.
 */
export function stageBankTransaction(tx = {}) {
  const amount = amountNumber(tx.amount);
  const description = String(tx.description || '');
  const accountName = String(tx.accountName || '');
  const onCc = isCreditCardAccount(accountName);
  const onChecking = isCheckingAccount(accountName);
  const { suggestedCategory, categoryNote } = matchCategory(description);

  const base = {
    ...tx,
    amountSigned: amount,
    isCredit: amount > 0,
    isDebit: amount < 0,
    accountKind: onCc ? 'credit_card' : onChecking ? 'checking' : 'other',
    suggestedCategory,
    doNotPostViaApi: false,
    qboWriteTool: null,
    treatment: null,
  };

  // --- Credit card credits (refunds / returns / payment credits) ---
  if (onCc && amount > 0) {
    if (isCcPayment(description)) {
      return {
        ...base,
        suggestedCategory: suggestedCategory || 'Transfer – CC payment',
        doNotPostViaApi: true,
        treatment:
          'Credit-card payment credit. Match as a Transfer in the QBO Banking feed against Operating Checking (do not create a Deposit or Expense).',
      };
    }
    return {
      ...base,
      suggestedCategory: suggestedCategory || 'Original expense account (review)',
      doNotPostViaApi: true,
      treatment:
        `${categoryNote || 'Card credit/refund'}. ` +
        'QBO has no reliable MCP credit-card-credit write — clear this in the QBO Banking feed matched to the same expense account as the original purchase' +
        (suggestedCategory ? ` (${suggestedCategory})` : '') +
        '. Do NOT call qbo_create_expense or qbo_create_deposit (that would duplicate when the feed clears).',
    };
  }

  // --- Credit card charges ---
  if (onCc && amount < 0) {
    return {
      ...base,
      suggestedCategory: suggestedCategory || 'Expense (review)',
      doNotPostViaApi: true,
      treatment:
        `${categoryNote || 'Card charge'}. Prefer clearing via the QBO Banking feed categorized to ` +
        `${suggestedCategory || 'the correct expense account'}. Only use qbo_create_expense if posting ahead of the feed and you will match (not re-create) later.`,
      qboWriteTool: 'qbo_create_expense',
    };
  }

  // --- Checking: CC payment out ---
  if (onChecking && amount < 0 && isCcPayment(description)) {
    return {
      ...base,
      suggestedCategory: 'Transfer – Credit card payment',
      doNotPostViaApi: false,
      qboWriteTool: 'qbo_create_transfer',
      treatment:
        'Credit-card autopay from checking. Clear as a Transfer (Checking → Capital One) in the QBO Banking feed, or use qbo_create_transfer once if posting ahead of the feed.',
    };
  }

  // --- Checking: outgoing check / debit ---
  if (onChecking && amount < 0) {
    return {
      ...base,
      suggestedCategory: suggestedCategory || 'Expense / Owner draw (review)',
      doNotPostViaApi: true,
      treatment:
        `${categoryNote || 'Checking outflow'}. Categorize in the QBO Banking feed (check, EFT, or expense). Avoid posting a second Purchase if the feed line is still open.`,
      qboWriteTool: 'qbo_create_expense',
    };
  }

  // --- Checking: deposits ---
  if (onChecking && amount > 0) {
    return {
      ...base,
      suggestedCategory: suggestedCategory || 'Income / Undeposited Funds (review)',
      doNotPostViaApi: true,
      treatment:
        'Checking deposit. Match in the QBO Banking feed to invoice payments, Undeposited Funds, or other income. Do not qbo_create_deposit if Jobber/QBO already recorded the payment.',
      qboWriteTool: 'qbo_create_deposit',
    };
  }

  return {
    ...base,
    treatment: 'Review manually — account type not recognized as CC or checking.',
  };
}

/**
 * Group annotated txs for Spark display (matches staging report layout).
 */
export function buildStagingReport(transactions = []) {
  const annotated = transactions.map(stageBankTransaction);
  const byAccount = new Map();

  for (const tx of annotated) {
    const key = tx.accountName || tx.accountId || 'Unknown';
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(tx);
  }

  const accounts = [...byAccount.entries()].map(([accountName, txs]) => ({
    accountName,
    count: txs.length,
    transactions: txs,
  }));

  return {
    policy: {
      creditCardCredits:
        'Never post CC refunds/credits via qbo_create_expense or qbo_create_deposit. Clear in QBO Banking feed against the original expense account.',
      creditCardCharges:
        'Prefer QBO Banking feed categorization. qbo_create_expense only when intentionally posting ahead of the feed.',
      transfers:
        'CC autopay pairs (checking debit + card credit) → Transfer, not expense/deposit.',
    },
    accountCount: accounts.length,
    transactionCount: annotated.length,
    accounts,
    transactions: annotated,
  };
}
