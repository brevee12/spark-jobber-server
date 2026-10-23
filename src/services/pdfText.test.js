/**
 * Run: node src/services/pdfText.test.js
 */
import { pdfBytes } from './pdfText.js';

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

const source = Buffer.from([1, 2, 3, 4]);
const copied = pdfBytes(source);
assert(!Buffer.isBuffer(copied), 'a Buffer is copied to a plain Uint8Array');
assert(copied instanceof Uint8Array, 'copy is a Uint8Array');
assert(copied.length === 4 && copied[2] === 3, 'copy keeps the bytes');
assert(copied !== source, 'copy is not the original Buffer');

const already = new Uint8Array([9]);
assert(pdfBytes(already) === already, 'a plain Uint8Array is reused');

console.log('pdfText.test.js ok');
