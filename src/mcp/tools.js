import { getInvoice, createExpense, searchJobs, createClient, createQuote } from '../../jobber/client.js';
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

/** MCP tool descriptors for ListTools */
export const toolDefinitions = [
  {
    name: 'get_jobber_invoice',
    description: 'Gets invoice details from Jobber by invoice ID (GraphQL EncodedId)',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: {
          type: 'string',
          description: 'The Jobber invoice EncodedId',
        },
      },
      required: ['invoice_id'],
    },
  },
  {
    name: 'create_jobber_expense',
    description: 'Logs a business expense in Jobber',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Expense total' },
        description: { type: 'string', description: 'Expense description' },
        title: { type: 'string', description: 'Optional short title' },
        date: {
          type: 'string',
          description: 'Optional ISO-8601 date (defaults to now)',
        },
        linked_job_id: {
          type: 'string',
          description: 'Optional Jobber job EncodedId to link',
        },
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'jobber_search_jobs',
    description:
      'Search Jobber jobs by job number or free-text query; returns jobId, jobNumber, title, clientName, status',
    inputSchema: {
      type: 'object',
      properties: {
        jobNumber: {
          type: 'string',
          description: 'Job number to match (preferred when known)',
        },
        query: {
          type: 'string',
          description: 'Free-text search (client name, title, etc.)',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 25, max 50)',
        },
      },
    },
  },
  {
    name: 'jobber_create_client',
    description:
      'Create a new Jobber client (person or company) with optional email, phone, and billing address',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        companyName: { type: 'string' },
        isCompany: { type: 'boolean', description: 'True for a company client' },
        isLead: { type: 'boolean', description: 'True to mark as a lead' },
        email: { type: 'string', description: 'Primary email address' },
        phone: { type: 'string', description: 'Primary phone number' },
        note: { type: 'string' },
        billingAddress: {
          type: 'object',
          description: 'Optional billing address fields',
          properties: {
            street1: { type: 'string' },
            street2: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'jobber_create_quote',
    description:
      'Create a Jobber quote for a client; optionally add line items (name, quantity, unitPrice)',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'Jobber client EncodedId',
        },
        title: { type: 'string' },
        message: { type: 'string', description: 'Message shown on the quote' },
        depositAmount: { type: 'number' },
        propertyId: {
          type: 'string',
          description: 'Optional property EncodedId',
        },
        lineItems: {
          type: 'array',
          description: 'Optional quote line items',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
              taxable: { type: 'boolean' },
            },
            required: ['name', 'unitPrice'],
          },
        },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'bank_feed_fetch',
    description:
      'Fetch unrecorded bank transactions from SimpleFIN (Marion County Bank / Capital One). Amounts: negative = money out, positive = money in.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Optional YYYY-MM-DD lower bound',
        },
        accountId: {
          type: 'string',
          description: 'Optional SimpleFIN account id filter',
        },
        includeProcessed: {
          type: 'boolean',
          description: 'If true, include already-seen transaction IDs (default false)',
        },
        markSeen: {
          type: 'boolean',
          description:
            'If true, mark returned transaction IDs as processed after fetch (default false)',
        },
      },
    },
  },
  {
    name: 'qbo_get_sherwin_bills',
    description:
      'List recent Sherwin-Williams PRO+ bills from QuickBooks (Vendor 24), with PO# / Job# parsed from memo',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max bills to return (default 15)',
        },
      },
    },
  },
  {
    name: 'qbo_create_expense',
    description:
      'Create a QuickBooks Purchase (bank check or credit card charge) with an expense category line',
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
      'Create a QuickBooks Bank Deposit for incoming funds (owner loans, refunds, non-invoice income). Credits the deposit (bank) account from a source account such as Loan from Shareholder.',
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
      'Transfer funds between QuickBooks accounts (credit card payments, LOC draws/paydowns)',
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
      'Delete a QuickBooks Purchase or Deposit by Id (loads SyncToken then posts operation=delete)',
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
    name: 'qbo_get_accounts',
    description:
      'List active QuickBooks accounts (id, name, type, subtype, balance), optionally filtered',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional case-insensitive name substring',
        },
        accountType: {
          type: 'string',
          description:
            "Optional AccountType / subtype filter (e.g. 'Bank', 'Credit Card', 'Expense')",
        },
      },
    },
  },
  {
    name: 'qbo_get_cash_balances',
    description:
      'Live QBO balances for Marion County checking, LOC, and Capital One credit cards',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'qbo_get_profit_and_loss',
    description: 'QuickBooks Profit & Loss report for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
];

/** Dispatch a tool call by name */
export async function callTool(name, args = {}) {
  try {
    switch (name) {
      case 'get_jobber_invoice': {
        const invoice = await getInvoice(args.invoice_id);
        return ok(invoice);
      }

      case 'create_jobber_expense': {
        const expense = await createExpense({
          amount: args.amount,
          description: args.description,
          title: args.title,
          date: args.date,
          linkedJobId: args.linked_job_id,
        });
        return ok(expense);
      }

      case 'jobber_search_jobs': {
        const jobs = await searchJobs({
          jobNumber: args.jobNumber,
          query: args.query,
          limit: args.limit,
        });
        return ok({ count: jobs.length, jobs });
      }

      case 'jobber_create_client': {
        const client = await createClient({
          firstName: args.firstName,
          lastName: args.lastName,
          companyName: args.companyName,
          isCompany: args.isCompany,
          isLead: args.isLead,
          email: args.email,
          phone: args.phone,
          note: args.note,
          billingAddress: args.billingAddress,
        });
        return ok(client);
      }

      case 'jobber_create_quote': {
        const quote = await createQuote({
          clientId: args.clientId,
          title: args.title,
          message: args.message,
          depositAmount: args.depositAmount,
          propertyId: args.propertyId,
          lineItems: args.lineItems,
        });
        return ok(quote);
      }

      case 'bank_feed_fetch': {
        const txs = await fetchSimpleFinTransactions({
          startDate: args.startDate,
          accountId: args.accountId,
          includeProcessed: Boolean(args.includeProcessed),
        });
        if (args.markSeen && txs.length) {
          markTransactionsProcessed(txs.map((t) => t.id));
        }
        return ok({
          count: txs.length,
          transactions: txs,
        });
      }

      case 'qbo_get_sherwin_bills': {
        const bills = await getSherwinWilliamsBills({
          maxResults: args.limit ?? 15,
        });
        return ok({ count: bills.length, bills });
      }

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

      case 'qbo_get_accounts': {
        const accounts = await getQboAccounts({
          filter: args.filter,
          accountType: args.accountType,
        });
        return ok({ count: accounts.length, accounts });
      }

      case 'qbo_get_cash_balances': {
        const summary = await getQboCashSummary();
        return ok(summary);
      }

      case 'qbo_get_profit_and_loss': {
        const report = await getQboProfitAndLoss({
          startDate: args.startDate,
          endDate: args.endDate,
        });
        return ok(report);
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
}
