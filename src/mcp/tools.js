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
} from '../../jobber/client.js';
import {
  fetchSimpleFinTransactions,
  markTransactionsProcessed,
} from '../services/simplefin.js';
import { buildStagingReport } from '../services/bankStaging.js';
import {
  getSherwinWilliamsBills,
  postQboExpense,
  postQboDeposit,
  postQboCreditCardCredit,
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
  'get_job',
  'get_invoice',
  'get_quote',
  'create_client',
  'create_quote',
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
        lineItems: action.lineItems,
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

const QBO_WRITE_OPS = [
  'create_expense',
  'create_deposit',
  'create_credit_card_credit',
  'create_transfer',
  'delete_transaction',
];

/**
 * Run one QBO write op. Throws on failure (caller records per-action errors).
 */
async function runQboAction(action = {}) {
  const op = String(action.op || action.action || '').trim();
  if (!op) throw new Error('Each action needs op');

  switch (op) {
    case 'create_expense':
      return postQboExpense({
        paymentAccountId: action.paymentAccountId,
        categoryAccountId: action.categoryAccountId,
        amount: action.amount,
        txnDate: action.txnDate,
        payeeName: action.payeeName,
        memo: action.memo,
        paymentType: action.paymentType,
      });
    case 'create_deposit':
      return postQboDeposit({
        depositAccountId: action.depositAccountId,
        sourceAccountId: action.sourceAccountId,
        amount: action.amount,
        txnDate: action.txnDate,
        payeeName: action.payeeName,
        memo: action.memo,
      });
    case 'create_credit_card_credit':
    case 'credit_card_credit':
      return postQboCreditCardCredit({
        paymentAccountId: action.paymentAccountId || action.accountId,
        categoryAccountId: action.categoryAccountId,
        amount: action.amount,
        txnDate: action.txnDate,
        payeeName: action.payeeName || action.vendorName,
        memo: action.memo,
      });
    case 'create_transfer':
      return postQboTransfer({
        fromAccountId: action.fromAccountId,
        toAccountId: action.toAccountId,
        amount: action.amount,
        txnDate: action.txnDate,
        memo: action.memo,
      });
    case 'delete_transaction':
      return deleteQboTransaction({
        transactionId: action.transactionId || action.id,
        transactionType: action.transactionType,
      });
    default:
      throw new Error(
        `Unknown QBO op "${op}". Use one of: ${QBO_WRITE_OPS.join(', ')}`
      );
  }
}

/**
 * Execute many QBO writes under a single MCP Allow.
 * Continues after per-action failures so one bad row doesn't abort the batch.
 */
export async function runQboBatch(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('Provide actions: [{ op, ...params }, ...]');
  }
  if (actions.length > 40) {
    throw new Error('Max 40 QBO write actions per batch');
  }

  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] || {};
    const op = action.op || action.action || null;
    try {
      const data = await runQboAction(action);
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
 * Does NOT write to QuickBooks (QBO writes stay on qbo_batch).
 */
async function runBookkeepingReview(args = {}) {
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
      const txs = await fetchSimpleFinTransactions({
        startDate: args.startDate,
        accountId: args.accountId,
        includeProcessed: Boolean(args.includeProcessed),
      });
      if (args.markSeen && txs.length) {
        markTransactionsProcessed(txs.map((t) => t.id));
      }
      // Staging annotations tell Spark how to clear each row (esp. CC refunds).
      const staging = buildStagingReport(txs);
      out.bankFeed = {
        count: staging.transactionCount,
        policy: staging.policy,
        accounts: staging.accounts,
        transactions: staging.transactions,
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
      'PREFERRED Jobber tool. Run multiple Jobber reads/writes in ONE call (one Allow): search jobs, search invoices, get job/invoice/quote, create client/quote/expense, delete expense, schedule visit. Pass actions: [{ op, ...fields }]. Bundle every Jobber change for the session here — do not call one-off Jobber tools. Does NOT write to QuickBooks (use qbo_batch).',
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
              lineItems: { type: 'array' },
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
    name: 'bookkeeping_review',
    description:
      'PREFERRED read-only CFO snapshot for scheduled reports. ONE Allow fetches bank feed (SimpleFIN) with staging Notes & Treatment per transaction, QBO cash balances, optional accounts/P&L/Sherwin bills, and optional Jobber lookups via jobberActions. Credit-card refunds/credits are annotated doNotPostViaApi — prefer clearing those in the QBO Banking feed; only use qbo_batch create_credit_card_credit when intentionally posting ahead of the feed. Does NOT create/edit/delete anything in QuickBooks — apply writes with qbo_batch (one Allow for the whole posting set).',
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
          description: 'Include already-seen bank txs (default false)',
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
    name: 'qbo_batch',
    description:
      'PREFERRED QuickBooks WRITE tool. Post many expenses/deposits/CC credits/transfers/deletes in ONE call (one Allow). Pass actions: [{ op, ...fields }] where op is create_expense | create_deposit | create_credit_card_credit | create_transfer | delete_transaction. Bundle every QBO posting for the session here instead of one tool call per transaction. Skip rows marked doNotPostViaApi from bookkeeping_review when the Banking feed line is still open (CC refunds → match in feed preferred; create_credit_card_credit only ahead-of-feed). Does NOT call Jobber (use jobber_batch).',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: `QBO write ops in order (max 40). op must be one of: ${QBO_WRITE_OPS.join(', ')}`,
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                description: `Operation: ${QBO_WRITE_OPS.join(' | ')}. create_credit_card_credit = Purchase with PaymentType CreditCard + Credit:true (card refunds; positive amount).`,
              },
              paymentAccountId: {
                type: 'string',
                description:
                  'For create_expense / create_credit_card_credit: bank or credit-card account Id (CC liability for refunds).',
              },
              categoryAccountId: {
                type: 'string',
                description:
                  'Expense/category account Id (for CC refunds: same account as the original purchase).',
              },
              depositAccountId: { type: 'string' },
              sourceAccountId: { type: 'string' },
              fromAccountId: { type: 'string' },
              toAccountId: { type: 'string' },
              amount: {
                type: 'number',
                description:
                  'Positive amount. For create_credit_card_credit, sign is ignored (absolute value used with Credit:true).',
              },
              txnDate: { type: 'string' },
              payeeName: { type: 'string' },
              memo: { type: 'string' },
              paymentType: { type: 'string' },
              transactionId: { type: 'string' },
              transactionType: { type: 'string' },
            },
            required: ['op'],
          },
        },
      },
      required: ['actions'],
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

      case 'bookkeeping_review': {
        const review = await runBookkeepingReview(args);
        return ok(review);
      }

      case 'qbo_batch': {
        const batch = await runQboBatch(args.actions);
        return ok(batch);
      }

      // --- Legacy single QBO writes (hidden from ListTools; still work if Spark caches old names) ---
      case 'qbo_create_expense': {
        const created = await runQboAction({
          op: 'create_expense',
          ...args,
        });
        return ok(created);
      }

      case 'qbo_create_deposit': {
        const deposit = await runQboAction({
          op: 'create_deposit',
          ...args,
        });
        return ok(deposit);
      }

      case 'qbo_create_credit_card_credit': {
        const credit = await runQboAction({
          op: 'create_credit_card_credit',
          ...args,
        });
        return ok(credit);
      }

      case 'qbo_create_transfer': {
        const transfer = await runQboAction({
          op: 'create_transfer',
          ...args,
        });
        return ok(transfer);
      }

      case 'qbo_delete_transaction': {
        const deleted = await runQboAction({
          op: 'delete_transaction',
          ...args,
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
