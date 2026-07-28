import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRateLimiter } from './rate-limit.mjs';

let now = 0;
const allow = createRateLimiter(2, 60_000, () => now);
assert.equal(allow('same-ip'), true);
assert.equal(allow('same-ip'), true);
assert.equal(allow('same-ip'), false);
now = 60_000;
assert.equal(allow('same-ip'), true);

const page = readFileSync(new URL('./fit-check-prototype.html', import.meta.url), 'utf8');
for (const shop of ['무신사', '4910', '에이블리', '지그재그']) assert.match(page, new RegExp(shop));
assert.doesNotMatch(page, /네이버 쇼핑/);
assert.match(page, /name="gender" value="male" required/);
assert.match(page, /name="gender" value="female" required/);
assert.match(page, /#submit\.loading::before/);
assert.match(page, /submit\.classList\.add\("loading"\)/);
assert.match(page, /submit\.classList\.remove\("loading"\)/);
console.log('prototype checks passed');
