import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonFile } from './atomic.mjs';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const day = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const SESSION_COOKIE = 'room_access';

// Secrets are stored only as hashes. Display names never determine permission or usage.
export class Sharing {
  constructor(root, clock = Date.now) {
    this.clock = clock;
    this.file = path.join(root, 'data', 'sharing.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = readJsonFile(this.file, { version: 2, limit: 100, invites: {}, sessions: {}, guests: {}, usage: {} });
    // Adopt the requested shared 100-call pool once, without resetting spent
    // calls or any existing per-person safety caps.
    if (this.data.version === 1) { this.data.version = 2; this.data.limit = 100; this.save(); }
    this.attempts = new Map();
    this.lastPost = new Map();
  }
  save() { writeJsonFile(this.file, this.data); }
  prune() {
    for (const [key, item] of Object.entries(this.data.invites)) if (item.exp <= this.clock()) delete this.data.invites[key];
    for (const [key, item] of Object.entries(this.data.sessions)) if (item.exp <= this.clock()) delete this.data.sessions[key];
    for (const key of Object.keys(this.data.usage)) if (key !== day(this.clock())) delete this.data.usage[key];
  }
  invite(role, { maxUses = 1 } = {}) {
    if (!['owner', 'guest'].includes(role)) fail('초대 종류를 확인하세요.');
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10 || (role === 'owner' && maxUses !== 1))
      fail('친구 초대는 최대 10명, 방장 연결은 1회만 사용할 수 있습니다.');
    this.prune();
    if (Object.keys(this.data.invites).length >= 100) fail('사용하지 않는 초대를 취소해 주세요.');
    const secret = token(), id = crypto.randomUUID(), exp = this.clock() + (role === 'owner' ? 10 * 60000 : 24 * 3600000);
    this.data.invites[digest(secret)] = { id, role, exp, maxUses, uses: 0 };
    this.save();
    return { secret, id, role, exp, maxUses };
  }
  throttle(ip) {
    const now = this.clock();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    if (this.attempts.size > 1000) fail('입장 요청이 많습니다. 잠시 후 다시 시도하세요.', 429);
    const entry = this.attempts.get(ip) || { count: 0, until: now + 60000 };
    entry.count++;
    this.attempts.set(ip, entry);
    if (entry.count > 20) fail('입장 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.', 429);
  }
  redeem(secret, name, since, ownerName, { guestOnly = false } = {}) {
    if (typeof secret !== 'string' || secret.length !== 43) fail('초대가 만료되었거나 취소되었습니다.', 401);
    const key = digest(secret), invitation = this.data.invites[key];
    if (!invitation || invitation.exp <= this.clock()) fail('초대가 만료되었거나 이미 사용되었습니다.', 401);
    if (guestOnly && invitation.role !== 'guest') fail('공개 주소에서는 친구 초대만 사용할 수 있습니다.', 403);
    const before = structuredClone(this.data);
    let guestId = null;
    if (invitation.role === 'guest') {
      if (typeof name !== 'string') fail('이름을 입력해 주세요.');
      name = name.normalize('NFC').trim();
      if (!name || [...name].length > 24 || /[\p{C}<>]/u.test(name)) fail('이름은 특수 제어문자 없이 1~24자로 입력하세요.');
      if ([ownerName, '방장', '관리자', 'system', 'user', 'Claude', 'GPT', 'Gemini'].some((x) => x?.toLowerCase() === name.toLowerCase()))
        fail('방장·AI 이름과 다른 이름을 사용해 주세요.');
      if (Object.values(this.data.guests).some((g) => !g.revoked && g.name.toLowerCase() === name.toLowerCase())) fail('이미 사용 중인 이름입니다.');
      if (Object.values(this.data.guests).filter((g) => !g.revoked).length >= 50) fail('친구는 최대 50명까지 입장할 수 있습니다.');
      guestId = crypto.randomUUID();
      this.data.guests[guestId] = { id: guestId, name, since, joinedAt: this.clock(), limit: null, revoked: false };
    }
    const secretSession = token(), sessionId = digest(secretSession);
    this.data.sessions[sessionId] = { role: invitation.role, guestId, exp: this.clock() + 30 * 86400000 };
    invitation.uses = (invitation.uses || 0) + 1;
    if (invitation.uses >= (invitation.maxUses || 1)) delete this.data.invites[key];
    try { this.budget(); this.save(); } catch (error) { this.data = before; throw error; }
    return { secret: secretSession, identity: { ...this.data.sessions[sessionId], sessionId }, guest: guestId && this.data.guests[guestId] };
  }
  identity(req) {
    const value = (req.headers.cookie || '').match(/(?:^|;\s*)room_access=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    if (!value) return null;
    const sessionId = digest(value), record = this.data.sessions[sessionId];
    const identity = record && { ...record, sessionId };
    return this.valid(identity) ? identity : null;
  }
  valid(identity) {
    if (!identity) return false;
    const record = this.data.sessions[identity.sessionId];
    return !!record && record.exp > this.clock()
      && (record.role === 'owner' || !!this.data.guests[record.guestId] && !this.data.guests[record.guestId].revoked);
  }
  cookie(secret, secure) {
    // Installed-app launches need the session on top-level GET navigation.
    // The server separately enforces same-origin writes and blocks cross-site APIs.
    return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${secret ? 30 * 86400 : 0}${secure ? '; Secure' : ''}`;
  }
  logout(identity) { if (identity) { delete this.data.sessions[identity.sessionId]; this.save(); } }
  revokeInvite(id) {
    for (const [key, item] of Object.entries(this.data.invites)) if (item.id === id) delete this.data.invites[key];
    this.save();
  }
  revokeGuest(id) {
    const guest = this.data.guests[id];
    if (!guest) fail('친구가 없습니다.', 404);
    const before = structuredClone(this.data);
    guest.revoked = true;
    for (const [key, item] of Object.entries(this.data.sessions)) if (item.guestId === id) delete this.data.sessions[key];
    try { this.budget(); this.save(); } catch (error) { this.data = before; throw error; }
    return guest;
  }
  budget() {
    const key = day(this.clock());
    const used = this.data.usage[key] ??= { total: 0, guests: {} };
    // Membership, not open tabs, determines shares: reconnecting cannot refund
    // a spent call or repeatedly take a new share.
    const people = Object.values(this.data.guests).filter(g => !g.revoked);
    const signature = JSON.stringify([this.data.limit, people.map(g => [g.id, g.limit])]);
    if (used.signature !== signature) {
      let left = Math.max(0, this.data.limit - used.total);
      const capacity = Object.fromEntries(people.map(g => [g.id,
        g.limit === null ? left : Math.max(0, g.limit - (used.guests[g.id] || 0))]));
      used.remaining = Object.fromEntries(people.map(g => [g.id, 0]));
      let eligible = people.filter(g => capacity[g.id] > 0);
      while (left && eligible.length) {
        for (const g of eligible) {
          if (!left) break;
          used.remaining[g.id]++; left--;
        }
        eligible = eligible.filter(g => used.remaining[g.id] < capacity[g.id]);
      }
      used.signature = signature;
    }
    return { used, participants: people.length };
  }
  usage(id) {
    const { used, participants } = this.budget();
    const spent = used.guests[id] || 0, remaining = used.remaining[id] || 0;
    return { total: used.total, limit: this.data.limit, used: spent, guestLimit: spent + remaining,
      remaining, participants, personalLimit: this.data.guests[id]?.limit ?? null };
  }
  canCall(id) {
    const guest = this.data.guests[id], value = this.usage(id);
    if (!guest || guest.revoked) fail('입장 권한이 취소되었습니다.', 401);
    if (value.total >= value.limit || !value.remaining) fail('오늘 배정된 친구 AI 한도를 모두 사용했습니다. 일반 채팅은 계속할 수 있습니다.', 429);
  }
  charge(id) {
    const before = structuredClone(this.data);
    try {
      this.canCall(id);
      this.prune();
      const { used } = this.budget();
      used.total++; used.guests[id] = (used.guests[id] || 0) + 1;
      used.remaining[id]--;
      // Commit before a provider call, including failures and cancellations.
      this.save();
    } catch (error) { this.data = before; throw error; }
  }
  posting(id) {
    if (this.clock() - (this.lastPost.get(id) ?? -Infinity) < 1000) fail('메시지는 1초 간격으로 보내 주세요.', 429);
    this.lastPost.set(id, this.clock());
  }
  limits({ total, guestId, limit }) {
    const check = (n) => { if (!Number.isInteger(n) || n < 0 || n > 1000) fail('한도는 0~1000 사이의 정수로 입력하세요.'); };
    if (total !== undefined) check(total);
    if (guestId !== undefined) {
      if (limit !== null) check(limit);
      if (!this.data.guests[guestId] || this.data.guests[guestId].revoked) fail('친구가 없습니다.', 404);
    }
    const before = structuredClone(this.data);
    if (total !== undefined) this.data.limit = total;
    if (guestId !== undefined) this.data.guests[guestId].limit = limit;
    try { this.budget(); this.save(); } catch (error) { this.data = before; throw error; }
  }
  ownerView() {
    this.prune();
    return { usage: this.usage(), invites: Object.values(this.data.invites),
      guests: Object.values(this.data.guests).filter((g) => !g.revoked).map((g) => ({ ...g, usage: this.usage(g.id) })),
      devices: Object.entries(this.data.sessions).filter(([, s]) => s.role === 'owner').map(([id, s]) => ({ id, exp: s.exp })) };
  }
}
