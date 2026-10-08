import {
  getInvoice,
  createExpense,
  deleteExpense,
  searchJobs,
  createClient,
  createQuote,
  createVisit,
  getJob,
  searchInvoices,
  getQuote,
  searchClients,
  searchQuotes,
  searchRequests,
  editQuote,
} from '../../jobber/client.js';
import {
  fetchSimpleFinTransactions,
  getSimpleFinCacheInfo,
  markTransactionsProcessed,
  markTransactionsProcessedDurable,
  listProcessedTransactionIds,
} from '../services/simplefin.js';
import { buildStagingReport } from '../services/bankStaging.js';
import { filterOutstandingAgainstQbo } from '../services/qboPostedMatch.js';
import {
  loadSuggestionContext,
  suggestQboAccounts,
} from '../services/qboCategorySuggest.js';
import { runBookkeepingNotify } from '../services/bookkeepingNotify.js';
import { runQuoteMeeting } from './quoteMeeting.js';
import {
  getSherwinWilliamsBills,
  postQboExpense,
  postQboCreditCardCredit,
  postQboDeposit,
  postQboTransfer,
  deleteQboTransaction,
  getQboAccounts,
  getQboCashSummary,
  getQboProfitAndLoss,
} from '../services/qbo.js';

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(err) {
  return {
    content: [{ type: 'text', text: `Error: ${err.message}` }],
    isError: true,
  };
}

const JOBBER_OPS = [
  'search_jobs',
  'search_invoices',
  'search_clients',
  'search_quotes',
  'search_requests',
  'get_job',
  'get_invoice',
  'get_quote',
  'create_client',
  'create_quote',
  'update_quote',
  'create_expense',
  'delete_expense',
  'schedule_visit',
];

/**
 * Run one Jobber op. Throws on failure (caller records per-action errors).
 */
async function runJobberAction(action = {}) {
  const op = String(action.op || action.action || '').trim();
  if (!op) throw new Error('Each action needs op');

  switch (op) {
    case 'search_jobs': {
      const jobs = await searchJobs({
        jobNumber: action.jobNumber,
        query: action.query,
        limit: action.limit,
      });
      return { count: jobs.length, jobs };
    }
    case 'search_invoices': {
      return searchInvoices({
        clientName: action.clientName,
        status: action.status,
        invoiceNumber: action.invoiceNumber,
        query: action.query,
        limit: action.limit,
      });
    }
    case 'search_clients': {
      return searchClients({
        query: action.query || action.clientName || action.name,
        limit: action.limit,
      });
    }
    case 'search_quotes': {
      return searchQuotes({
        query: action.query || action.clientName,
        clientId: action.clientId,
        status: action.status,
        limit: action.limit,
      });
    }
    case 'search_requests': {
      return searchRequests({
        query: action.query || action.clientName,
        status: action.status,
        limit: action.limit,
      });
    }
    case 'get_job': {
      const jobId = action.jobId || action.id;
      return getJob(jobId);
    }
    case 'get_invoice': {
      const invoiceId = action.invoiceId || action.invoice_id || action.id;
      return getInvoice(invoiceId);
    }
    case 'get_quote': {
      const quoteId = action.quoteId || action.id;
      return getQuote(quoteId);
    }
    case 'create_client': {
      return createClient({
        firstName: action.firstName,
        lastName: action.lastName,
        companyName: action.companyName,
        isCompany: action.isCompany,
        isLead: action.isLead,
        email: action.email,
        phone: action.phone,
        note: action.note,
        billingAddress: action.billingAddress,
      });
    }
    case 'create_quote': {
      return createQuote({
        clientId: action.clientId,
        title: action.title,
        message: action.message,
        depositAmount: action.depositAmount,
        propertyId: action.propertyId,
        requestId: action.requestId,
        lineItems: action.lineItems,
      });
    }
    case 'update_quote': {
      return editQuote({
        quoteId: action.quoteId || action.id,
        title: action.title,
        message: action.message,
        depositAmount: action.depositAmount,
        lineItems: action.lineItems,
        replaceLineItems: Boolean(action.replaceLineItems),
      });
    }
    case 'create_expense': {
      return createExpense({
        amount: action.amount,
        description: action.description,
        title: action.title,
        date: action.date,
        linkedJobId: action.linkedJobId || action.linked_job_id,
      });
    }
    case 'delete_expense': {
      return deleteExpense(action.expenseId || action.id);
    }
    case 'schedule_visit': {
      return createVisit({
        jobId: action.jobId,
        startAt: action.startAt,
        endAt: action.endAt,
        title: action.title,
        instructions: action.instructions,
        assignedUserIds: action.assignedUserIds,
        allDay: action.allDay,
      });
    }
    default:
      throw new Error(
        `Unknown Jobber op "${op}". Use one of: ${JOBBER_OPS.join(', ')}`
      );
  }
}

