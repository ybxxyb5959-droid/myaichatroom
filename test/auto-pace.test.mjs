import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS } from '../lib/auto.mjs';

test('automatic conversation intervals match the requested ranges at every activity level', () => {
  const minute = 60000;
  assert.deepEqual(LEVELS.low.callMs, [15 * minute, 25 * minute]);
  assert.deepEqual(LEVELS.medium.callMs, [5 * minute, 10 * minute]);
  assert.deepEqual(LEVELS.high.callMs, [2 * minute, 5 * minute]);
});
