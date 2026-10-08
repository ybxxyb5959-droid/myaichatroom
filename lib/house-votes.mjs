// Only actual, distinct AI turns can create a vote. Options are data, never code.
import { snapshot, markUndo } from './life.mjs';
import { projectStatus } from './house-project.mjs';
import { enroll, winner } from './house-story.mjs';

const MIN = 60000;
const label = (value) => String(value || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 100);
const error = (message) => Object.assign(new Error(message), { status: 409 });
const day = (now) => new Date(now).toLocaleDateString('en-CA');

function preview(house, option) {
  const actions = option.actions;
  if (!Array.isArray(actions) || !actions.length || actions.length > 2) throw error('투표는 가구 한 개의 배치만 선택할 수 있어요.');
  const last = actions.at(-1);
  if (!['place', 'relocate'].includes(last?.type)
    || (actions.length === 2 && (actions[0]?.type !== 'define' || last.type !== 'place'
      || actions[0].name !== last.def || house.def(actions[0].name)))) throw error('가구 배치 선택지를 확인하세요.');
  const copy = Object.create(Object.getPrototypeOf(house));
  Object.assign(copy, house, { s: structuredClone(house.s), painted: 0 });
  for (const action of actions) copy.act(option.by, action);
  if ((house.s.planning || house.s.project === 'spacious') && projectStatus(house).passagesOpen && !projectStatus(copy).passagesOpen) {
    throw error('이 배치는 집의 통로를 막아요.');
  }
  return copy.s;
}

function subject(house, actions) {
  const a = actions.at(-1);
  if (a.type === 'relocate') {
    const item = house.s.items.find((it) => it.id === Number(a.itemId));
    return { key: `item:${a.itemId}`, original: JSON.stringify(item) };
  }
  return { key: `new:${a.def}`, original: JSON.stringify(house.s.items.filter((it) => it.def === a.def)) };
}

function validSubject(house, option, expected) {
  return JSON.stringify(subject(house, option.actions)) === JSON.stringify(expected);
}

function commit(house, option, expected, text, now) {
  if (!validSubject(house, option, expected)) throw error('대상 가구가 바뀌어 기존 선택지를 적용하지 않았어요.');
  const state = preview(house, option), before = snapshot(house);
  Object.assign(house.s, { defs: state.defs, items: state.items, nextId: state.nextId });
  house.s.rev++;
  markUndo(house, before, option.by, text, now);
  const action = option.actions.at(-1);
  house.walkNear(option.by, Number(action.x), Number(action.z));
  house.s.log.push({ kind: 'build', id: option.by, source: 'system', text, at: now });
}

export function votePrompt(house) {
  const p = house.s.decorProposal, v = house.s.decorVote;
  if (v?.status === 'open') return '\n[배치 투표 진행 중] 선택 대상은 건드리지 말고 다른 작업을 계속한다.';
  if (!p) return '';
  return `\n[동료의 실제 배치 제안 #${p.id}] ${p.option.by}: ${p.option.label}\n`
    + JSON.stringify(p.option.actions) + '\n다른 안이 꼭 필요할 때만 같은 가구의 counter를 제출한다. 동의하면 say로 답한다.';
}

export function acceptProposal(house, actor, reply, now, humans = [], ai = house.ids) {
  if (!house.ids.includes(actor) || !label(reply.say) || house.s.decorVote?.status === 'open') return false;
  const meta = house.s.voteMeta, today = day(now);
  if (meta.day !== today) { meta.day = today; meta.count = 0; }
  if (meta.count >= 3 || (meta.lastAt !== null && now - meta.lastAt < 30 * MIN)) return false;
  const p = house.s.decorProposal;
  const raw = p ? reply.counter : reply.proposal;
  if (!raw || (p && (raw.proposalId !== p.id || actor === p.option.by))) return false;
  const option = { by: actor, label: label(raw.label), say: label(reply.say), actions: structuredClone(raw.actions) };
  if (!option.label) throw error('배치 제안의 이유가 필요해요.');
  preview(house, option);
  const target = subject(house, option.actions);
  if (!p) {
    house.s.decorProposal = { id: meta.nextId++, option, subject: target, deadline: now + 5 * MIN };
    return true;
  }
  if (p.subject.key !== target.key || !validSubject(house, p.option, p.subject)) throw error('같은 가구에 대한 대안만 투표할 수 있어요.');
  const first = preview(house, p.option), second = preview(house, option);
  const placement = (state) => state.items.map((it) => ({
    def: it.def, x: it.x, z: it.z, rot: it.rot, parts: state.defs[it.def]?.parts, use: state.defs[it.def]?.use,
  }));
  if (JSON.stringify(placement(first)) === JSON.stringify(placement(second))) return false;
  house.s.decorProposal = null;
  house.s.decorVote = { id: p.id, status: 'open', subject: p.subject,
    options: [p.option, option], deadline: now + 5 * MIN };
  meta.count++; meta.lastAt = now;
  if (humans.length) {
    enroll(house.s.decorVote, humans, ai);
    for (const [i, o] of house.s.decorVote.options.entries()) {
      if (ai.includes(o.by)) house.s.decorVote.ballots[`ai:${o.by}`] = { choice: i, at: now, source: 'ai', opinion: o.say };
    }
  } else if (house.s.mode === 'auto') settleVote(house, p.id, 0, now, true);
  return true;
}

export function settleVote(house, id, choice, now, automatic = false) {
  const vote = house.s.decorVote;
  if (!vote || vote.status !== 'open' || vote.id !== id) throw error('이미 끝났거나 없는 투표예요.');
  if (!automatic && now >= vote.deadline) throw error('투표 시간이 끝났어요.');
  if (!Number.isInteger(choice) || choice < 0 || choice >= vote.options.length) throw error('선택지를 확인하세요.');
  const before = structuredClone(house.s);
  const option = vote.options[choice];
  try {
    const text = `${vote.ballots ? '공동 다수결 적용' : automatic ? '기본안 자동 적용' : '사용자 선택 적용'}: ${option.label}`;
    try {
      commit(house, option, vote.subject, text, now);
      vote.status = 'applied'; vote.result = text;
    } catch (e) {
      vote.status = 'expired'; vote.result = e.message;
      house.s.log.push({ kind: 'event', id: 'house', source: 'system', text: e.message, at: now });
    }
    vote.choice = choice; vote.appliedAt = now;
    (house.s.voteHistory ??= []).push(structuredClone(vote));
    house.save();
  } catch (e) { house.s = before; throw e; }
  return vote;
}

export function advanceVotes(house, now) {
  const vote = house.s.decorVote;
  if (vote?.status === 'open' && now >= vote.deadline) {
    settleVote(house, vote.id, vote.ballots ? winner(vote) : 0, now, true);
    return true;
  }
  const p = house.s.decorProposal;
  if (!p || now < p.deadline) return false;
  const before = structuredClone(house.s);
  try {
    try { commit(house, p.option, p.subject, `추가 대안 없이 제안 진행: ${p.option.label}`, now); }
    catch (e) { house.s.log.push({ kind: 'event', id: 'house', source: 'system', text: e.message, at: now }); }
    house.s.decorProposal = null;
    house.save();
  } catch (e) { house.s = before; throw e; }
  return true;
}