/**
 * Execute many Jobber actions under a single MCP Allow.
 * Continues after per-action failures so one bad row doesn't abort the batch.
 */
async function runJobberBatch(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('Provide actions: [{ op, ...params }, ...]');
  }
  if (actions.length > 25) {
    throw new Error('Max 25 Jobber actions per batch');
  }

  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] || {};
    const op = action.op || action.action || null;
    try {
      const data = await runJobberAction(action);
      results.push({ index: i, op, ok: true, data });
    } catch (err) {
      results.push({ index: i, op, ok: false, error: err.message });
    }
  }

  return {
    count: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * Read-only bookkeeping snapshot for scheduled CFO reviews.
 * Does NOT write to QuickBooks (QBO writes stay on separate tools).
 */
export async function runBookkeepingReview(args = {}) {
  const out = {
    generatedAt: new Date().toISOString(),
    bankFeed: null,
    qbo: {},
    jobber: {},
    errors: [],
  };

  const wantBank = args.includeBankFeed !== false;
  const wantCash = args.includeCashBalances !== false;
  const wantAccounts = Boolean(args.includeAccounts);
  const wantSherwin = args.includeSherwinBills !== false;
  const wantPnl = Boolean(args.includeProfitAndLoss);
  const jobberActions = Array.isArray(args.jobberActions)
    ? args.jobberActions
    : [];

  if (wantBank) {
    try {
      let txs = await fetchSimpleFinTransactions({
        startDate: args.startDate,
        accountId: args.accountId,
        includeProcessed: Boolean(args.includeProcessed),
      });
      // Default: drop rows already booked in QBO (Purchase/Deposit/Transfer).
      // Without this, "outstanding" = entire SimpleFIN history minus a tiny seen list.
      const excludeBookedInQbo = args.excludeBookedInQbo !== false;
      let qboMatchSummary = null;
      let feedLines = txs;
      if (excludeBookedInQbo && txs.length) {
        const filtered = await filterOutstandingAgainstQbo(txs, {
          startDate: args.startDate,
          endDate: args.endDate,
          onlyOutstanding: true,
        });
        feedLines = [...filtered.outstanding, ...filtered.matched];
        txs = filtered.transactions;
        qboMatchSummary = filtered.summary;
      }
      if (args.markSeen && txs.length) {
        markTransactionsProcessed(txs.map((t) => t.id));
      }
      // Staging annotations tell Spark how to clear each row (esp. CC refunds).
      const staging = buildStagingReport(txs);
      let transactions = staging.transactions;
      let accounts = staging.accounts;
      let coaSuggestions = null;
      if (args.suggestQboAccounts !== false && transactions.length) {
        try {
          const ctx = await loadSuggestionContext();
          transactions = suggestQboAccounts(transactions, { ...ctx, feedLines });
          const byId = new Map(transactions.map((t) => [t.id, t]));
          accounts = accounts.map((a) => ({
            ...a,
            transactions: a.transactions.map((t) => byId.get(t.id) || t),
          }));
          coaSuggestions = {
            coaAccounts: ctx.accounts.length,
            historyPurchases: ctx.history.length,
            historyError: ctx.historyError,
          };
        } catch (err) {
          out.errors.push({ section: 'bankFeed.coaSuggestions', error: err.message });
        }
      }
      out.bankFeed = {
        count: staging.transactionCount,
        policy: staging.policy,
        accounts,
        transactions,
        qboMatch: qboMatchSummary,
        coaSuggestions,
        simplefin: getSimpleFinCacheInfo(),
        ...(args.includeMatched
          ? {
              matched: feedLines
                .filter((t) => t.alreadyInQbo)
                .map((t) => ({
                  id: t.id,
                  accountName: t.accountName,
                  date: t.date,
                  amount: t.amount,
                  description: t.description,
                  qboMatch: t.qboMatch,
                })),
            }
          : {}),
      };
    } catch (err) {
      out.errors.push({ section: 'bankFeed', error: err.message });
    }
  }

  if (wantCash) {
    try {
      out.qbo.cashBalances = await getQboCashSummary();
    } catch (err) {
      out.errors.push({ section: 'qbo.cashBalances', error: err.message });
    }
  }

  if (wantAccounts) {
    try {
      const accounts = await getQboAccounts({
        filter: args.accountFilter,
        accountType: args.accountType,
      });
      out.qbo.accounts = { count: accounts.length, accounts };
    } catch (err) {
      out.errors.push({ section: 'qbo.accounts', error: err.message });
    }
  }

  if (wantSherwin) {
    try {
      const bills = await getSherwinWilliamsBills({
        maxResults: args.sherwinLimit ?? 15,
      });
      out.qbo.sherwinBills = { count: bills.length, bills };
    } catch (err) {
      out.errors.push({ section: 'qbo.sherwinBills', error: err.message });
    }
  }

  if (wantPnl) {
    try {
      out.qbo.profitAndLoss = await getQboProfitAndLoss({
        startDate: args.pnlStartDate || args.startDate,
        endDate: args.pnlEndDate || args.endDate,
      });
    } catch (err) {
      out.errors.push({ section: 'qbo.profitAndLoss', error: err.message });
    }
  }

  if (jobberActions.length) {
    try {
      out.jobber = await runJobberBatch(jobberActions);
    } catch (err) {
      out.errors.push({ section: 'jobber', error: err.message });
    }
  }

  return out;
}

/** MCP tool descriptors for ListTools — slim surface to minimize Spark Allows */
export const toolDefinitions = [
  {
    name: 'jobber_batch',
    description:
      'PREFERRED Jobber tool. ONE Allow for many ops: search_clients, search_quotes, search_requests, search_jobs, search_invoices, get_job/invoice/quote, create_client, create_quote, update_quote, create/delete expense, schedule_visit. For voice quote meetings prefer quote_meeting (plans client+quote create/update). create_client and create_quote ARE supported — do not claim they are missing. Does NOT write to QuickBooks.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: `Jobber operations to run in order. op must be one of: ${JOBBER_OPS.join(', ')}`,
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                description: `Operation name: ${JOBBER_OPS.join(' | ')}`,
              },
              // Common fields (validated per-op at runtime)
              jobNumber: { type: 'string' },
              query: { type: 'string' },
              limit: { type: 'number' },
              clientName: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string' },
              invoiceNumber: { type: 'string' },
              jobId: { type: 'string' },
              invoiceId: { type: 'string' },
              quoteId: { type: 'string' },
              expenseId: { type: 'string' },
              clientId: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              companyName: { type: 'string' },
              isCompany: { type: 'boolean' },
              isLead: { type: 'boolean' },
              email: { type: 'string' },
              phone: { type: 'string' },
              note: { type: 'string' },
              billingAddress: { type: 'object' },
              title: { type: 'string' },
              message: { type: 'string' },
              depositAmount: { type: 'number' },
              propertyId: { type: 'string' },
              requestId: { type: 'string' },
              lineItems: { type: 'array' },
              replaceLineItems: { type: 'boolean' },
              amount: { type: 'number' },
              description: { type: 'string' },
              date: { type: 'string' },
              linkedJobId: { type: 'string' },
              startAt: { type: 'string' },
              endAt: { type: 'string' },
              instructions: { type: 'string' },
              assignedUserIds: {
                type: 'array',
                items: { type: 'string' },
              },
              allDay: { type: 'boolean' },
            },
            required: ['op'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'quote_meeting',
    description:
      'PREFERRED after summarizing a client quote-meeting voice recording. ONE Allow: search clients/quotes/requests, decide whether to create or reuse a client and whether to update an existing draft quote or create a new one, then optionally write the Jobber draft (apply:true) so it is ready to review/send. Pass clientName/street/phone/email/title/message/lineItems from the transcript. Dry-run with apply:false first if unsure.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          description:
            'false (default) = plan only; true = create/update client+quote in Jobber',
        },
        clientId: { type: 'string', description: 'Force use this client id' },
        quoteId: { type: 'string', description: 'Force update this quote id' },
        requestId: {
          type: 'string',
          description:
            'Jobber request id (EncodedId or numeric, e.g. 34791561) to convert into the quote',
        },
        clientName: {
          type: 'string',
          description: 'Full name from transcript (e.g. Tim Urbanski)',
        },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        companyName: { type: 'string' },
        isCompany: { type: 'boolean' },
        isLead: { type: 'boolean' },
        email: { type: 'string' },
        phone: { type: 'string' },
        street: {
          type: 'string',
          description: 'Job site street (e.g. Fountain View Drive)',
        },
        billingAddress: { type: 'object' },
        propertyAddress: { type: 'object' },
        propertyId: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
        meetingNotes: {
          type: 'string',
          description: 'Short Gemini summary of the recording',
        },
        depositAmount: { type: 'number' },
        lineItems: {
          type: 'array',
          description:
            'Quote lines: [{ name, description, quantity, unitPrice, taxable }]',
          items: { type: 'object' },
        },
        replaceLineItems: {
          type: 'boolean',
          description:
            'When updating a quote, replace existing lines (default true if lineItems provided)',
        },
      },
    },
  },
  {
    name: 'bookkeeping_review',
    description:
      'PREFERRED read-only CFO snapshot for scheduled reports. ONE Allow fetches bank feed (SimpleFIN) with staging Notes & Treatment per transaction, QBO cash balances, optional accounts/P&L/Sherwin bills, and optional Jobber lookups via jobberActions. Credit-card refunds/credits are annotated qboWriteTool qbo_create_cc_credit (original expense account). Does NOT create/edit/delete anything in QuickBooks — use qbo_create_* / qbo_delete_transaction for writes (separate Allow).',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Bank feed / P&L lower bound YYYY-MM-DD',
        },
        endDate: {
          type: 'string',
          description: 'Optional P&L end date YYYY-MM-DD',
        },
        accountId: {
          type: 'string',
          description: 'Optional SimpleFIN account id filter',
        },
        includeProcessed: {
          type: 'boolean',
          description:
            'Include email-seen bank txs (SIMPLEFIN_PROCESSED_IDS; default false)',
        },
        excludeBookedInQbo: {
          type: 'boolean',
          description:
            'Exclude SimpleFIN rows that already match a QBO Purchase/Deposit/Transfer (default true). This is the real outstanding filter.',
        },
        includeMatched: {
          type: 'boolean',
          description:
            'Also return bankFeed.matched: feed lines already in QBO with the QBO record they matched (duplicate audit)',
        },
        suggestQboAccounts: {
          type: 'boolean',
          description:
            'Map each line to an existing QBO COA account via payee history (default true)',
        },
        markSeen: {
          type: 'boolean',
          description: 'Mark returned bank txs as processed (default false)',
        },
        includeBankFeed: {
          type: 'boolean',
          description: 'Include SimpleFIN bank feed (default true)',
        },
        includeCashBalances: {
          type: 'boolean',
          description: 'Include QBO cash/LOC/CC balances (default true)',
        },
        includeAccounts: {
          type: 'boolean',
          description: 'Include QBO account list (default false)',
        },
        accountFilter: {
          type: 'string',
          description: 'Optional account name substring when includeAccounts',
        },
        accountType: {
          type: 'string',
          description: 'Optional AccountType filter when includeAccounts',
        },
        includeSherwinBills: {
          type: 'boolean',
          description: 'Include Sherwin-Williams bills (default true)',
        },
        sherwinLimit: {
          type: 'number',
          description: 'Max Sherwin bills (default 15)',
        },
        includeProfitAndLoss: {
          type: 'boolean',
          description: 'Include QBO P&L (default false)',
        },
        pnlStartDate: { type: 'string' },
        pnlEndDate: { type: 'string' },
        jobberActions: {
          type: 'array',
          description:
            'Optional Jobber ops to include in this same Allow (same shape as jobber_batch.actions)',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'qbo_create_expense',
    description:
      'WRITE to QuickBooks: create a Purchase (check/CC charge only — positive expense amounts). Never use for credit-card refunds/credits (positive amounts on a CC account) — use qbo_create_cc_credit. Requires its own Allow — do not batch with Jobber.',
    inputSchema: {
      type: 'object',
      properties: {
        paymentAccountId: {
          type: 'string',
          description: 'QBO bank or credit-card Account Id used to pay',
        },
        categoryAccountId: {
          type: 'string',
          description: 'QBO expense Account Id for categorization',
        },
        amount: { type: 'number', description: 'Expense amount' },
        txnDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        payeeName: { type: 'string', description: 'Vendor / payee name' },
        memo: { type: 'string', description: 'Memo / private note' },
        paymentType: {
          type: 'string',
          description: "Optional: 'Check' or 'CreditCard' (auto-inferred if omitted)",
        },
      },
      required: ['paymentAccountId', 'categoryAccountId', 'amount'],
    },
  },
  {
    name: 'qbo_create_cc_credit',
    description:
      'WRITE to QuickBooks: create a Credit Card Credit (refund/return on a credit card) booked back to the original expense account. Refuses if the card already has a same-amount record within ±1 day (returns status skipped_duplicate). After posting, the Banking feed line should be MATCHED, not added. Requires its own Allow.',
    inputSchema: {
      type: 'object',
      properties: {
        creditCardAccountId: {
          type: 'string',
          description: 'QBO Credit Card Account Id that received the refund',
        },
        categoryAccountId: {
          type: 'string',
          description: 'QBO expense Account Id of the original purchase (refund offsets it)',
        },
        amount: { type: 'number', description: 'Refund amount (positive)' },
        txnDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        payeeName: { type: 'string', description: 'Vendor / payee name (optional)' },
        memo: { type: 'string', description: 'Memo / private note' },
        allowDuplicate: {
          type: 'boolean',
          description: 'Skip the ±1 day duplicate check (default false)',
        },
      },
      required: ['creditCardAccountId', 'categoryAccountId', 'amount'],
    },
  },
  {
    name: 'qbo_create_deposit',
    description:
      'WRITE to QuickBooks: create a Bank Deposit into a checking/bank account (owner loans, non-invoice income). Never use for credit-card refunds — CC credits are not bank deposits; use qbo_create_cc_credit. Requires its own Allow — do not batch with Jobber.',
    inputSchema: {
      type: 'object',
      properties: {
        depositAccountId: {
          type: 'string',
          description: 'QBO bank/checking Account Id receiving the deposit',
        },
        sourceAccountId: {
          type: 'string',
          description:
            'QBO source Account Id (e.g. Loan from Shareholder, Other Income)',
        },
        amount: { type: 'number', description: 'Deposit amount' },
        txnDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        payeeName: {
          type: 'string',
          description: 'Optional received-from name (Vendor or Customer)',
        },
        memo: { type: 'string', description: 'Memo / private note' },
      },
      required: ['depositAccountId', 'sourceAccountId', 'amount'],
    },
  },
  {
    name: 'qbo_create_transfer',
    description:
      'WRITE to QuickBooks: transfer between accounts (CC autopay Checking→Capital One, LOC draw/paydown). Preferred API write for credit-card payments. Requires its own Allow.',
    inputSchema: {
      type: 'object',
      properties: {
        fromAccountId: {
          type: 'string',
          description: 'QBO Account Id money leaves',
        },
        toAccountId: {
          type: 'string',
          description: 'QBO Account Id money enters',
        },
        amount: { type: 'number', description: 'Transfer amount' },
        txnDate: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        memo: { type: 'string', description: 'Memo / private note' },
      },
      required: ['fromAccountId', 'toAccountId', 'amount'],
    },
  },
  {
    name: 'qbo_delete_transaction',
    description:
      'WRITE to QuickBooks: delete a Purchase or Deposit. Requires its own Allow.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: {
          type: 'string',
          description: 'QBO transaction Id',
        },
        transactionType: {
          type: 'string',
          description: "'purchase' or 'deposit'",
        },
      },
      required: ['transactionId', 'transactionType'],
    },
  },
  {
    name: 'bookkeeping_mark_seen',
    description:
      'After Brennan approves/skips numbered staging lines in Cursor chat: mark those SimpleFIN transaction ids as processed so the next morning brief does not re-list them. Does NOT write to QuickBooks. Use durable:true to persist ids across Render deploys. For feed-only lines (doNotPostViaApi), approve means clear in the QBO Banking feed — do not also call qbo_create_* (that would duplicate).',
    inputSchema: {
      type: 'object',
      properties: {
        transactionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'SimpleFIN transaction ids (TRN-...) from the brief',
        },
        durable: {
          type: 'boolean',
          description:
            'Persist SIMPLEFIN_PROCESSED_IDS to Render env (default true)',
        },
      },
      required: ['transactionIds'],
    },
  },
  {
    name: 'email_bookkeeping_brief',
    description:
      'STAGE-ONLY: run bookkeeping_review (bank staging + cash, no QBO writes), email a numbered §1/§2/§3 brief to BOOKKEEPING_NOTIFY_EMAIL (bootstrap: brevee12@gmail.com via Resend onboarding@resend.dev). Includes CURSOR_AGENT_URL for approve-by-number in Cursor chat — not Slack. Health-gated when SimpleFIN/QBO/Resend missing. Use dryRun to preview without sending.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Override recipient (default BOOKKEEPING_NOTIFY_EMAIL / brevee12@gmail.com)',
        },
        startDate: {
          type: 'string',
          description:
            'Bank feed lower bound YYYY-MM-DD (default: last 45 days — current feed window)',
        },
        includeProcessed: {
          type: 'boolean',
          description:
            'Include email-seen bank txs (default false — morning stage-only)',
        },
        excludeBookedInQbo: {
          type: 'boolean',
          description:
            'Exclude rows already booked in QBO (default true)',
        },
        includeSherwinBills: {
          type: 'boolean',
          description: 'Include Sherwin bills sample (default true)',
        },
        maxItems: {
          type: 'number',
          description: 'Max numbered staging lines in the email (default 80)',
        },
        agentUrl: {
          type: 'string',
          description:
            'Cursor agent/chat URL for approve-by-number (default CURSOR_AGENT_URL)',
        },
        dryRun: {
          type: 'boolean',
          description: 'Format brief only; do not call Resend (default false)',
        },
        skipHealthGate: {
          type: 'boolean',
          description: 'Skip SimpleFIN/QBO/Resend preflight (default false)',
        },
      },
    },
  },
];

