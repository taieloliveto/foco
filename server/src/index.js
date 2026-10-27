// Servidor de Foco (Cloudflare Worker): cuentas, sesión, sincronización y avisos (Web Push) de recordatorios.
import { mergeState, sanitizeState } from './merge.js';
import { sendPush } from './push.js';

const TOKEN_TTL = 60 * 86400;        // las sesiones duran 60 días
const MAX_BODY = 900000;             // bytes por sincronización

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashPass(pw, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt: btoa(String.fromCharCode(...salt)), hash: btoa(String.fromCharCode(...new Uint8Array(bits))) };
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function makeToken(email, env) {
  const p = b64u(enc.encode(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + TOKEN_TTL })));
  return p + '.' + await hmac(p, env.SERVER_SECRET);
}
async function verifyToken(token, env) {
  if (!token) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  if (!safeEq(await hmac(p, env.SERVER_SECRET), sig)) return null;
  try {
    const o = JSON.parse(dec.decode(b64uToBytes(p)));
    return o.x > Date.now() / 1000 && typeof o.e === 'string' ? o.e : null;
  } catch (_) { return null; }
}

const HOUR = 3600000, STALE = 2 * 86400000, MAX_SUBS = 5;

/* Próximo recordatorio pendiente de enviar (ms) o 0. Ignora los que vencieron hace más de 2 días. */
export function nextDue(u, now) {
  if (!u.push || !u.push.length) return 0;
  let best = 0;
  for (const t of Object.values((u.data && u.data.tasks) || {})) {
    if (t.del || t.s === 'done' || !t.r || t.r < now - STALE) continue;
    if ((u.sent || {})[t.id] === t.r) continue;
    if (!best || t.r < best) best = t.r;
  }
  return best;
}
async function setIdx(env, email, due) {
  const idx = JSON.parse((await env.KV.get('idx')) || '{}');
  if ((idx[email] || 0) === due) return;
  if (due) idx[email] = due; else delete idx[email];
  await env.KV.put('idx', JSON.stringify(idx));
}

