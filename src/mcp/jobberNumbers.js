/**
 * Jobber numbers requests, quotes, invoices, and jobs on separate sequences.
 * The same digits can exist on each kind of record. A quote number is never
 * a job number, and a job lookup matches Job.jobNumber only.
 */

export function jobsWithExactNumber(jobs, jobNumber) {
  const target = String(jobNumber ?? '').replace(/^#/, '').trim();
  if (!/^\d+$/.test(target)) return [];
  return (jobs || []).filter((j) => String(j.jobNumber) === target);
}
