import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEEDS } from '../lib/original-room.mjs';

test('conversation uses the original normal pace, independently of boost mode', () => {
  assert.deepEqual(SPEEDS.normal.read, [4, 12]);
  assert.deepEqual(SPEEDS.normal.spark, [150, 330]);
  assert.equal(SPEEDS.normal.cooldown, 8);
  assert.equal(SPEEDS.normal.perMin, 10);
});