/* Cron (cada minuto): envía los recordatorios vencidos. Una lectura de `idx` por minuto; el resto solo si hay algo. */
export async function runReminders(env, now, fetchFn) {
  now = now || Date.now();
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0 };
  let idx = JSON.parse((await env.KV.get('idx')) || '{}');
  if (new Date(now).getUTCMinutes() === 0 && now % HOUR < 60000) {      // una vez por hora se reconstruye el índice
    idx = {};
    let cursor;
    do {
      const l = await env.KV.list({ prefix: 'user:', cursor });
      for (const k of l.keys) {
        const raw = await env.KV.get(k.name);
        if (!raw) continue;
        const d = nextDue(JSON.parse(raw), now);
        if (d) idx[k.name.slice(5)] = d;
      }
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
    await env.KV.put('idx', JSON.stringify(idx));
  }
  let sent = 0;
  for (const [email, due] of Object.entries(idx)) {
    if (due > now) continue;
    const raw = await env.KV.get('user:' + email);
    if (!raw) { await setIdx(env, email, 0); continue; }
    const u = JSON.parse(raw);
    u.sent = u.sent || {};
    let changed = false;
    for (const t of Object.values((u.data && u.data.tasks) || {})) {
      if (t.del || t.s === 'done' || !t.r || t.r > now || t.r < now - STALE || u.sent[t.id] === t.r) continue;
      const msg = { title: t.t, body: reminderBody(t), tag: 'task-' + t.id, url: '/?task=' + t.id, id: t.id, r: t.r };
      const dead = []; let ok = 0;
      for (const sub of u.push || []) {
        const o = {};
        try {
          const st = await sendPush(sub, msg, env, fetchFn, o);
          if (st === 404 || st === 410) dead.push(sub.endpoint);
          else if (st < 300) { sent++; ok++; }
          else u.pushErr = { at: now, status: st, host: new URL(sub.endpoint).host, detail: o.detail || '' };
        } catch (e) { u.pushErr = { at: now, status: 0, host: '', detail: String((e && e.message) || e).slice(0, 160) }; }
      }
      if (dead.length) u.push = u.push.filter(s => !dead.includes(s.endpoint));
      // Si no llegó a ningún dispositivo se reintenta cada minuto (hasta 5 veces); recién después se da por enviado.
      u.tries = u.tries || {};
      const k = t.id + ':' + t.r;
      if (!ok && (u.push || []).length && (u.tries[k] = (u.tries[k] || 0) + 1) < 5) { changed = true; continue; }
      delete u.tries[k]; u.sent[t.id] = t.r; changed = true;
    }
    for (const id of Object.keys(u.sent)) if (!(u.data.tasks || {})[id]) { delete u.sent[id]; changed = true; }
    if (changed) await env.KV.put('user:' + email, JSON.stringify(u));
    await setIdx(env, email, nextDue(u, now));
  }
  return { sent };
}
function reminderBody(t) {
  const when = t.tm ? 'Hoy a las ' + t.tm : '';
  return t.n ? t.n.slice(0, 120) : when || 'Es hora de hacerlo.';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    };
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (!env.SERVER_SECRET) return j({ error: 'Falta configurar SERVER_SECRET en el servidor' }, 500);

    try {
      if (url.pathname === '/health') return j({ ok: true });
      if (url.pathname === '/config') return j({ vapid: env.VAPID_PUBLIC && env.VAPID_PRIVATE ? env.VAPID_PUBLIC : '' });

      if (url.pathname === '/signup' && req.method === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(em) || em.length > 254) return j({ error: 'Ingresá un email válido' }, 400);
        if (typeof password !== 'string' || password.length < 8 || password.length > 200) return j({ error: 'La contraseña debe tener entre 8 y 200 caracteres' }, 400);
        if (await env.KV.get('user:' + em)) return j({ error: 'Ya existe una cuenta con ese email' }, 409);
        const { salt, hash } = await hashPass(password);
        await env.KV.put('user:' + em, JSON.stringify({ salt, hash, data: sanitizeState(null), createdAt: Date.now() }));
        return j({ token: await makeToken(em, env) });
      }

      if (url.pathname === '/login' && req.method === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        const bad = () => j({ error: 'Email o contraseña incorrectos' }, 401);
        if (typeof password !== 'string' || password.length > 200) return bad();
        const raw = await env.KV.get('user:' + em);
        if (!raw) return bad();
        const u = JSON.parse(raw);
        const { hash } = await hashPass(password, u.salt);
        if (!safeEq(hash, u.hash)) return bad();
        return j({ token: await makeToken(em, env) });
      }

      const email = await verifyToken((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env);

      if (url.pathname === '/data' && req.method === 'GET') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        return j({ data: sanitizeState(JSON.parse(raw).data) });
      }

      if (url.pathname === '/data' && req.method === 'PUT') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const body = await req.text();
        if (body.length > MAX_BODY) return j({ error: 'Demasiados datos' }, 413);
        const incoming = JSON.parse(body).data;
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        const u = JSON.parse(raw);
        const before = JSON.stringify(sanitizeState(u.data));
        const merged = mergeState(u.data, incoming);
        // KV gratis permite pocas escrituras por día: solo se escribe si algo cambió.
        if (JSON.stringify(merged) !== before) {
          u.data = merged;
          await env.KV.put('user:' + email, JSON.stringify(u));
          if (u.push && u.push.length) await setIdx(env, email, nextDue(u, Date.now()));
        }
        return j({ data: merged });
      }

      if (url.pathname === '/push/subscribe' && req.method === 'POST') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const { sub } = await req.json();
        const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 600 &&
          sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;
        if (!ok) return j({ error: 'Suscripción inválida' }, 400);
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        const u = JSON.parse(raw);
        u.push = (u.push || []).filter(s => s.endpoint !== sub.endpoint);
        u.push.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() });
        u.push = u.push.slice(-MAX_SUBS);
        await env.KV.put('user:' + email, JSON.stringify(u));
        await setIdx(env, email, nextDue(u, Date.now()));
        return j({ ok: true });
      }

      if (url.pathname === '/push/unsubscribe' && req.method === 'POST') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const { endpoint } = await req.json();
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        const u = JSON.parse(raw);
        u.push = (u.push || []).filter(s => s.endpoint !== endpoint);
        await env.KV.put('user:' + email, JSON.stringify(u));
        await setIdx(env, email, nextDue(u, Date.now()));
        return j({ ok: true });
      }

      if (url.pathname === '/push/test' && req.method === 'POST') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return j({ error: 'El servidor no tiene avisos configurados' }, 501);
        const raw = await env.KV.get('user:' + email);
        const u = raw ? JSON.parse(raw) : null;
        if (!u || !(u.push || []).length) return j({ error: 'Este dispositivo no está suscripto' }, 400);
        let sent = 0; const results = [];
        for (const sub of u.push) {
          const o = {}, host = new URL(sub.endpoint).host;
          try {
            const st = await sendPush(sub, { title: 'Foco', body: '¡Los avisos funcionan! 🎉', tag: 'test', url: '/' }, env, env.__fetch, o);
            if (st < 300) sent++;
            results.push({ host, status: st, detail: o.detail || '' });
          } catch (e) { results.push({ host, status: 0, detail: String((e && e.message) || e).slice(0, 160) }); }
        }
        return j({ sent, results, lastError: u.pushErr || null });
      }

      if (url.pathname === '/account' && req.method === 'DELETE') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        await env.KV.delete('user:' + email);
        return j({ ok: true });
      }

      return j({ error: 'No encontrado' }, 404);
    } catch (err) {
      return j({ error: 'Error del servidor' }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch(() => {}));
  }
};
