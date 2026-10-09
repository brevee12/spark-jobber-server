/**
 * Run: node src/mcp/crewSchedule.test.js
 */
import { planCrewChanges, resolveDate, resolvePerson } from './crewSchedule.js';
import { matchLineItemsToCatalog } from './quoteCatalog.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const users = [
  { id: 'U1', name: 'Kevin Veenstra', firstName: 'Kevin', lastName: 'Veenstra' },
  { id: 'U2', name: 'Tom Smith', firstName: 'Tom', lastName: 'Smith' },
  { id: 'U3', name: 'Ryan Jones', firstName: 'Ryan', lastName: 'Jones' },
  { id: 'U4', name: 'Brennan Veenstra', firstName: 'Brennan', lastName: 'Veenstra' },
];
const D = '2026-10-09';
const visits = [
  { id: 'V1', jobNumber: 26097, jobTitle: 'Ceiling Repair', clientName: 'Osky First Assembly of God', address: '716 South 17th Street, Oskaloosa', crew: [{ id: 'U3', name: 'Ryan Jones' }] },
  { id: 'V2', jobNumber: 26101, jobTitle: 'Exterior Repaint', clientName: 'Art Horgen', address: '1 Main St', crew: [{ id: 'U1', name: 'Kevin Veenstra' }] },
];

assert(resolveDate('tomorrow', '2026-10-09') === '2026-10-10', 'tomorrow');
assert(resolveDate('friday', '2026-10-07') === '2026-10-09', 'weekday ahead');
assert(resolveDate('Friday', '2026-10-09') === '2026-10-09', 'weekday today');
assert(resolvePerson('kevin', users).user?.id === 'U1', 'first name');
assert(/more than one/.test(resolvePerson('Veenstra', users).problem), 'ambiguous last name');

// Add Tom to the church job; move Kevin there exclusively (comes off Horgen).
{
  const { steps, problems } = planCrewChanges({
    date: D,
    users,
    visitsByDate: { [D]: visits },
    changes: [
      { job: 'Osky First Assembly', people: ['Tom'] },
      { job: '26097', people: ['Kevin'], exclusive: true },
    ],
  });
  assert(!problems.length, `no problems: ${problems}`);
  const church = steps.find((s) => s.visitId === 'V1');
  assert(church.after === 'Ryan Jones, Tom Smith, Kevin Veenstra', `church crew: ${church.after}`);
  assert(church.before === 'Ryan Jones', 'before is original crew');
  assert(steps.find((s) => s.visitId === 'V2')?.after === '(nobody)', 'kevin removed from horgen');
  assert(steps.filter((s) => s.visitId === 'V1').length === 1, 'collapsed to one write per visit');
}

// Ambiguous person or unknown job → problems, caller writes nothing.
{
  const { problems } = planCrewChanges({
    date: D,
    users,
    visitsByDate: { [D]: visits },
    changes: [{ job: 'Blom', people: ['Veenstra'] }],
  });
  assert(problems.length === 2, `two problems: ${problems}`);
}

// Set + reschedule.
{
  const { steps } = planCrewChanges({
    date: D,
    users,
    visitsByDate: { [D]: visits },
    changes: [{ job: 'Horgen', people: ['Ryan', 'Tom'], mode: 'set', moveTo: '2026-10-12' }],
  });
  assert(steps[0].after === 'Ryan Jones, Tom Smith', 'set replaces crew');
  assert(steps[1].kind === 'reschedule' && steps[1].to === '2026-10-12', 'reschedule step');
}

// Catalog: exact names get ids/prices; unknown names flagged with suggestions.
{
  const products = [
    { id: 'P1', name: '1 Labor', category: 'LABOUR', unitPrice: 60, taxable: true },
    { id: 'P2', name: 'Emerald Exterior - Satin', category: 'PRODUCT', unitPrice: 87.04, taxable: false },
  ];
  const r = matchLineItemsToCatalog(
    [
      { name: '1 labor', quantity: 95, description: 'To powerwash full exterior' },
      { name: 'Emerald Exterior - Satin', quantity: 12, unitPrice: 80 },
      { name: 'Emerald paint', quantity: 2 },
    ],
    products
  );
  assert(r.lineItems[0].productOrServiceId === 'P1' && r.lineItems[0].unitPrice === 60, 'labor from catalog');
  assert(r.lineItems[0].taxable === true && r.lineItems[0].name === '1 Labor', 'catalog name + taxable');
  assert(r.warnings.some((w) => /priced 80 vs catalog 87.04/.test(w)), 'product price drift warned');
  assert(r.unmatched.length === 1 && r.unmatched[0].suggestions[0] === 'Emerald Exterior - Satin', 'suggestion');
}

console.log('crewSchedule.test.js: all assertions passed');
