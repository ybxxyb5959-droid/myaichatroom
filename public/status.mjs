// Which limit windows to show for one AI, from the CLI's own usage report. A GPT Pro plan has no
// 5-hour window, only the weekly one. Gemini shows whatever buckets its CLI reports (maybe weekly only).
export function limitWindows(id, usage) {
  const list = (usage?.windows || []).filter((w) => !w.minor && (w.id === '5h' || w.id === 'week'));
  const noFiveHour = id === 'gpt' && /^pro/i.test(usage?.plan || '');
  return list.filter((w) => !(noFiveHour && w.id === '5h')).sort((a, b) => (a.id === '5h' ? -1 : b.id === '5h' ? 1 : 0));
}
// Battery colour from the remaining share: plenty / getting low / nearly empty.
export const batteryLevel = (pct) => (pct < 20 ? 'low' : pct < 50 ? 'mid' : 'ok');

// One plain status per AI. Finding the program is not enough: "활성" needs a real call
// that worked with the model in use and no failure after it.
export const FAIL_WINDOW_MS = 30 * 60 * 1000;
// available: program found · loginStatus: 'ok'|'fail'|'unknown'|null · call: last real call with this
// model {status, kind, at} · enabled: user's participation switch · busy: answering now
export function memberStatus({ available, enabled, busy, checking, loginStatus, call, now = Date.now() }) {
  if (!available || loginStatus === 'fail' || (call?.status === 'fail' && call.kind === 'auth')) return { key: 'setup', text: '연결 설정 필요' };
  if (!enabled) return { key: 'rest', text: '쉬는 중' };
  if (busy) return { key: 'busy', text: '답변 중' };
  if (checking) return { key: 'check', text: '연결 확인 중' };
  if (call?.status === 'fail' && now - call.at < FAIL_WINDOW_MS) return { key: 'unavailable', text: '지금은 이용 불가' };
  if (call?.status === 'ok') return { key: 'active', text: '활성' };
  return { key: 'check', text: '연결 확인 필요' };
}
