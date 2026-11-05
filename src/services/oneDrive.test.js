import assert from 'node:assert/strict';
import { oneDrivePath, uploadOneDriveFile } from './oneDrive.js';

assert.equal(
  oneDrivePath({ jobNumber: '26054', clientName: 'Olsen / Door', filename: '2026-07-08 111.pdf' }),
  'Veenstra Jobs/26054 Olsen Door/Sherwin/2026-07-08 111.pdf',
  'job folder drops slashes'
);

let called = null;
const result = await uploadOneDriveFile({
  path: 'Veenstra Jobs/26054/Sherwin/a.pdf',
  bytes: Buffer.from('pdf'),
  fetchImpl: async (url, init) => {
    called = { url, init };
    if (String(url).includes('oauth')) {
      return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'item-1', webUrl: 'https://onedrive.example/a.pdf' }) };
  },
});

assert.equal(result.stored, false, 'upload waits until OneDrive is connected');
assert.equal(called, null, 'no request is made without a token');

console.log('oneDrive.test.js: all assertions passed');
