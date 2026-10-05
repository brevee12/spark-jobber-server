/**
 * Lightweight assertions for runQboBatch validation.
 * Run: node src/mcp/tools.qboBatch.test.js
 */
import { runQboBatch, toolDefinitions } from './tools.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

async function assertRejects(fn, match, label) {
  try {
    await fn();
    throw new Error(`${label}: expected rejection`);
  } catch (err) {
    if (err.message === `${label}: expected rejection`) throw err;
    assert(
      match.test(err.message),
      `${label}: expected message matching ${match}, got ${JSON.stringify(err.message)}`
    );
  }
}

// ListTools surface is exactly the three batched tools.
{
  const names = toolDefinitions.map((t) => t.name);
  assertEq(names.length, 3, 'toolDefinitions count');
  assertEq(names.join(','), 'jobber_batch,bookkeeping_review,qbo_batch', 'tool names');
}

// Empty / missing actions reject before any QBO call.
await assertRejects(
  () => runQboBatch([]),
  /Provide actions/i,
  'empty actions'
);
await assertRejects(
  () => runQboBatch(),
  /Provide actions/i,
  'missing actions'
);
await assertRejects(
  () => runQboBatch(null),
  /Provide actions/i,
  'null actions'
);

// Unknown op is recorded as a per-action failure (batch continues).
{
  const batch = await runQboBatch([{ op: 'create_invoice' }]);
  assertEq(batch.count, 1, 'unknown op count');
  assertEq(batch.succeeded, 0, 'unknown op succeeded');
  assertEq(batch.failed, 1, 'unknown op failed');
  assertEq(batch.results[0].ok, false, 'unknown op ok');
  assertEq(batch.results[0].op, 'create_invoice', 'unknown op name');
  assert(
    /Unknown QBO op/i.test(batch.results[0].error),
    'unknown op error mentions Unknown QBO op'
  );
}

// Missing op is also a soft per-action failure.
{
  const batch = await runQboBatch([{}]);
  assertEq(batch.failed, 1, 'missing op failed');
  assert(/Each action needs op/i.test(batch.results[0].error), 'missing op error');
}

console.log('tools.qboBatch.test.js: all assertions passed');
