/**
 * Run: node src/services/paintGallons.test.js
 */
import { assignGallons, explicitGallons } from './paintGallons.js';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const line = (sku, name, amount) => ({
  description: `Product Number: ${sku}\nDescription: ${name}`,
  amount,
});

const bills = [
  { id: '1', lines: [line('D17W151', 'CASHMERE LL EXTRA', 47.09), { description: 'Sales Tax Total', amount: 3 }] },
  { id: '2', lines: [line('D17W151', 'CASHMERE LL EXTRA', 141.27)] },
  { id: '3', lines: [line('D17W151', 'CASHMERE LL EXTRA', 213)] },
  { id: '4', lines: [line('D17W151', 'CASHMERE LL EXTRA', 43.6), line('D17W151', 'CASHMERE LL EXTRA', 174.4)] },
  { id: '5', lines: [line('05GLSWB', '5 GL BLUE PAIL SW', 11.03)] },
  { id: '6', lines: [line('K48W51', 'EMERALD EXSA EXTRA', 63.6), line('K48W51', 'EMERALD EXSA EXTRA', 127.2)] },
  { id: '7', lines: [{ description: 'Product Number: \nDescription: LACQUER THINNER GAL', amount: 26.34 }] },
];

const got = assignGallons(bills);
assertEq(got[0].gallons, 1, 'one can');
assertEq(got[0].unknownLines, 0, 'one can complete');
assertEq(got[1].gallons, 3, 'three cans');
assertEq(got[2].gallons, null, 'odd price is not guessed');
assertEq(got[2].unknownLines, 1, 'odd price flagged');
assertEq(got[3].gallons, 5, '1 can plus 4 cans');
assertEq(got[4].gallons, null, 'pail is not paint');
assertEq(got[4].unknownLines, 0, 'pail is not a missing coating');
assertEq(got[5].gallons, 3, '1 gal plus 2 gal on one invoice');
assertEq(got[6].gallons, 1, 'thinner marked GAL');
assertEq(explicitGallons('5 GL BLUE PAIL SW'), null, 'pail text is not gallons of paint');
assertEq(explicitGallons('Product Number: B52F20\nDescription: GLY SRS 20GL SA CL'), null, '20GL in a name is not 20 gallons');

console.log('paintGallons.test.js: all assertions passed');
