// Pruebas de la lógica de datos, del servidor (KV simulado) y del cifrado de avisos. Uso: node scripts/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeState, sanitizeState, emptyState, firstEmoji } from '../server/src/merge.js';
import worker, { runReminders, nextDue } from '../server/src/index.js';
import { encryptPayload, decryptPayload, b64u, unb64u, vapidAuth } from '../server/src/push.js';

let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  ✓', name); }, e => { console.log('  ✗', name); throw e; });
const T = Date.now();

console.log('datos');
await ok('las copias de merge.js están sincronizadas', () => {
  const shared = readFileSync(new URL('../shared/merge.js', import.meta.url), 'utf8');
  assert.equal(readFileSync(new URL('../web/merge.js', import.meta.url), 'utf8'), shared);
  assert.ok(readFileSync(new URL('../server/src/merge.js', import.meta.url), 'utf8').startsWith(shared));
});
const tk = (id, t, u, x = {}) => ({ id, t, s: 'todo', c: 1, u, del: false, ...x });
await ok('une tareas, bandeja y listas de dos dispositivos', () => {
  const a = { inbox: { i1: { id: 'i1', t: 'idea', c: 1, u: T } }, tasks: { t1: tk('t1', 'A', T) }, lists: { l1: { id: 'l1', n: 'Libros', k: 'book', u: T, items: { x1: { id: 'x1', n: 'Dune', u: T } } } } };
  const b = { inbox: { i2: { id: 'i2', t: 'otra', c: 1, u: T } }, tasks: { t2: tk('t2', 'B', T) }, lists: { l1: { id: 'l1', n: 'Libros', k: 'book', u: T, items: { x2: { id: 'x2', n: 'Emma', u: T } } } } };
  const m = mergeState(a, b);
  assert.deepEqual(Object.keys(m.inbox).sort(), ['i1', 'i2']);
  assert.deepEqual(Object.keys(m.tasks).sort(), ['t1', 't2']);
  assert.deepEqual(Object.keys(m.lists.l1.items).sort(), ['x1', 'x2']);
});
await ok('gana el cambio más reciente y la tumba más nueva borra', () => {
  const a = { tasks: { t1: tk('t1', 'Vieja', T - 5000, { s: 'done', dn: T - 5000 }) } };
  const b = { tasks: { t1: tk('t1', 'Nueva', T) } };
  assert.equal(mergeState(a, b).tasks.t1.t, 'Nueva');
  assert.equal(mergeState(a, b).tasks.t1.s, 'todo');
  const c = { tasks: { t1: tk('t1', '', T + 1, { del: true }) } };
  assert.equal(mergeState(b, c).tasks.t1.del, true);
});
await ok('es conmutativo e idempotente', () => {
  const a = { name: 'Ana', nameU: 2, tasks: { t1: tk('t1', 'A', T), t2: tk('t2', 'B', T - 9) }, last: 'l1', lastU: 5 };
  const b = { name: 'Anita', nameU: 3, tasks: { t1: tk('t1', 'A2', T + 1) }, last: 'l2', lastU: 4 };
  assert.deepEqual(mergeState(a, b, T), mergeState(b, a, T));
  const m = mergeState(a, b, T);
  assert.deepEqual(mergeState(m, m, T), m);
  assert.equal(m.name, 'Anita'); assert.equal(m.last, 'l1');
});
await ok('limpia datos malos', () => {
  const s = sanitizeState({ tasks: { 'x y': tk('x y', 'mal id', T), t1: { id: 't1', t: 'ok', s: 'raro', p: 99, d: '2026-13-45', tm: '25:99', r: -4, evl: 'javascript:alert(1)' }, t2: { id: 't2', t: '' }, t3: 'texto' }, inbox: { i: { t: '   ' } }, last: '../x', lists: { l: { n: '', e: 'hola', k: 'zzz', items: { a: { n: 'x'.repeat(999) } } } } });
  assert.deepEqual(Object.keys(s.tasks), ['t1']);
  const t = s.tasks.t1;
  assert.equal(t.s, 'todo'); assert.equal(t.p, 3); assert.equal(t.d, ''); assert.equal(t.tm, ''); assert.equal(t.r, 0); assert.equal(t.evl, '');
  assert.equal(Object.keys(s.inbox).length, 0); assert.equal(s.last, '');
  assert.equal(s.lists.l.n, 'Lista'); assert.equal(s.lists.l.e, ''); assert.equal(s.lists.l.k, 'custom'); assert.equal(s.lists.l.items.a.n.length, 200);
});
await ok('tareas hechas guardan cuándo; reabrir lo limpia; recordatorio sin tipo → custom', () => {
  const s = sanitizeState({ tasks: { a: { id: 'a', t: 'x', s: 'done', u: 77 }, b: { id: 'b', t: 'y', s: 'todo', dn: 5 }, c: { id: 'c', t: 'z', r: 1234 } } });
  assert.equal(s.tasks.a.dn, 77); assert.equal(s.tasks.b.dn, 0); assert.equal(s.tasks.c.rk, 'custom');
});
await ok('tumbas viejas se descartan y se acota la cantidad', () => {
  const s = sanitizeState({ tasks: { old: { id: 'old', t: '', del: true, u: T - 40 * 86400000 }, nw: { id: 'nw', t: '', del: true, u: T } } }, T);
  assert.deepEqual(Object.keys(s.tasks), ['nw']);
  const many = {}; for (let i = 0; i < 3500; i++) many['t' + i] = tk('t' + i, 'x' + i, i + 1);
  assert.equal(Object.keys(sanitizeState({ tasks: many }).tasks).length, 3000);
});
await ok('el orden manual de las tareas se conserva, se acota y gana el cambio más nuevo', () => {
  const s = sanitizeState({ tasks: { a: tk('a', 'A', T, { o: 3 }), b: tk('b', 'B', T, { o: -4 }), c: tk('c', 'C', T, { o: 'x' }), d: tk('d', 'D', T, { o: 9e9 }) } });
  assert.deepEqual([s.tasks.a.o, s.tasks.b.o, s.tasks.c.o, s.tasks.d.o], [3, 0, 0, 1000000]);
  const m = mergeState({ tasks: { a: tk('a', 'A', T, { o: 3 }) } }, { tasks: { a: tk('a', 'A', T + 5, { o: 1 }) } });
  assert.equal(m.tasks.a.o, 1);
});
await ok('emoji: solo uno y válido', () => {
  assert.equal(firstEmoji('📚 libros'), '📚'); assert.equal(firstEmoji('abc'), ''); assert.equal(firstEmoji('👨‍👩‍👧'), '👨‍👩‍👧'); assert.equal(firstEmoji(''), '');
});

