/**
 * Run: node src/mcp/jobberNumbers.test.js
 */
import { jobsWithExactNumber } from './jobberNumbers.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const jobs = [
  { jobId: 'J-kevin', jobNumber: 26085, clientName: 'Kevin Van Wyk', title: null },
  { jobId: 'J-longer', jobNumber: 126085, clientName: 'Other', title: '26085' },
  { jobId: 'J-shorter', jobNumber: 2608, clientName: 'Other', title: 'PO 26085' },
];

const hits = jobsWithExactNumber(jobs, '26085');
assert(hits.length === 1 && hits[0].jobId === 'J-kevin', 'only the exact job number');
assert(jobsWithExactNumber(jobs, '#26085')[0]?.jobId === 'J-kevin', 'optional hash');
assert(jobsWithExactNumber(jobs, 'SHOP').length === 0, 'a name is not a job number');
assert(jobsWithExactNumber(jobs, '').length === 0, 'blank');

console.log('jobberNumbers.test.js: all assertions passed');
