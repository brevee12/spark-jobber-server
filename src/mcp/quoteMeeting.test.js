/**
 * Lightweight tests for quote_meeting planning helpers (no live Jobber).
 * Run: node src/mcp/quoteMeeting.test.js
 */
import { toolDefinitions } from './tools.js';
import { jobSiteProperties } from './quoteMeeting.js';

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

{
  const sites = jobSiteProperties({
    street: '704 G Avenue West',
    city: 'Oskaloosa',
    province: 'IA',
    postalCode: '52577',
    billingAddress: { street1: '1444 Fisher Avenue', city: 'New Sharon' },
  });
  assert(sites.length === 1, 'one job site');
  assert(sites[0].street1 === '704 G Avenue West', 'job site is not the mailing street');
  assert(sites[0].city === 'Oskaloosa', 'job site city');
  const mailed = jobSiteProperties({
    billingAddress: { street1: '1444 Fisher Avenue', city: 'New Sharon' },
  });
  assert(mailed[0].street1 === '1444 Fisher Avenue', 'billing street is the property when no job site was given');
}

console.log('quoteMeeting.test.js: all assertions passed');