console.log('cifrado de avisos');
// Vector de prueba oficial de RFC 8291 §5
const RFC = {
  plain: 'When I grow up, I want to be a watermelon',
  asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPub: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPriv: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};
const jwk = (priv, pub) => { const p = unb64u(pub); return { kty: 'EC', crv: 'P-256', d: priv, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)) }; };
await ok('reproduce exacto el ejemplo del RFC 8291', async () => {
  const body = await encryptPayload({ keys: { p256dh: RFC.uaPub, auth: RFC.auth } }, RFC.plain, { asPrivJwk: jwk(RFC.asPriv, RFC.asPub), asPub: unb64u(RFC.asPub), salt: unb64u(RFC.salt) });
  assert.equal(b64u(body), RFC.body);
});
await ok('descifra el ejemplo del RFC con la clave del navegador', async () => {
  assert.equal(await decryptPayload(unb64u(RFC.body), jwk(RFC.uaPriv, RFC.uaPub), unb64u(RFC.uaPub), unb64u(RFC.auth)), RFC.plain);
});
await ok('ida y vuelta con claves nuevas (con tildes y emoji)', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)), priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ title: 'Llamar al dentista 🦷', body: 'Mañana a las 9' });
  const body = await encryptPayload({ keys: { p256dh: b64u(pub), auth: b64u(auth) } }, msg);
  assert.equal(await decryptPayload(body, priv, pub, auth), msg);
});
const vkp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vpub = new Uint8Array(await crypto.subtle.exportKey('raw', vkp.publicKey)), vjwk = await crypto.subtle.exportKey('jwk', vkp.privateKey);
const VENV = { VAPID_PUBLIC: b64u(vpub), VAPID_PRIVATE: vjwk.d, VAPID_SUBJECT: 'mailto:yo@mail.com' };
await ok('la firma VAPID es válida', async () => {
  const h = await vapidAuth('https://push.example.com/abc', VENV);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h); assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, 'https://push.example.com'); assert.equal(claims.sub, 'mailto:yo@mail.com');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkp.publicKey, unb64u(m[3]), new TextEncoder().encode(m[1] + '.' + m[2])));
});

