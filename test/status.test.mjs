import test from 'node:test';
import assert from 'node:assert/strict';
import { memberStatus } from '../public/status.mjs';

test('a signed-in AI that has not been called yet shows as connected, like the first-run guide', () => {
  const base = { available: true, enabled: true, busy: false, checking: false, call: null };
  assert.equal(memberStatus({ ...base, loginStatus: 'ok' }).text, '연결됨');
  assert.equal(memberStatus({ ...base, loginStatus: 'unknown' }).text, '연결 확인 필요');
  assert.equal(memberStatus({ ...base, loginStatus: 'fail' }).text, '로그인 확인 필요');
  assert.equal(memberStatus({ ...base, loginStatus: 'ok', enabled: false }).text, '쉬는 중');
  assert.equal(memberStatus({ ...base, loginStatus: 'ok', call: { status: 'ok', at: 1 } }).text, '활성');
});
