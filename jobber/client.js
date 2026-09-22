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

const CREATE_CLIENT = `
  mutation CreateClient($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id
        firstName
        lastName
        companyName
        name
        isLead
        jobberWebUri
        createdAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const CREATE_QUOTE = `
  mutation CreateQuote($input: QuoteCreateInput!) {
    quoteCreate(input: $input) {
      quote {
        id
        quoteNumber
        quoteStatus
        title
        message
        amounts {
          subtotal
          total
          depositAmount
        }
        client {
          id
          name
        }
        createdAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const CREATE_QUOTE_LINE_ITEMS = `
  mutation AddQuoteLineItems($quoteId: EncodedId!, $lineItems: QuoteCreateLineItemsAttributes!) {
    quoteCreateLineItems(quoteId: $quoteId, lineItems: $lineItems) {
      lineItems {
        id
        name
        description
        quantity
        unitPrice
        totalPrice
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Create a Jobber client (person or company).
 */
export async function createClient({
  firstName,
  lastName,
  companyName,
  isCompany,
  isLead,
  email,
  phone,
  note,
  billingAddress,
} = {}) {
  const input = {};

  if (firstName) input.firstName = firstName;
  if (lastName) input.lastName = lastName;
  if (companyName) input.companyName = companyName;
  if (typeof isCompany === 'boolean') input.isCompany = isCompany;
  else if (companyName && !firstName && !lastName) input.isCompany = true;
  if (typeof isLead === 'boolean') input.isLead = isLead;
  if (note) input.note = note;

  if (email) {
    input.emails = [
      { address: String(email), primary: true, description: 'MAIN' },
    ];
  }

  if (phone) {
    input.phones = [
      { number: String(phone), primary: true, description: 'MAIN' },
    ];
  }

  if (billingAddress && typeof billingAddress === 'object') {
    input.billingAddress = billingAddress;
  }

  if (!input.firstName && !input.lastName && !input.companyName) {
    throw new Error('Provide at least firstName/lastName or companyName');
  }

  const data = await jobberGraphql(CREATE_CLIENT, { input });
  const result = data?.clientCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  return result.client;
}

/**
 * Create a Jobber quote for a client; optionally add line items.
 */
export async function createQuote({
  clientId,
  title,
  message,
  depositAmount,
  propertyId,
  lineItems = [],
} = {}) {
  if (!clientId) throw new Error('clientId is required');

  const input = { clientId: String(clientId) };
  if (title) input.title = title;
  if (message) input.message = message;
  if (depositAmount != null) input.depositAmount = Number(depositAmount);
  if (propertyId) input.propertyId = String(propertyId);

  const data = await jobberGraphql(CREATE_QUOTE, { input });
  const result = data?.quoteCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  const quote = result.quote;
  let createdLineItems = [];

  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const normalized = lineItems.map((item) => {
      const row = {
        name: item.name || item.description || 'Line item',
        quantity: item.quantity != null ? Number(item.quantity) : 1,
        unitPrice: Number(item.unitPrice ?? item.price ?? 0),
      };
      if (item.description) row.description = item.description;
      if (typeof item.taxable === 'boolean') row.taxable = item.taxable;
      return row;
    });

    const lineData = await jobberGraphql(CREATE_QUOTE_LINE_ITEMS, {
      quoteId: quote.id,
      lineItems: { lineItems: normalized },
    });
    const lineResult = lineData?.quoteCreateLineItems;

    if (lineResult?.userErrors?.length) {
      throw new Error(
        `Quote created (${quote.id}) but line items failed: ` +
          lineResult.userErrors.map((e) => e.message).join('; ')
      );
    }

    createdLineItems = lineResult?.lineItems || [];
  }

  return {
    ...quote,
    lineItems: createdLineItems,
  };
}