console.log('servidor');
const store = new Map();
const KV = { get: async k => store.get(k) ?? null, put: async (k, v) => { KV.writes++; store.set(k, v); }, delete: async k => { store.delete(k); }, list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }), writes: 0 };
const env = { KV, SERVER_SECRET: 'secreto-de-prueba-largo', ...VENV };
const call = async (method, path, body, token) => {
  const r = await worker.fetch(new Request('https://x.test' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json() };
};
let token;
await ok('registro y entrada validan datos', async () => {
  assert.equal((await call('POST', '/signup', { email: 'no-es-email', password: '12345678' })).status, 400);
  assert.equal((await call('POST', '/signup', { email: 'a@b.com', password: 'corta' })).status, 400);
  const s = await call('POST', '/signup', { email: 'Ana@Mail.com', password: 'contraseña-1' });
  assert.equal(s.status, 200); token = s.body.token;
  assert.equal((await call('POST', '/signup', { email: 'ana@mail.com', password: 'otra-contra-2' })).status, 409);
  assert.equal((await call('POST', '/login', { email: 'ana@mail.com', password: 'mala-mala-1' })).status, 401);
  assert.equal((await call('POST', '/login', { email: 'ANA@mail.com', password: 'contraseña-1' })).status, 200);
});
await ok('sin sesión válida no hay acceso', async () => {
  assert.equal((await call('GET', '/data')).status, 401);
  assert.equal((await call('GET', '/data', null, token.slice(0, -2) + 'xx')).status, 401);
  assert.equal((await call('POST', '/push/subscribe', {}, null)).status, 401);
});
await ok('dos dispositivos se combinan', async () => {
  await call('PUT', '/data', { data: { tasks: { t1: tk('t1', 'Del celu', T) } } }, token);
  const r = await call('PUT', '/data', { data: { tasks: { t2: tk('t2', 'De la compu', T) }, name: 'Ana', nameU: T } }, token);
  assert.deepEqual(Object.keys(r.body.data.tasks).sort(), ['t1', 't2']);
  assert.equal((await call('GET', '/data', null, token)).body.data.name, 'Ana');
});
await ok('no escribe en KV si no hubo cambios', async () => {
  const before = KV.writes;
  const g = await call('GET', '/data', null, token);
  await call('PUT', '/data', { data: g.body.data }, token);
  assert.equal(KV.writes, before);
});
await ok('/config informa la clave pública de avisos', async () => {
  assert.equal((await call('GET', '/config')).body.vapid, VENV.VAPID_PUBLIC);
});

// Suscripción falsa (un navegador de mentira que sabe descifrar)
const dev = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const devPub = new Uint8Array(await crypto.subtle.exportKey('raw', dev.publicKey)), devPriv = await crypto.subtle.exportKey('jwk', dev.privateKey);
const devAuth = crypto.getRandomValues(new Uint8Array(16));
const SUB = { endpoint: 'https://push.example.com/send/abc123', keys: { p256dh: b64u(devPub), auth: b64u(devAuth) } };
await ok('suscripciones: valida, guarda, reemplaza y borra', async () => {
  assert.equal((await call('POST', '/push/subscribe', { sub: { endpoint: 'http://x', keys: {} } }, token)).status, 400);
  assert.equal((await call('POST', '/push/subscribe', { sub: SUB }, token)).status, 200);
  assert.equal((await call('POST', '/push/subscribe', { sub: SUB }, token)).status, 200);
  assert.equal(JSON.parse(store.get('user:ana@mail.com')).push.length, 1);
});
await ok('recordatorio vencido: se envía cifrado una sola vez y queda anotado', async () => {
  const due = T + 60000;
  await call('PUT', '/data', { data: { tasks: { r1: tk('r1', 'Llamar al dentista', due + 1, { r: due, rk: 'at', tm: '09:00', n: 'Pedir turno' }), r2: tk('r2', 'Futura', T, { r: due + 3600000, rk: 'at' }), r3: tk('r3', 'Hecha', T, { r: due, s: 'done' }) } } }, token);
  assert.equal(JSON.parse(store.get('idx'))['ana@mail.com'], due);
  const got = [];
  const fakeFetch = async (url, init) => { got.push({ url, init }); return { status: 201 }; };
  assert.equal((await runReminders(env, due - 1000, fakeFetch)).sent, 0);
  const r = await runReminders(env, due + 5000, fakeFetch);
  assert.equal(r.sent, 1); assert.equal(got.length, 1);
  assert.equal(got[0].url, SUB.endpoint); assert.equal(got[0].init.headers['Content-Encoding'], 'aes128gcm'); assert.ok(got[0].init.headers.Authorization.startsWith('vapid t='));
  const msg = JSON.parse(await decryptPayload(new Uint8Array(got[0].init.body), devPriv, devPub, devAuth));
  assert.equal(msg.title, 'Llamar al dentista'); assert.equal(msg.body, 'Pedir turno'); assert.equal(msg.tag, 'task-r1'); assert.equal(msg.url, '/?task=r1');
  assert.equal((await runReminders(env, due + 70000, fakeFetch)).sent, 0, 'no se repite');
  assert.equal(JSON.parse(store.get('idx'))['ana@mail.com'], due + 3600000, 'queda agendada la siguiente');
  assert.equal((await runReminders(env, due + 3600000 + 1000, fakeFetch)).sent, 1);
  assert.equal(JSON.parse(store.get('idx'))['ana@mail.com'], undefined);
});
await ok('si el usuario reprograma, vuelve a avisar', async () => {
  const g = (await call('GET', '/data', null, token)).body.data;
  const t = { ...g.tasks.r1, r: T + 9 * 3600000, u: T + 100000 };
  await call('PUT', '/data', { data: { tasks: { r1: t } } }, token);
  const got = []; await runReminders(env, T + 9 * 3600000 + 1000, async (u, i) => { got.push(u); return { status: 201 }; });
  assert.equal(got.length, 1);
});
await ok('suscripción muerta (410) se elimina', async () => {
  const g = (await call('GET', '/data', null, token)).body.data;
  await call('PUT', '/data', { data: { tasks: { r4: tk('r4', 'x', T + 200000, { r: T + 10 * 3600000 }) } } }, token);
  await runReminders(env, T + 10 * 3600000 + 1000, async () => ({ status: 410 }));
  assert.equal(JSON.parse(store.get('user:ana@mail.com')).push.length, 0);
});
await ok('si el servicio de avisos rechaza (403) se reintenta y se informa el motivo', async () => {
  await call('PUT', '/data', { data: { tasks: { r5: tk('r5', 'Reintento', T + 300000, { r: T + 11 * 3600000, rk: 'at' }) } } }, token);
  await call('POST', '/push/subscribe', { sub: SUB }, token);
  const bad = async () => ({ status: 403, text: async () => 'BadJwtToken' });
  const base = T + 11 * 3600000;
  for (let i = 0; i < 4; i++) { assert.equal((await runReminders(env, base + 1000 + i * 60000, bad)).sent, 0); assert.ok(JSON.parse(store.get('idx'))['ana@mail.com'] <= base, 'sigue pendiente'); }
  const u = JSON.parse(store.get('user:ana@mail.com'));
  assert.equal(u.pushErr.status, 403); assert.equal(u.pushErr.detail, 'BadJwtToken');
  await runReminders(env, base + 5 * 60000, bad);                               // 5.º intento: se da por enviado
  assert.equal(JSON.parse(store.get('idx'))['ana@mail.com'], undefined);
  const prev = env.__fetch; env.__fetch = bad;
  const r = await call('POST', '/push/test', {}, token); env.__fetch = prev;
  assert.equal(r.body.sent, 0); assert.equal(r.body.results[0].status, 403); assert.equal(r.body.results[0].detail, 'BadJwtToken'); assert.equal(r.body.lastError.status, 403);
});
await ok('sin avisos configurados el cron no hace nada', async () => {
  assert.equal((await runReminders({ KV, SERVER_SECRET: 'x' }, T)).sent, 0);
});
await ok('rechaza cuerpos enormes', async () => {
  const big = { tasks: {} }; for (let i = 0; i < 4000; i++) big.tasks['t' + i] = tk('t' + i, 'x'.repeat(200), T);
  assert.equal((await call('PUT', '/data', { data: big }, token)).status, 413);
});
await ok('borrar la cuenta', async () => {
  assert.equal((await call('DELETE', '/account', null, token)).status, 200);
  assert.equal((await call('GET', '/data', null, token)).status, 401);
});
console.log(`\n${n} pruebas OK`);
