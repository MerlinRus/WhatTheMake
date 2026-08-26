import assert from 'node:assert/strict';
import test from 'node:test';

import { createPasswordHasher } from '../src/identity/passwords.js';

const testHasher = createPasswordHasher({
  cost: 1_024,
  blockSize: 8,
  parallelization: 1,
});

test('password hashes are salted, versioned, and timing-safe verifiable', async () => {
  const password = 'correct horse battery staple';
  const first = await testHasher.hash(password);
  const second = await testHasher.hash(password);

  assert.match(first, /^scrypt\$v=1\$n=1024,r=8,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(await testHasher.verify(password, first), true);
  assert.equal(await testHasher.verify('wrong password value', first), false);
  assert.equal(await testHasher.verify(password, 'malformed'), false);

  const { verify } = testHasher;
  assert.equal(await verify(password, 'malformed'), false);
});
