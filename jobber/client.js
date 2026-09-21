import { loadTokens } from './tokenStore.js';
import { refreshAccessToken } from './oauth.js';

const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

function apiVersion() {
  return process.env.JOBBER_GRAPHQL_VERSION || '2025-04-16';
}

async function rawRequest(accessToken, query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': apiVersion(),
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await res.json().catch(() => ({}));

  if (res.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Jobber GraphQL HTTP ${res.status}: ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }

  return payload.data;
}

/**
 * Execute a Jobber GraphQL operation, refreshing the access token once on 401.
 */
export async function jobberGraphql(query, variables = {}) {
  let tokens = loadTokens();
  if (!tokens?.accessToken) {
    throw new Error('Jobber is not connected. Open /oauth/start to authorize.');
  }

  try {
    return await rawRequest(tokens.accessToken, query, variables);
  } catch (err) {
    if (err.status !== 401 || !tokens.refreshToken) throw err;

    tokens = await refreshAccessToken();
    return rawRequest(tokens.accessToken, query, variables);
  }
}

export const GET_INVOICE = `
  query GetInvoice($id: EncodedId!) {
    invoice(id: $id) {
      id
      invoiceNumber
      subject
      invoiceStatus
      issuedDate
      dueDate
      amounts {
        subtotal
        taxAmount
        total
        paymentsTotal
        balance
      }
      client {
        id
        name
      }
      lineItems(first: 50) {
        nodes {
          id
          name
          description
          quantity
          unitPrice
          totalPrice
        }
      }
    }
  }
`;

// Jobber's current schema uses expenseCreate(input: ...) — not the older `expense:` arg
export const CREATE_EXPENSE = `
  mutation CreateExpense($input: ExpenseCreateInput!) {
    expenseCreate(input: $input) {
      expense {
        id
        title
        description
        total
        date
        createdAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export async function getInvoice(invoiceId) {
  const data = await jobberGraphql(GET_INVOICE, { id: invoiceId });
  if (!data?.invoice) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }
  return data.invoice;
}

export async function createExpense({ amount, description, title, date, linkedJobId }) {
  const input = {
    title: title || description.slice(0, 80),
    description,
    total: amount,
    date: date || new Date().toISOString(),
  };

  if (linkedJobId) input.linkedJobId = linkedJobId;

  const data = await jobberGraphql(CREATE_EXPENSE, { input });
  const result = data?.expenseCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  return result.expense;
}

const SEARCH_JOBS = `
  query SearchJobs($first: Int!, $searchTerm: String) {
    jobs(first: $first, searchTerm: $searchTerm) {
      nodes {
        id
        jobNumber
        title
        jobStatus
        client {
          id
          name
        }
      }
    }
  }
`;

/**
 * Search Jobber jobs by jobNumber or free-text query.
 */
export async function searchJobs({ jobNumber, query, limit = 25 } = {}) {
  const searchTerm = (jobNumber != null && String(jobNumber).trim() !== '')
    ? String(jobNumber).trim()
    : (query || '').trim();

  if (!searchTerm) {
    throw new Error('Provide jobNumber or query to search Jobber jobs');
  }

  const first = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const data = await jobberGraphql(SEARCH_JOBS, { first, searchTerm });
  const nodes = data?.jobs?.nodes || [];

  let jobs = nodes.map((j) => ({
    jobId: j.id,
    jobNumber: j.jobNumber,
    title: j.title,
    clientName: j.client?.name || null,
    status: j.jobStatus,
  }));

  // If searching by job number, prefer exact / numeric matches first
  if (jobNumber != null && String(jobNumber).trim() !== '') {
    const target = String(jobNumber).trim();
    jobs = jobs
      .filter(
        (j) =>
          String(j.jobNumber) === target ||
          String(j.jobNumber).includes(target) ||
          String(j.title || '').includes(target)
      )
      .sort((a, b) => {
        const aExact = String(a.jobNumber) === target ? 0 : 1;
        const bExact = String(b.jobNumber) === target ? 0 : 1;
        return aExact - bExact;
      });
  }

  return jobs;
}
