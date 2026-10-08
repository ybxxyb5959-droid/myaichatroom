// Live progress of AI runs. Shows only events the server recorded (SSE + stored history); nothing is invented here.
const $ = (selector) => document.querySelector(selector);
const modeNames = { analysis: 'AI 분석', explore: '자동 탐색 분석', plan: '작업 계획 수립', proposal: '수정안 생성', 'plan.proposals': '여러 파일 수정안 생성',
  changes: '파일·문서 변경안 생성', docs: '문서 분석', image: '이미지 생성·편집', 'image.analyze': '이미지 분석', office: '문서 생성·수정', image: '이미지 작업', big: '대용량 파일 분석' };
const icons = { done: '✓', active: '◌', failed: '✗' };
const pad = (n) => String(n).padStart(2, '0');
export const clock = (ms) => { const total = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`; };

export function createProgress({ getScope, onTerminal, onCancel }) {
  const panel = $('#taskProgress'), title = $('#taskProgressTitle'), list = $('#taskProgressSteps'), errorLine = $('#taskProgressError');
  const cancel = $('#taskProgressCancel'), history = $('#taskProgressHistory'), runList = $('#taskProgressRuns');
  let source = null, scopeKey = '', offset = 0, runs = [], tick = null, polling = null;
  const upsert = (run) => { const i = runs.findIndex((r) => r.id === run.id); if (i >= 0) runs[i] = run; else runs.push(run); };
  const scoped = (run) => { const s = getScope(); return s && run.projectId === s.projectId && run.sessionId === s.sessionId; };
  const now = () => Date.now() + offset;

  function stepLine(event) {
    const li = document.createElement('li');
    li.dataset.state = event.state;
    const mark = document.createElement('span'); mark.className = 'task-step-mark'; mark.textContent = icons[event.state] || '·'; mark.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = event.text;
    const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = { done: '완료: ', active: '진행 중: ', failed: '실패: ' }[event.state] || '';
    li.append(mark, sr, text);
    return li;
  }
  // Counts come from recorded events, so "files analyzed" is the number of files the server really read.
  function summary(run) {
    const lines = [];
    if (run.stats.folders) lines.push({ state: 'done', text: `폴더 ${run.stats.folders}곳 조회` });
    if (run.stats.files) lines.push({ state: 'done', text: `파일 ${run.stats.files}개 분석 (${run.stats.bytes.toLocaleString('ko-KR')}바이트)` });
    if (run.stats.aiCalls) lines.push({ state: 'done', text: `AI 호출 ${run.stats.aiCalls}회` });
    for (const event of run.events) if (event.kind === 'save' || event.kind === 'result') lines.push({ state: event.state, text: event.text });
    return lines;
  }
  const current = () => runs.filter(scoped).at(-1) || null;

  function render() {
    const run = current();
    const past = runs.filter(scoped).filter((r) => r !== run && r.status !== 'running').reverse();
    panel.hidden = !run && !past.length;
    if (!run) { title.textContent = ''; list.replaceChildren(); errorLine.hidden = true; cancel.hidden = true; }
    else {
      const elapsed = (run.endedAt || now()) - run.startedAt;
      const label = { running: '🟠 작업 진행 중', completed: '🟢 작업 완료', failed: '🔴 작업 실패', cancelled: '⚪ 작업 취소됨' }[run.status];
      title.textContent = `${label.slice(0, 2)} ${clock(elapsed)} · ${label.slice(3)} · ${modeNames[run.mode] || run.mode}`;
      title.dataset.status = run.status;
      const items = run.status === 'running' ? run.events.slice(-9) : summary(run);
      if (run.status !== 'running' && run.status !== 'completed') items.unshift(...run.events.slice(-4));
      list.replaceChildren(...items.map(stepLine));
      errorLine.hidden = !run.error;
      errorLine.textContent = run.error ? `원인: ${run.error}` : '';
      cancel.hidden = run.status !== 'running';
      if (run.status !== 'running' && run.endedAt) title.title = `${new Date(run.startedAt).toLocaleTimeString('ko-KR')} 시작 · ${new Date(run.endedAt).toLocaleTimeString('ko-KR')} 종료`;
    }
    history.hidden = !past.length;
    $('#taskProgressHistory > summary').textContent = `이 세션의 작업 이력 (${past.length})`;
    runList.replaceChildren(...past.map((r) => {
      const li = document.createElement('li');
      const head = document.createElement('div');
      const mark = { completed: '🟢', failed: '🔴', cancelled: '⚪' }[r.status] || '🟠';
      head.textContent = `${mark} ${clock((r.endedAt || r.startedAt) - r.startedAt)} · ${modeNames[r.mode] || r.mode} · ${new Date(r.startedAt).toLocaleString('ko-KR')}${r.error ? ` · ${r.error}` : ''}`;
      const detail = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = `기록 ${r.events.length}건`;
      const inner = document.createElement('ul'); inner.className = 'task-progress-steps';
      inner.append(...r.events.map(stepLine));
      detail.append(sum, inner);
      li.append(head, detail);
      return li;
    }));
    clearInterval(tick);
    if (run?.status === 'running') tick = setInterval(render, 1000);
  }

  function handle(name, data) {
    offset = data.now - Date.now();
    if (name === 'snapshot') { runs = data.runs; render(); return; }
    const before = runs.find((r) => r.id === data.run.id);
    upsert(data.run);
    render();
    if (before?.status === 'running' && data.run.status !== 'running') onTerminal?.(data.run);
  }

  function connect() {
    const scope = getScope();
    const key = scope ? `${scope.projectId}:${scope.sessionId}` : '';
    if (key === scopeKey && (source || polling)) return;
    scopeKey = key;
    source?.close(); source = null; clearInterval(polling); polling = null;
    runs = [];
    if (!scope) { render(); return; }
    const query = `projectId=${encodeURIComponent(scope.projectId)}&sessionId=${encodeURIComponent(scope.sessionId)}`;
    if (typeof EventSource === 'function') {
      source = new EventSource(`/api/tasks/events?${query}`);
      for (const name of ['snapshot', 'run']) source.addEventListener(name, (event) => { try { handle(name, JSON.parse(event.data)); } catch { /* ignore a malformed frame */ } });
      // EventSource reconnects by itself; the snapshot sent on reconnect resynchronises the view.
    } else {
      const poll = async () => { try { const r = await (await fetch(`/api/tasks/runs?${query}`, { cache: 'no-store' })).json(); handle('snapshot', r); } catch { /* retry */ } };
      poll(); polling = setInterval(poll, 1500);
    }
  }
  function disconnect() { source?.close(); source = null; clearInterval(polling); polling = null; clearInterval(tick); scopeKey = ''; }
  cancel.onclick = () => onCancel?.();
  return { connect, disconnect, render, current };
}