/** Dispatch a tool call by name */
export async function callTool(name, args = {}) {
  try {
    switch (name) {
      case 'jobber_batch': {
        const batch = await runJobberBatch(args.actions);
        return ok(batch);
      }

      case 'quote_meeting': {
        const meeting = await runQuoteMeeting(args);
        return ok(meeting);
      }

      case 'bookkeeping_review': {
        const review = await runBookkeepingReview(args);
        return ok(review);
      }

      case 'email_bookkeeping_brief': {
        const result = await runBookkeepingNotify({
          runReview: runBookkeepingReview,
          to: args.to,
          agentUrl: args.agentUrl,
          dryRun: Boolean(args.dryRun),
          skipHealthGate: Boolean(args.skipHealthGate),
          maxItems: args.maxItems,
          reviewArgs: {
            startDate: args.startDate,
            includeProcessed: Boolean(args.includeProcessed),
            excludeBookedInQbo: args.excludeBookedInQbo,
            includeSherwinBills: args.includeSherwinBills,
          },
        });
        return ok(result);
      }

      case 'bookkeeping_mark_seen': {
        const ids = Array.isArray(args.transactionIds)
          ? args.transactionIds
          : [];
        if (!ids.length) {
          throw new Error('transactionIds required');
        }
        const durable = args.durable !== false;
        const result = durable
          ? await markTransactionsProcessedDurable(ids)
          : {
              count: markTransactionsProcessed(ids),
              added: ids.length,
              ids: listProcessedTransactionIds(),
              durable: null,
            };
        return ok({
          ...result,
          marked: ids.map(String),
          note: 'Marked seen for email dedupe only — no QuickBooks writes.',
        });
      }

      // --- QBO writes (separate Allows) ---
      case 'qbo_create_expense': {
        const created = await postQboExpense({
          paymentAccountId: args.paymentAccountId,
          categoryAccountId: args.categoryAccountId,
          amount: args.amount,
          txnDate: args.txnDate,
          payeeName: args.payeeName,
          memo: args.memo,
          paymentType: args.paymentType,
        });
        return ok(created);
      }

      case 'qbo_create_cc_credit': {
        const credit = await postQboCreditCardCredit({
          creditCardAccountId: args.creditCardAccountId,
          categoryAccountId: args.categoryAccountId,
          amount: args.amount,
          txnDate: args.txnDate,
          payeeName: args.payeeName,
          memo: args.memo,
          allowDuplicate: Boolean(args.allowDuplicate),
        });
        return ok(credit);
      }

      case 'qbo_create_deposit': {
        const deposit = await postQboDeposit({
          depositAccountId: args.depositAccountId,
          sourceAccountId: args.sourceAccountId,
          amount: args.amount,
          txnDate: args.txnDate,
          payeeName: args.payeeName,
          memo: args.memo,
        });
        return ok(deposit);
      }

      case 'qbo_create_transfer': {
        const transfer = await postQboTransfer({
          fromAccountId: args.fromAccountId,
          toAccountId: args.toAccountId,
          amount: args.amount,
          txnDate: args.txnDate,
          memo: args.memo,
        });
        return ok(transfer);
      }

      case 'qbo_delete_transaction': {
        const deleted = await deleteQboTransaction({
          transactionId: args.transactionId,
          transactionType: args.transactionType,
        });
        return ok(deleted);
      }

      // --- Legacy aliases (hidden from ListTools; still work if Spark caches old names) ---
      case 'get_jobber_invoice':
        return ok(await getInvoice(args.invoice_id));
      case 'create_jobber_expense':
        return ok(
          await createExpense({
            amount: args.amount,
            description: args.description,
            title: args.title,
            date: args.date,
            linkedJobId: args.linked_job_id,
          })
        );
      case 'jobber_search_jobs': {
        const jobs = await searchJobs({
          jobNumber: args.jobNumber,
          query: args.query,
          limit: args.limit,
        });
        return ok({ count: jobs.length, jobs });
      }
      case 'jobber_create_client':
        return ok(
          await createClient({
            firstName: args.firstName,
            lastName: args.lastName,
            companyName: args.companyName,
            isCompany: args.isCompany,
            isLead: args.isLead,
            email: args.email,
            phone: args.phone,
            note: args.note,
            billingAddress: args.billingAddress,
          })
        );
      case 'jobber_create_quote':
        return ok(
          await createQuote({
            clientId: args.clientId,
            title: args.title,
            message: args.message,
            depositAmount: args.depositAmount,
            propertyId: args.propertyId,
            lineItems: args.lineItems,
          })
        );
      case 'jobber_delete_expense':
        return ok(await deleteExpense(args.expenseId));
      case 'jobber_schedule_visit':
        return ok(
          await createVisit({
            jobId: args.jobId,
            startAt: args.startAt,
            endAt: args.endAt,
            title: args.title,
            instructions: args.instructions,
            assignedUserIds: args.assignedUserIds,
            allDay: args.allDay,
          })
        );
      case 'jobber_get_job':
        return ok(await getJob(args.jobId));
      case 'jobber_search_invoices':
        return ok(
          await searchInvoices({
            clientName: args.clientName,
            status: args.status,
            invoiceNumber: args.invoiceNumber,
            query: args.query,
            limit: args.limit,
          })
        );
      case 'jobber_get_quote':
        return ok(await getQuote(args.quoteId));
      case 'bank_feed_fetch': {
        const txs = await fetchSimpleFinTransactions({
          startDate: args.startDate,
          accountId: args.accountId,
          includeProcessed: Boolean(args.includeProcessed),
        });
        if (args.markSeen && txs.length) {
          markTransactionsProcessed(txs.map((t) => t.id));
        }
        return ok({ count: txs.length, transactions: txs });
      }
      case 'qbo_get_sherwin_bills': {
        const bills = await getSherwinWilliamsBills({
          maxResults: args.limit ?? 15,
        });
        return ok({ count: bills.length, bills });
      }
      case 'qbo_get_accounts': {
        const accounts = await getQboAccounts({
          filter: args.filter,
          accountType: args.accountType,
        });
        return ok({ count: accounts.length, accounts });
      }
      case 'qbo_get_cash_balances':
        return ok(await getQboCashSummary());
      case 'qbo_get_profit_and_loss':
        return ok(
          await getQboProfitAndLoss({
            startDate: args.startDate,
            endDate: args.endDate,
          })
        );

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
}
