import test from 'node:test';
import assert from 'node:assert/strict';
import { houseBounds, furnitureParts } from '../public/house-view.mjs';

test('empty and asymmetric saved grids produce a centered overview', () => {
  assert.deepEqual(houseBounds({ size: 20, floors: [], walls: [] }), { x: 10, z: 10, span: 20 });
  const bounds = houseBounds({ floors: [[2, 4, 'wood'], [9, 6, 'wood']], walls: [[2, 3, 'white', true]] });
  assert.deepEqual(bounds, { x: 6, z: 5, span: 8 });
});

test('3D furniture uses the saved rotation and world position without modifying saved designs', () => {
  const data = { defs: { sofa: { parts: [{ s: 'box', x: 0, y: .5, z: 0, w: 2, h: 1, d: 1, c: 'blue' }] } },
    items: [{ def: 'sofa', x: 3, z: 4, rot: 1 }, { def: 'missing', x: 0, z: 0, rot: 0 }] };
  const before = JSON.stringify(data);
  assert.deepEqual(furnitureParts(data), [{ s: 'box', x: 3, y: .5, z: 4, w: 1, h: 1, d: 2, c: 'blue' }]);
  assert.equal(JSON.stringify(data), before);
});
