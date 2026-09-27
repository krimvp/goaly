const assert = require('node:assert/strict');
const path = require('node:path');

const [taskId, workspace] = process.argv.slice(2);
const load = (name) => require(path.join(workspace, 'src', name));

try {
  if (taskId === 'order-pricing') {
    const { priceCents } = load('price.cjs');
    const { receipt } = load('receipt.cjs');
    assert.equal(priceCents(99, 3, 50), 149);
    assert.equal(priceCents(101, 3, -10), 303);
    assert.equal(priceCents(101, 3, 150), 0);
    const items = [
      { unitCents: 99, quantity: 3, discountPercent: 50 },
      { unitCents: 101, quantity: 2, discountPercent: 0 },
    ];
    const before = structuredClone(items);
    assert.deepEqual(receipt(items, 7.5), { subtotalCents: 351, taxCents: 26, totalCents: 377 });
    assert.deepEqual(items, before);
  } else if (taskId === 'event-report') {
    const { parseLine } = load('parse.cjs');
    const { summarize } = load('report.cjs');
    assert.deepEqual(parseLine('  blue  | 2 '), { kind: 'blue', count: 2 });
    for (const line of ['', ' ', '|2', 'red|-1', 'red|1.5', 'red|x', 'red|2|extra']) {
      assert.equal(parseLine(line), null, `invalid row: ${line}`);
    }
    assert.deepEqual(summarize('z|1\nblue|2\n\nblue|3\ninvalid\n__proto__|4'), [
      { kind: '__proto__', count: 4 },
      { kind: 'blue', count: 5 },
      { kind: 'z', count: 1 },
    ]);
  } else {
    throw new Error(`unknown oracle: ${taskId}`);
  }
  process.stdout.write('oracle pass\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
