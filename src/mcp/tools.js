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
import {
  getSherwinWilliamsBills,
  postQboExpense,
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

/**
 * Read-only bookkeeping snapshot for scheduled CFO reviews.
 * Does NOT write to QuickBooks (QBO writes stay on separate tools).
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
      out.bankFeed = { count: txs.length, transactions: txs };
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
      'PREFERRED Jobber tool. Run multiple Jobber reads/writes in ONE call (one Allow): search jobs, search invoices, get job/invoice/quote, create client/quote/expense, delete expense, schedule visit. Pass actions: [{ op, ...fields }]. Does NOT write to QuickBooks.',
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
      'PREFERRED read-only CFO snapshot for scheduled reports. ONE Allow fetches bank feed (SimpleFIN), QBO cash balances, optional accounts/P&L/Sherwin bills, and optional Jobber lookups via jobberActions. Does NOT create/edit/delete anything in QuickBooks — use qbo_create_* / qbo_delete_transaction for writes (those require their own Allow).',
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
    name: 'qbo_create_expense',
    description:
      'WRITE to QuickBooks: create a Purchase (check/CC charge). Requires its own Allow — do not batch with Jobber.',
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
    name: 'qbo_create_deposit',
    description:
      'WRITE to QuickBooks: create a Bank Deposit. Requires its own Allow — do not batch with Jobber.',
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
      'WRITE to QuickBooks: transfer between accounts (CC payment, LOC). Requires its own Allow.',
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
