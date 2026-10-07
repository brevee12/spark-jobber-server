/**
 * Lightweight tests for quote_meeting planning helpers (no live Jobber).
 * Run: node src/mcp/quoteMeeting.test.js
 */
import { toolDefinitions } from './tools.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const names = toolDefinitions.map((t) => t.name);
  assert(names.includes('quote_meeting'), 'quote_meeting listed');
  assert(names.includes('jobber_batch'), 'jobber_batch listed');
  const jobber = toolDefinitions.find((t) => t.name === 'jobber_batch');
  assert(
    /create_client/i.test(jobber.description) &&
      /create_quote/i.test(jobber.description),
    'jobber_batch description mentions create_client/create_quote'
  );
  assert(
    /search_clients|search_quotes|search_requests|update_quote/.test(
      jobber.inputSchema.properties.actions.description
    ),
    'jobber_batch ops include search/update quote ops'
  );
}

console.log('quoteMeeting.test.js: all assertions passed');
