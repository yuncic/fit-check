import assert from 'node:assert/strict';
import { createRateLimiter } from './rate-limit.mjs';

let now = 0;
const allow = createRateLimiter(2, 60_000, () => now);
assert.equal(allow('same-ip'), true);
assert.equal(allow('same-ip'), true);
assert.equal(allow('same-ip'), false);
now = 60_000;
assert.equal(allow('same-ip'), true);
console.log('rate limit check passed');
