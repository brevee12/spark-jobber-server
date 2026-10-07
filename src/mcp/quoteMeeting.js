/**
 * Orchestrate voice-meeting → Jobber quote drafts.
 * Spark summarizes the recording; this decides client/quote create vs update
 * and optionally applies the writes in one MCP Allow.
 */
import {
  searchClients,
  searchQuotes,
  searchRequests,
  createClient,
  createQuote,
  editQuote,
  getQuote,
} from '../../jobber/client.js';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreClient(client, { name, street, phone, email }) {
  let score = 0;
  const cName = norm(client.name);
  const needle = norm(name);
  if (needle && cName === needle) score += 10;
  else if (needle && cName.includes(needle)) score += 6;
  else if (needle && needle.split(' ').every((p) => p && cName.includes(p)))
    score += 5;

  if (street) {
    const st = norm(street);
    const bill = norm(client.billingAddress?.street1);
    if (st && bill && (bill.includes(st) || st.includes(bill))) score += 4;
  }
  if (email && client.email && norm(client.email) === norm(email)) score += 5;
  if (phone && client.phone) {
    const a = String(phone).replace(/\D/g, '');
    const b = String(client.phone).replace(/\D/g, '');
    if (a && b && (a.endsWith(b.slice(-7)) || b.endsWith(a.slice(-7))))
      score += 4;
  }
  return score;
}

