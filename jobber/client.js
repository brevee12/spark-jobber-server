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
        invoiceBalance
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
  const invoice = data.invoice;
  if (invoice.amounts) {
    invoice.amounts = {
      ...invoice.amounts,
      balance: invoice.amounts.invoiceBalance ?? null,
    };
  }
  return invoice;
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
  mutation CreateQuote($attributes: QuoteCreateAttributes!) {
    quoteCreate(attributes: $attributes) {
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
        property {
          id
        }
        createdAt
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/** Some Jobber versions accept quoteCreate(input: ...) instead of attributes */
const CREATE_QUOTE_INPUT = `
  mutation CreateQuoteInput($input: QuoteCreateInput!) {
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
        property {
          id
        }
        createdAt
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const CREATE_QUOTE_LINE_ITEMS = `
  mutation AddQuoteLineItems($quoteId: EncodedId!, $lineItems: [QuoteCreateLineItemAttributes!]!) {
    quoteCreateLineItems(quoteId: $quoteId, lineItems: $lineItems) {
      quote {
        id
        quoteNumber
        lineItems(first: 50) {
          nodes {
            id
            name
            description
            quantity
            unitPrice
            totalPrice
            taxable
          }
        }
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
 * Jobber UI ids are numeric; GraphQL needs base64 EncodedId (gid://Jobber/Type/n).
 */
export function toJobberEncodedId(type, id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  if (!s) return null;
  // Already an EncodedId
  if (s.startsWith('Z2lkOi8v') || s.startsWith('gid://')) {
    if (s.startsWith('gid://')) {
      return Buffer.from(s, 'utf8').toString('base64');
    }
    return s;
  }
  if (/^\d+$/.test(s)) {
    if (!type) {
      throw new Error(
        `Numeric Jobber id ${s} needs a type (Client, Quote, Property, Request, …)`
      );
    }
    return Buffer.from(`gid://Jobber/${type}/${s}`, 'utf8').toString('base64');
  }
  return s;
}

function normalizeQuoteLineItems(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .filter(Boolean)
    .map((item) => {
      const row = {
        name: item.name || item.description || 'Line item',
        quantity: item.quantity != null ? Number(item.quantity) : 1,
        unitPrice: Number(item.unitPrice ?? item.price ?? 0),
        // Required non-null on QuoteCreateLineItemAttributes
        saveToProductsAndServices:
          typeof item.saveToProductsAndServices === 'boolean'
            ? item.saveToProductsAndServices
            : false,
      };
      if (item.description) row.description = item.description;
      if (typeof item.taxable === 'boolean') row.taxable = item.taxable;
      return row;
    });
}

/**
 * Create a Jobber quote for a client; optionally add line items.
 * Jobber rejects QuoteCreateAttributes when propertyId/lineItems are explicit null —
 * only send defined keys. Prefer embedding lineItems on create; fall back to
 * quoteCreateLineItems afterward.
 */
export async function createQuote({
  clientId,
  title,
  message,
  depositAmount,
  propertyId,
  requestId,
  lineItems = [],
} = {}) {
  const encodedClientId = toJobberEncodedId('Client', clientId);
  if (!encodedClientId) throw new Error('clientId is required');

  const normalizedLines = normalizeQuoteLineItems(lineItems);

  const baseAttributes = { clientId: encodedClientId };
  if (title) baseAttributes.title = String(title);
  if (message) baseAttributes.message = String(message);
  if (depositAmount != null && depositAmount !== '') {
    baseAttributes.depositAmount = Number(depositAmount);
  }

  const encodedPropertyId = toJobberEncodedId('Property', propertyId);
  if (encodedPropertyId) baseAttributes.propertyId = encodedPropertyId;

  const encodedRequestId = toJobberEncodedId('Request', requestId);
  if (encodedRequestId) baseAttributes.requestId = encodedRequestId;

  async function attemptCreate(attributes, { useInputArg = false } = {}) {
    const data = useInputArg
      ? await jobberGraphql(CREATE_QUOTE_INPUT, { input: attributes })
      : await jobberGraphql(CREATE_QUOTE, { attributes });
    const result = data?.quoteCreate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    if (!result?.quote?.id) throw new Error('quoteCreate returned no quote');
    return result.quote;
  }

  let quote = null;
  let embeddedLines = false;
  const errors = [];

  // Jobber requires attributes.lineItems to be a non-null array of
  // QuoteCreateLineItemAttributes (with saveToProductsAndServices set).
  const linesForCreate =
    normalizedLines.length > 0
      ? normalizedLines
      : [
          {
            name: title || 'Quote line',
            quantity: 1,
            unitPrice: 0,
            saveToProductsAndServices: false,
          },
        ];

  try {
    quote = await attemptCreate({
      ...baseAttributes,
      lineItems: linesForCreate,
    });
    embeddedLines = true;
  } catch (err) {
    errors.push(`attributes+lines: ${err.message}`);
    // Last resort: create with a stub line, then replace via quoteCreateLineItems
    try {
      quote = await attemptCreate({
        ...baseAttributes,
        lineItems: [
          {
            name: title || 'Quote line',
            quantity: 1,
            unitPrice: 0,
            saveToProductsAndServices: false,
          },
        ],
      });
      embeddedLines = false;
    } catch (err2) {
      errors.push(`attributes+stub: ${err2.message}`);
      throw new Error(`quoteCreate failed: ${errors.join(' | ')}`);
    }
  }

  let createdLineItems = [];
  if (normalizedLines.length && !embeddedLines) {
    const lineData = await jobberGraphql(CREATE_QUOTE_LINE_ITEMS, {
      quoteId: quote.id,
      lineItems: normalizedLines,
    });
    const lineResult = lineData?.quoteCreateLineItems;
    if (lineResult?.userErrors?.length) {
      throw new Error(
        `Quote created (${quote.id}) but line items failed: ` +
          lineResult.userErrors.map((e) => e.message).join('; ')
      );
    }
    createdLineItems =
      lineResult?.quote?.lineItems?.nodes || normalizedLines;
  } else if (embeddedLines) {
    createdLineItems = normalizedLines;
  }

  try {
    const fresh = await getQuote(quote.id);
    return {
      ...quote,
      ...fresh,
      lineItems: fresh.lineItems?.length ? fresh.lineItems : createdLineItems,
    };
  } catch {
    return { ...quote, lineItems: createdLineItems };
  }
}

const DELETE_EXPENSE = `
  mutation DeleteExpense($expenseId: EncodedId!) {
    expenseDelete(expenseId: $expenseId) {
      expense {
        id
        title
        description
        total
        date
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Delete a Jobber expense by EncodedId (cleanup of test/duplicate entries).
 */
export async function deleteExpense(expenseId) {
  if (!expenseId) throw new Error('expenseId is required');

  const data = await jobberGraphql(DELETE_EXPENSE, {
    expenseId: String(expenseId),
  });
  const result = data?.expenseDelete;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  return {
    deleted: true,
    expense: result?.expense || { id: String(expenseId) },
  };
}

const CREATE_VISIT = `
  mutation CreateVisit($jobId: EncodedId!, $input: VisitCreateInput!) {
    visitCreate(jobId: $jobId, input: $input) {
      createdVisits {
        id
        title
        startAt
        endAt
        instructions
        visitStatus
        isComplete
        allDay
        assignedUsers(first: 25) {
          nodes {
            id
            name {
              full
            }
          }
        }
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Schedule a visit on an existing Jobber job (date/time, instructions, crew).
 */
export async function createVisit({
  jobId,
  startAt,
  endAt,
  title,
  instructions,
  assignedUserIds = [],
  allDay,
} = {}) {
  if (!jobId) throw new Error('jobId is required');
  if (!startAt) throw new Error('startAt is required (ISO-8601)');

  const visitAttributes = {
    schedule: {
      startAt: { isoTimestamp: String(startAt) },
    },
  };

  if (endAt) {
    visitAttributes.schedule.endAt = { isoTimestamp: String(endAt) };
  }
  if (title) visitAttributes.title = title;
  if (instructions) visitAttributes.instructions = instructions;
  if (typeof allDay === 'boolean') visitAttributes.allDay = allDay;
  if (Array.isArray(assignedUserIds) && assignedUserIds.length > 0) {
    visitAttributes.assignedUserIds = assignedUserIds.map(String);
  }

  const data = await jobberGraphql(CREATE_VISIT, {
    jobId: String(jobId),
    input: {
      visits: [visitAttributes],
      aggregateAssignmentEmails: false,
    },
  });
  const result = data?.visitCreate;

  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  const visits = result?.createdVisits || [];
  const visit = visits[0];
  if (!visit) throw new Error('Visit create returned no visits');

  const normalize = (v) => ({
    ...v,
    assignedUsers: (v.assignedUsers?.nodes || []).map((u) => ({
      id: u.id,
      name: u.name?.full || null,
    })),
  });

  if (visits.length === 1) return normalize(visit);
  return visits.map(normalize);
}

const GET_JOB = `
  query GetJob($id: EncodedId!) {
    job(id: $id) {
      id
      jobNumber
      title
      jobStatus
      jobType
      instructions
      total
      invoicedTotal
      uninvoicedTotal
      startAt
      endAt
      completedAt
      createdAt
      updatedAt
      jobberWebUri
      client {
        id
        name
        firstName
        lastName
        companyName
        emails {
          address
          primary
        }
        phones {
          number
          primary
        }
      }
      property {
        id
        address {
          street1
          street2
          city
          province
          postalCode
          country
        }
      }
      lineItems(first: 50) {
        nodes {
          id
          name
          description
          quantity
          unitPrice
          totalPrice
          taxable
        }
      }
      visits(first: 50) {
        nodes {
          id
          title
          startAt
          endAt
          instructions
          visitStatus
          isComplete
          allDay
          assignedUsers(first: 10) {
            nodes {
              id
              name {
                full
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch a full Jobber job record (line items, property, client, visits).
 */
export async function getJob(jobId) {
  if (!jobId) throw new Error('jobId is required');

  const data = await jobberGraphql(GET_JOB, { id: String(jobId) });
  const job = data?.job;
  if (!job) throw new Error(`Job not found: ${jobId}`);

  return {
    id: job.id,
    jobNumber: job.jobNumber,
    title: job.title,
    jobStatus: job.jobStatus,
    jobType: job.jobType,
    instructions: job.instructions,
    total: job.total,
    invoicedTotal: job.invoicedTotal,
    uninvoicedTotal: job.uninvoicedTotal,
    startAt: job.startAt,
    endAt: job.endAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    jobberWebUri: job.jobberWebUri,
    client: job.client
      ? {
          id: job.client.id,
          name: job.client.name,
          firstName: job.client.firstName,
          lastName: job.client.lastName,
          companyName: job.client.companyName,
          emails: job.client.emails || [],
          phones: job.client.phones || [],
        }
      : null,
    property: job.property
      ? {
          id: job.property.id,
          address: job.property.address || null,
        }
      : null,
    lineItems: job.lineItems?.nodes || [],
    visits: (job.visits?.nodes || []).map((v) => ({
      id: v.id,
      title: v.title,
      startAt: v.startAt,
      endAt: v.endAt,
      instructions: v.instructions,
      visitStatus: v.visitStatus,
      isComplete: v.isComplete,
      allDay: v.allDay,
      assignedUsers: (v.assignedUsers?.nodes || []).map((u) => ({
        id: u.id,
        name: u.name?.full || null,
      })),
    })),
  };
}

const SEARCH_CLIENTS = `
  query SearchClients($first: Int!, $searchTerm: String!) {
    clients(first: $first, searchTerm: $searchTerm) {
      nodes {
        id
        name
        firstName
        lastName
        companyName
        isLead
        isCompany
        emails {
          address
          primary
        }
        phones {
          number
          primary
        }
        billingAddress {
          street1
          street2
          city
          province
          postalCode
        }
        jobberWebUri
        createdAt
        updatedAt
      }
      totalCount
    }
  }
`;

/**
 * Search Jobber clients by name / company / contact text.
 */
export async function searchClients({ query, limit = 15 } = {}) {
  const searchTerm = String(query || '').trim();
  if (!searchTerm) throw new Error('Provide query to search clients');

  const first = Math.min(Math.max(Number(limit) || 15, 1), 50);
  const data = await jobberGraphql(SEARCH_CLIENTS, { first, searchTerm });
  const nodes = data?.clients?.nodes || [];

  const clients = nodes.map((c) => ({
    id: c.id,
    name: c.name,
    firstName: c.firstName,
    lastName: c.lastName,
    companyName: c.companyName,
    isLead: c.isLead,
    isCompany: c.isCompany,
    email:
      (c.emails || []).find((e) => e.primary)?.address ||
      c.emails?.[0]?.address ||
      null,
    phone:
      (c.phones || []).find((p) => p.primary)?.number ||
      c.phones?.[0]?.number ||
      null,
    billingAddress: c.billingAddress || null,
    jobberWebUri: c.jobberWebUri,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));

  return {
    count: clients.length,
    totalCount: data?.clients?.totalCount ?? clients.length,
    clients,
  };
}

const SEARCH_QUOTES = `
  query SearchQuotes($first: Int!, $filter: QuoteFilterAttributes, $searchTerm: String) {
    quotes(first: $first, filter: $filter, searchTerm: $searchTerm) {
      nodes {
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
        property {
          id
          address {
            street1
            city
            province
            postalCode
          }
        }
        createdAt
        updatedAt
        sentAt
        jobberWebUri
      }
      totalCount
    }
  }
`;

const SEARCH_QUOTES_NO_SEARCHTERM = `
  query SearchQuotesNoTerm($first: Int!, $filter: QuoteFilterAttributes) {
    quotes(first: $first, filter: $filter) {
      nodes {
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
        property {
          id
          address {
            street1
            city
            province
            postalCode
          }
        }
        createdAt
        updatedAt
        sentAt
        jobberWebUri
      }
      totalCount
    }
  }
`;

function mapQuoteNode(q) {
  return {
    id: q.id,
    quoteNumber: q.quoteNumber,
    quoteStatus: q.quoteStatus,
    title: q.title,
    message: q.message,
    amounts: q.amounts || null,
    clientId: q.client?.id || null,
    clientName: q.client?.name || null,
    property: q.property
      ? { id: q.property.id, address: q.property.address || null }
      : null,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    sentAt: q.sentAt,
    jobberWebUri: q.jobberWebUri,
  };
}

/**
 * Search Jobber quotes (open drafts / by client / by text).
 */
export async function searchQuotes({
  query,
  clientId,
  status,
  limit = 20,
} = {}) {
  const first = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const filter = {};
  if (clientId) filter.clientId = String(clientId);
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    filter.quoteStatus = statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  const searchTerm = query != null && String(query).trim() ? String(query).trim() : null;
  const variables = { first };
  if (Object.keys(filter).length) variables.filter = filter;

  let data;
  try {
    if (searchTerm) {
      variables.searchTerm = searchTerm;
      data = await jobberGraphql(SEARCH_QUOTES, variables);
    } else {
      data = await jobberGraphql(SEARCH_QUOTES_NO_SEARCHTERM, variables);
    }
  } catch (err) {
    // Older schema may not accept searchTerm on quotes — retry without it
    if (searchTerm && /searchTerm|Unknown argument/i.test(err.message || '')) {
      data = await jobberGraphql(SEARCH_QUOTES_NO_SEARCHTERM, {
        first,
        filter: Object.keys(filter).length ? filter : undefined,
      });
      let nodes = (data?.quotes?.nodes || []).map(mapQuoteNode);
      const needle = searchTerm.toLowerCase();
      nodes = nodes.filter(
        (q) =>
          String(q.clientName || '').toLowerCase().includes(needle) ||
          String(q.title || '').toLowerCase().includes(needle) ||
          String(q.quoteNumber || '').toLowerCase().includes(needle) ||
          String(q.property?.address?.street1 || '')
            .toLowerCase()
            .includes(needle)
      );
      return { count: nodes.length, totalCount: nodes.length, quotes: nodes };
    }
    throw err;
  }

  let quotes = (data?.quotes?.nodes || []).map(mapQuoteNode);

  if (searchTerm && !variables.searchTerm) {
    const needle = searchTerm.toLowerCase();
    quotes = quotes.filter(
      (q) =>
        String(q.clientName || '').toLowerCase().includes(needle) ||
        String(q.title || '').toLowerCase().includes(needle) ||
        String(q.quoteNumber || '').toLowerCase().includes(needle)
    );
  }

  return {
    count: quotes.length,
    totalCount: data?.quotes?.totalCount ?? quotes.length,
    quotes,
  };
}

const SEARCH_REQUESTS = `
  query SearchRequests($first: Int!, $filter: RequestFilterAttributes) {
    requests(first: $first, filter: $filter) {
      nodes {
        id
        title
        requestStatus
        source
        contactName
        companyName
        email
        phone
        client {
          id
          name
          isLead
        }
        property {
          id
          address {
            street1
            city
            province
            postalCode
          }
        }
        createdAt
        updatedAt
        jobberWebUri
      }
      totalCount
    }
  }
`;

/**
 * List/filter Jobber work requests (inbound quote leads).
 */
export async function searchRequests({
  status,
  query,
  limit = 25,
} = {}) {
  const first = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const filter = {};
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    filter.requestStatus = statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  const data = await jobberGraphql(SEARCH_REQUESTS, {
    first,
    filter: Object.keys(filter).length ? filter : undefined,
  });

  let requests = (data?.requests?.nodes || []).map((r) => ({
    id: r.id,
    title: r.title,
    requestStatus: r.requestStatus,
    source: r.source,
    contactName: r.contactName,
    companyName: r.companyName,
    email: r.email,
    phone: r.phone,
    clientId: r.client?.id || null,
    clientName: r.client?.name || null,
    isLead: r.client?.isLead ?? null,
    property: r.property
      ? { id: r.property.id, address: r.property.address || null }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    jobberWebUri: r.jobberWebUri,
  }));

  if (query && String(query).trim()) {
    const needle = String(query).trim().toLowerCase();
    requests = requests.filter(
      (r) =>
        String(r.contactName || '').toLowerCase().includes(needle) ||
        String(r.companyName || '').toLowerCase().includes(needle) ||
        String(r.clientName || '').toLowerCase().includes(needle) ||
        String(r.title || '').toLowerCase().includes(needle) ||
        String(r.email || '').toLowerCase().includes(needle) ||
        String(r.property?.address?.street1 || '')
          .toLowerCase()
          .includes(needle)
    );
  }

  return {
    count: requests.length,
    totalCount: data?.requests?.totalCount ?? requests.length,
    requests,
  };
}

const EDIT_QUOTE = `
  mutation EditQuote($quoteId: EncodedId!, $attributes: QuoteEditAttributes!) {
    quoteEdit(quoteId: $quoteId, attributes: $attributes) {
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
        updatedAt
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const DELETE_QUOTE_LINE_ITEMS = `
  mutation DeleteQuoteLineItems($quoteId: EncodedId!, $lineItemIds: [EncodedId!]!) {
    quoteDeleteLineItems(quoteId: $quoteId, lineItemIds: $lineItemIds) {
      quote {
        id
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Edit an existing Jobber quote (title/message/deposit) and optionally replace line items.
 */
export async function editQuote({
  quoteId,
  title,
  message,
  depositAmount,
  lineItems,
  replaceLineItems = false,
} = {}) {
  if (!quoteId) throw new Error('quoteId is required');

  const attributes = {};
  if (title != null) attributes.title = title;
  if (message != null) attributes.message = message;
  if (depositAmount != null) attributes.depositAmount = Number(depositAmount);

  let quote = null;
  if (Object.keys(attributes).length) {
    const data = await jobberGraphql(EDIT_QUOTE, {
      quoteId: String(quoteId),
      attributes,
    });
    const result = data?.quoteEdit;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    quote = result?.quote || null;
  }

  let createdLineItems = [];
  if (Array.isArray(lineItems) && lineItems.length) {
    const existing = await getQuote(quoteId);
    const oldIds = (existing.lineItems || []).map((li) => li.id).filter(Boolean);
    const normalized = normalizeQuoteLineItems(lineItems);

    // Add new lines FIRST — Jobber rejects quotes with zero line items, so we
    // must not delete-all before create when replaceLineItems is set.
    const lineData = await jobberGraphql(CREATE_QUOTE_LINE_ITEMS, {
      quoteId: String(quoteId),
      lineItems: normalized,
    });
    const lineResult = lineData?.quoteCreateLineItems;
    if (lineResult?.userErrors?.length) {
      throw new Error(
        `Quote updated (${quoteId}) but line items failed: ` +
          lineResult.userErrors.map((e) => e.message).join('; ')
      );
    }
    createdLineItems = lineResult?.quote?.lineItems?.nodes || normalized;

    if (replaceLineItems && oldIds.length) {
      try {
        const del = await jobberGraphql(DELETE_QUOTE_LINE_ITEMS, {
          quoteId: String(quoteId),
          lineItemIds: oldIds,
        });
        const delResult = del?.quoteDeleteLineItems;
        if (delResult?.userErrors?.length) {
          throw new Error(
            delResult.userErrors.map((e) => e.message).join('; ')
          );
        }
      } catch (err) {
        if (/lineItemIds|Unknown argument/i.test(err.message || '')) {
          const ALT_DELETE = `
            mutation DeleteQuoteLineItemsAlt($quoteId: EncodedId!, $lineItems: QuoteDeleteLineItemsAttributes!) {
              quoteDeleteLineItems(quoteId: $quoteId, lineItems: $lineItems) {
                quote { id }
                userErrors { message path }
              }
            }
          `;
          const del = await jobberGraphql(ALT_DELETE, {
            quoteId: String(quoteId),
            lineItems: { lineItemIds: oldIds },
          });
          const delResult = del?.quoteDeleteLineItems;
          if (delResult?.userErrors?.length) {
            throw new Error(
              delResult.userErrors.map((e) => e.message).join('; ')
            );
          }
        } else {
          throw err;
        }
      }
      // Refresh after delete so returned lines are only the new set
      const refreshed = await getQuote(quoteId);
      createdLineItems = refreshed.lineItems || createdLineItems;
    }
  }

  const fresh = await getQuote(quoteId);
  return {
    ...(quote || {}),
    ...fresh,
    lineItems: createdLineItems.length ? createdLineItems : fresh.lineItems,
  };
}

const SEARCH_INVOICES = `
  query SearchInvoices($first: Int!, $filter: InvoiceFilterAttributes) {
    invoices(first: $first, filter: $filter) {
      nodes {
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
          invoiceBalance
        }
        client {
          id
          name
        }
      }
      totalCount
    }
  }
`;

/**
 * Search/filter Jobber invoices for A/R reconciliation.
 * Filters by client name, status, and/or invoice number.
 */
export async function searchInvoices({
  clientName,
  status,
  invoiceNumber,
  query,
  limit = 25,
} = {}) {
  const first = Math.min(Math.max(Number(limit) || 25, 1), 50);

  const filter = {};
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    filter.invoiceStatus = statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  // Resolve client name → clientId via clients(searchTerm) (invoices have no searchTerm)
  const nameQuery = (clientName || query || '').trim();
  if (nameQuery && !invoiceNumber) {
    const clientData = await jobberGraphql(SEARCH_CLIENTS, {
      first: 5,
      searchTerm: nameQuery,
    });
    const clients = clientData?.clients?.nodes || [];
    if (clients.length === 1) {
      filter.clientId = clients[0].id;
    } else if (clients.length > 1) {
      // Prefer exact / closer name match
      const needle = nameQuery.toLowerCase();
      const exact = clients.find(
        (c) => String(c.name || '').toLowerCase() === needle
      );
      filter.clientId = (exact || clients[0]).id;
    }
  }

  const variables = { first };
  if (Object.keys(filter).length) variables.filter = filter;

  // When searching by invoice number only, pull a wider page then filter locally
  if (invoiceNumber != null && String(invoiceNumber).trim() !== '' && !filter.clientId) {
    variables.first = Math.min(50, Math.max(first, 50));
  }

  const data = await jobberGraphql(SEARCH_INVOICES, variables);
  let nodes = data?.invoices?.nodes || [];

  if (invoiceNumber != null && String(invoiceNumber).trim() !== '') {
    const target = String(invoiceNumber).trim().toLowerCase();
    nodes = nodes
      .filter(
        (inv) =>
          String(inv.invoiceNumber || '').toLowerCase() === target ||
          String(inv.invoiceNumber || '').toLowerCase().includes(target)
      )
      .sort((a, b) => {
        const aExact =
          String(a.invoiceNumber || '').toLowerCase() === target ? 0 : 1;
        const bExact =
          String(b.invoiceNumber || '').toLowerCase() === target ? 0 : 1;
        return aExact - bExact;
      });
  }

  if (clientName && String(clientName).trim() && !filter.clientId) {
    const needle = String(clientName).trim().toLowerCase();
    nodes = nodes.filter((inv) =>
      String(inv.client?.name || '').toLowerCase().includes(needle)
    );
  }

  if (query && String(query).trim() && !filter.clientId && !invoiceNumber) {
    const needle = String(query).trim().toLowerCase();
    nodes = nodes.filter(
      (inv) =>
        String(inv.client?.name || '').toLowerCase().includes(needle) ||
        String(inv.invoiceNumber || '').toLowerCase().includes(needle) ||
        String(inv.subject || '').toLowerCase().includes(needle)
    );
  }

  nodes = nodes.slice(0, first);

  const invoices = nodes.map((inv) => {
    const balance = inv.amounts?.invoiceBalance ?? null;
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      subject: inv.subject,
      invoiceStatus: inv.invoiceStatus,
      issuedDate: inv.issuedDate,
      dueDate: inv.dueDate,
      clientId: inv.client?.id || null,
      clientName: inv.client?.name || null,
      amounts: inv.amounts
        ? {
            ...inv.amounts,
            balance,
          }
        : null,
      balance,
      total: inv.amounts?.total ?? null,
      paymentsTotal: inv.amounts?.paymentsTotal ?? null,
    };
  });

  return {
    count: invoices.length,
    totalCount: data?.invoices?.totalCount ?? invoices.length,
    invoices,
  };
}

const GET_QUOTE = `
  query GetQuote($id: EncodedId!) {
    quote(id: $id) {
      id
      quoteNumber
      quoteStatus
      title
      message
      amounts {
        subtotal
        taxAmount
        total
        depositAmount
        discountAmount
        outstandingDepositAmount
      }
      depositAmountUnallocated
      client {
        id
        name
      }
      property {
        id
        address {
          street1
          street2
          city
          province
          postalCode
          country
        }
      }
      lineItems(first: 50) {
        nodes {
          id
          name
          description
          quantity
          unitPrice
          totalPrice
          taxable
        }
      }
      jobs(first: 10) {
        nodes {
          id
          jobNumber
          title
          jobStatus
        }
      }
      createdAt
      updatedAt
      sentAt
      transitionedAt
      jobberWebUri
    }
  }
`;

/**
 * Fetch a Jobber quote with line items and deposit amounts.
 */
export async function getQuote(quoteId) {
  if (!quoteId) throw new Error('quoteId is required');

  const data = await jobberGraphql(GET_QUOTE, { id: String(quoteId) });
  const quote = data?.quote;
  if (!quote) throw new Error(`Quote not found: ${quoteId}`);

  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    quoteStatus: quote.quoteStatus,
    title: quote.title,
    message: quote.message,
    amounts: quote.amounts || null,
    depositAmount: quote.amounts?.depositAmount ?? null,
    outstandingDepositAmount: quote.amounts?.outstandingDepositAmount ?? null,
    depositAmountUnallocated: quote.depositAmountUnallocated ?? null,
    client: quote.client || null,
    property: quote.property
      ? {
          id: quote.property.id,
          address: quote.property.address || null,
        }
      : null,
    lineItems: quote.lineItems?.nodes || [],
    jobs: quote.jobs?.nodes || [],
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    sentAt: quote.sentAt,
    transitionedAt: quote.transitionedAt,
    jobberWebUri: quote.jobberWebUri,
  };
}
