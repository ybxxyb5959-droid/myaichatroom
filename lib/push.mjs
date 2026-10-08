// Web Push without extra dependencies: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
// Subscriptions are stored per person; endpoints must belong to a known browser push service so the
// server can never be pointed at an arbitrary or internal address.
import crypto from 'node:crypto';
import https from 'node:https';
import { readJsonFile, writeJsonFile } from './atomic.mjs';

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function allowedEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname)) && endpoint.length <= 1000;
  } catch { return false; }
}

// RFC 8291: the payload a user agent can decrypt with its p256dh key and auth secret.
export function encryptPayload(subscription, payload, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url'), auth = Buffer.from(subscription.keys.auth, 'base64url');
  if (uaPublic.length !== 65 || auth.length !== 16) fail('알림 구독 키가 올바르지 않습니다.');
  if (!ecdh) { ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, asPublic, body]);
}

export class Push {
  constructor(file, { clock = Date.now, send = null, log = () => {} } = {}) {
    Object.assign(this, { file, clock, log });
    this.data = readJsonFile(file, { version: 1, vapid: null, subs: {} });
    this.data.subs ??= {};
    if (!this.data.vapid) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      this.data.vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
        privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
      this.save();
    }
    this.sendRequest = send || ((endpoint, headers, body) => new Promise((resolve) => {
      const req = https.request(endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: 15000 }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', (e) => { this.log(`push ${e.message}`); resolve(0); });
      req.end(body);
    }));
    this.lastSent = new Map();
  }
  save() { writeJsonFile(this.file, this.data); }
  get publicKey() { return this.data.vapid.publicKey; }
  subscribe(person, subscription, prefs = {}) {
    if (!subscription || typeof subscription.endpoint !== 'string' || !allowedEndpoint(subscription.endpoint)) fail('지원하지 않는 알림 서비스 주소입니다.');
    const keys = { p256dh: String(subscription.keys?.p256dh || ''), auth: String(subscription.keys?.auth || '') };
    encryptPayload({ keys }, 'check');
    const list = (this.data.subs[person] ??= []).filter((s) => s.endpoint !== subscription.endpoint);
    if (list.length >= 5) list.shift();
    list.push({ endpoint: subscription.endpoint, keys, createdAt: this.clock(), prefs: { mentions: true, people: prefs.people !== false, ai: prefs.ai === true } });
    // One browser subscription belongs to one person only.
    for (const [other, subs] of Object.entries(this.data.subs)) if (other !== person) this.data.subs[other] = subs.filter((s) => s.endpoint !== subscription.endpoint);
    this.data.subs[person] = list; this.save();
    return { ok: true, count: list.length };
  }
  unsubscribe(person, endpoint) {
    const before = this.data.subs[person]?.length || 0;
    this.data.subs[person] = (this.data.subs[person] || []).filter((s) => endpoint && s.endpoint !== endpoint);
    if (!this.data.subs[person].length) delete this.data.subs[person];
    this.save();
    return { ok: true, removed: before - (this.data.subs[person]?.length || 0) };
  }
  forget(person) { if (this.data.subs[person]) { delete this.data.subs[person]; this.save(); } }
  status(person) { return { supported: true, publicKey: this.publicKey, subscribed: (this.data.subs[person] || []).length }; }
  vapidHeader(endpoint) {
    const audience = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(this.clock() / 1000) + 12 * 3600, sub: 'mailto:ai-chatroom@localhost.invalid' }));
    const signature = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: this.data.vapid.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(signature)}, k=${this.publicKey}`;
  }
  // kind: 'mention' | 'people' | 'ai'. Non-mention alerts are collapsed per person for 30 seconds.
  async notify(person, { kind, title, body, tag }) {
    const subs = (this.data.subs[person] || []).filter((s) => kind === 'mention' ? s.prefs.mentions : kind === 'ai' ? s.prefs.ai : s.prefs.people);
    if (!subs.length) return 0;
    const key = `${person}:${kind === 'mention' ? 'mention' : 'chat'}`;
    if (kind !== 'mention' && this.clock() - (this.lastSent.get(key) || 0) < 30000) return 0;
    this.lastSent.set(key, this.clock());
    let sent = 0;
    for (const sub of subs) {
      const status = await this.sendRequest(sub.endpoint, { TTL: '3600', Urgency: kind === 'mention' ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream', Authorization: this.vapidHeader(sub.endpoint), Topic: tag }, encryptPayload(sub, JSON.stringify({ title, body, tag })));
      if (status === 404 || status === 410) this.unsubscribe(person, sub.endpoint);
      else if (status >= 200 && status < 300) sent++;
      else this.log(`push status ${status}`);
    }
    return sent;
  }
}