function pickBestClient(clients, hints) {
  if (!clients?.length) return null;
  const ranked = clients
    .map((c) => ({ c, score: scoreClient(c, hints) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score >= 5) return ranked[0].c;
  return null;
}

/**
 * Plan (and optionally apply) a quote from a meeting summary.
 *
 * @param {object} args
 * @param {boolean} [args.apply=false] - when true, create/update in Jobber
 * @param {string} [args.clientId]
 * @param {string} [args.quoteId] - force update this quote
 * @param {string} [args.firstName]
 * @param {string} [args.lastName]
 * @param {string} [args.companyName]
 * @param {string} [args.clientName] - free-text name from transcript
 * @param {string} [args.email]
 * @param {string} [args.phone]
 * @param {object} [args.billingAddress]
 * @param {string} [args.street] - property / site street from transcript
 * @param {string} [args.title]
 * @param {string} [args.message]
 * @param {number} [args.depositAmount]
 * @param {string} [args.propertyId]
 * @param {string} [args.requestId]
 * @param {array}  [args.lineItems]
 * @param {string} [args.meetingNotes] - short transcript summary for the quote message
 * @param {boolean} [args.isLead=true]
 */
export async function runQuoteMeeting(args = {}) {
  const apply = Boolean(args.apply);
  const clientName =
    args.clientName ||
    [args.firstName, args.lastName].filter(Boolean).join(' ') ||
    args.companyName ||
    '';
  const street =
    args.street ||
    args.billingAddress?.street1 ||
    args.propertyAddress?.street1 ||
    '';

  const lookupQuery = [clientName, street].filter(Boolean).join(' ').trim();

  const [clientSearch, requestSearch, openQuotesGlobal] = await Promise.all([
    lookupQuery
      ? searchClients({ query: lookupQuery, limit: 15 }).catch((err) => ({
          count: 0,
          clients: [],
          error: err.message,
        }))
      : { count: 0, clients: [] },
    lookupQuery
      ? searchRequests({ query: lookupQuery, limit: 25 }).catch((err) => ({
          count: 0,
          requests: [],
          error: err.message,
        }))
      : searchRequests({ status: ['new', 'overdue'], limit: 25 }).catch(
          (err) => ({ count: 0, requests: [], error: err.message })
        ),
    searchQuotes({
      query: lookupQuery || undefined,
      status: ['draft', 'awaiting_response', 'changes_requested'],
      limit: 20,
    }).catch((err) => ({ count: 0, quotes: [], error: err.message })),
  ]);

  let client =
    (args.clientId &&
      (clientSearch.clients || []).find((c) => c.id === args.clientId)) ||
    null;
  if (!client && args.clientId) {
    // ID provided but not in search hits — still honor it
    client = { id: args.clientId, name: clientName || null };
  }
  if (!client) {
    client = pickBestClient(clientSearch.clients || [], {
      name: clientName,
      street,
      phone: args.phone,
      email: args.email,
    });
  }

  let clientQuotes = { count: 0, quotes: [] };
  if (client?.id) {
    clientQuotes = await searchQuotes({
      clientId: client.id,
      limit: 20,
    }).catch((err) => ({ count: 0, quotes: [], error: err.message }));
  }

  const candidates = [
    ...(clientQuotes.quotes || []),
    ...(openQuotesGlobal.quotes || []),
  ];
  // de-dupe by id
  const seen = new Set();
  const uniqueQuotes = [];
  for (const q of candidates) {
    if (!q?.id || seen.has(q.id)) continue;
    seen.add(q.id);
    uniqueQuotes.push(q);
  }

  let quote = null;
  if (args.quoteId) {
    quote =
      uniqueQuotes.find((q) => q.id === args.quoteId) ||
      (await getQuote(args.quoteId).catch(() => null));
  }
  if (!quote && client?.id) {
    // Prefer draft/unsent quote for same client + street hint
    const open = uniqueQuotes.filter((q) =>
      /draft|awaiting|changes/i.test(String(q.quoteStatus || ''))
    );
    const streetNeedle = norm(street);
    quote =
      open.find((q) => {
        const st = norm(q.property?.address?.street1);
        return streetNeedle && st && (st.includes(streetNeedle) || streetNeedle.includes(st));
      }) ||
      open[0] ||
      null;
  }

  const matchingRequest =
    (args.requestId &&
      (requestSearch.requests || []).find((r) => r.id === args.requestId)) ||
    (requestSearch.requests || []).find((r) => {
      if (client?.id && r.clientId === client.id) return true;
      const n = norm(clientName);
      return (
        n &&
        (norm(r.contactName).includes(n) ||
          norm(r.clientName).includes(n) ||
          norm(r.companyName).includes(n))
      );
    }) ||
    null;

  const decision = {
    clientAction: client?.id ? 'use_existing_client' : 'create_client',
    quoteAction: quote?.id ? 'update_quote' : 'create_quote',
    clientId: client?.id || null,
    quoteId: quote?.id || null,
    requestId: matchingRequest?.id || args.requestId || null,
    reasons: [],
  };

  if (client?.id) {
    decision.reasons.push(`Matched client ${client.name || client.id}`);
  } else {
    decision.reasons.push(
      clientName
        ? `No confident client match for "${clientName}" — will create`
        : 'No client identity in meeting summary — will create from provided fields'
    );
  }
  if (quote?.id) {
    decision.reasons.push(
      `Will update existing quote #${quote.quoteNumber || quote.id} (${quote.quoteStatus})`
    );
  } else {
    decision.reasons.push('No open quote to update — will create a new draft quote');
  }
  if (matchingRequest) {
    decision.reasons.push(
      `Related request ${matchingRequest.id} (${matchingRequest.requestStatus})`
    );
  }

  const plan = {
    decision,
    matches: {
      clients: clientSearch,
      requests: requestSearch,
      quotes: { count: uniqueQuotes.length, quotes: uniqueQuotes.slice(0, 10) },
    },
  };

  if (!apply) {
    return {
      applied: false,
      ...plan,
      hint: 'Re-call quote_meeting with apply:true (and any corrected clientId/quoteId) to write the Jobber draft.',
    };
  }

  // --- Apply ---
  const actionsTaken = [];
  let clientId = client?.id || null;

  if (!clientId) {
    if (!args.firstName && !args.lastName && !args.companyName && !clientName) {
      throw new Error(
        'Cannot create client: provide firstName/lastName or companyName (or clientName)'
      );
    }
    const nameParts = String(clientName || '').trim().split(/\s+/);
    const created = await createClient({
      firstName: args.firstName || (nameParts.length ? nameParts[0] : undefined),
      lastName:
        args.lastName ||
        (nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined),
      companyName: args.companyName,
      isCompany: args.isCompany,
      isLead: args.isLead !== false,
      email: args.email,
      phone: args.phone,
      note: args.meetingNotes
        ? `From quote meeting: ${String(args.meetingNotes).slice(0, 500)}`
        : undefined,
      billingAddress: args.billingAddress || args.propertyAddress,
    });
    clientId = created.id;
    actionsTaken.push({ op: 'create_client', data: created });
    decision.clientAction = 'create_client';
    decision.clientId = clientId;
  } else {
    actionsTaken.push({
      op: 'use_existing_client',
      data: { id: clientId, name: client?.name || null },
    });
  }

  const title =
    args.title ||
    (street ? `Exterior painting — ${street}` : null) ||
    (clientName ? `Painting quote — ${clientName}` : 'Painting quote');

  let message = args.message || '';
  if (args.meetingNotes && !message) {
    message = `Draft from on-site quote meeting.\n\n${args.meetingNotes}`;
  }

  const lineItems = Array.isArray(args.lineItems) ? args.lineItems : [];
  let quoteResult;

  if (quote?.id) {
    quoteResult = await editQuote({
      quoteId: quote.id,
      title,
      message: message || undefined,
      depositAmount: args.depositAmount,
      lineItems,
      replaceLineItems: Boolean(args.replaceLineItems ?? lineItems.length > 0),
    });
    decision.quoteAction = 'update_quote';
    decision.quoteId = quote.id;
    actionsTaken.push({ op: 'update_quote', data: quoteResult });
  } else {
    quoteResult = await createQuote({
      clientId,
      title,
      message: message || undefined,
      depositAmount: args.depositAmount,
      propertyId: args.propertyId,
      lineItems,
    });
    decision.quoteAction = 'create_quote';
    decision.quoteId = quoteResult.id;
    actionsTaken.push({ op: 'create_quote', data: quoteResult });
  }

  return {
    applied: true,
    decision,
    quote: quoteResult,
    jobberWebUri: quoteResult.jobberWebUri || null,
    actionsTaken,
    matches: plan.matches,
  };
}
