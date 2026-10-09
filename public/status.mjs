// Which limit windows to show for one AI, from the CLI's own usage report. A GPT Pro plan has no
// 5-hour window, only the weekly one. Gemini shows whatever buckets its CLI reports (maybe weekly only).
export function limitWindows(id, usage) {
  const list = (usage?.windows || []).filter((w) => !w.minor && (w.id === '5h' || w.id === 'week'));
  const noFiveHour = id === 'gpt' && /^pro/i.test(usage?.plan || '');
  return list.filter((w) => !(noFiveHour && w.id === '5h')).sort((a, b) => (a.id === '5h' ? -1 : b.id === '5h' ? 1 : 0));
}
// Battery colour from the remaining share: plenty / getting low / nearly empty.
export const batteryLevel = (pct) => (pct < 20 ? 'low' : pct < 50 ? 'mid' : 'ok');

// Remaining share of one AI: the tightest of its windows. A failed, restored (cached)
// or stale report is "unknown" — nothing is guessed from it.
export const LOW_QUOTA = 20;
export const QUOTA_STALE_MS = 30 * 60 * 1000;
export function quotaOf(id, usage, now = Date.now()) {
  const windows = limitWindows(id, usage).filter((w) => Number.isFinite(w.remainingPct));
  if (!usage?.ok || usage.restored || !Number.isFinite(usage.at) || now - usage.at > QUOTA_STALE_MS || !windows.length) return { known: false };
  const pct = Math.round(Math.min(...windows.map((w) => w.remainingPct)));
  return { known: true, pct, level: batteryLevel(pct), low: pct < LOW_QUOTA };
}

// One plain status per AI. Finding the program is not enough: "활성" needs a real call that worked.
// Errors are shown from `health`, the server's own record of what holds a member back (quota rest,
// sign-in, model setting, a short cooldown with its end time); the UI keeps no time window of its own.
const HEALTH_TEXT = { quota: '한도 회복 대기', auth: '로그인 확인 필요', model: '모델 설정 확인 필요' };
// Member connectivity follows the latest real call, including the light auto model.
// Model-specific pickers still use the selected model's own result.
export function latestCall(check) {
  return Object.values(check.models).reduce((latest, call) => !latest || call.at > latest.at ? call : latest, null);
}
// available: program found · loginStatus: 'ok'|'fail'|'unknown'|null · call: last real call with this
// model {status, kind, at} · enabled: user's participation switch · busy: answering now
export function memberStatus({ available, enabled, busy, checking, loginStatus, call, health = null, now = Date.now() }) {
  if (!available) return { key: 'setup', text: '연결 설정 필요' };
  if (HEALTH_TEXT[health?.state]) return { key: health.state, text: HEALTH_TEXT[health.state] };
  if (loginStatus === 'fail' || (call?.status === 'fail' && call.kind === 'auth')) return { key: 'auth', text: HEALTH_TEXT.auth };
  if (!enabled) return { key: 'rest', text: '쉬는 중' };
  if (busy) return { key: 'busy', text: '답변 중' };
  if (checking) return { key: 'check', text: '연결 확인 중' };
  // A passing error: resting until the server's end time, then back to "활성" at once.
  if (health?.state === 'cooldown' && health.until > now) {
    return { key: 'cooldown', text: `잠시 쉬는 중 · ${Math.max(1, Math.ceil((health.until - now) / 60000))}분 남음` };
  }
  if (call?.status === 'fail' && call.kind === 'model') return { key: 'model', text: HEALTH_TEXT.model };
  if (call?.status === 'ok' || (call?.status === 'fail' && call.kind !== 'quota')) return { key: 'active', text: '활성' };
  // Signed in but not called yet (a fresh install): the guide already says "연결됐어요", so the member list agrees.
  if (loginStatus === 'ok') return { key: 'active', text: '연결됨' };
  return { key: 'check', text: '연결 확인 필요' };
}
