import { getInvoice, createExpense } from '../../jobber/client.js';
import {
  fetchSimpleFinTransactions,
  markTransactionsProcessed,
} from '../services/simplefin.js';
import {
  getSherwinWilliamsBills,
  postQboExpense,
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
