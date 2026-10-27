/* Lógica de datos compartida entre la app y el servidor.
   FUENTE ÚNICA: shared/merge.js. Después de editarla corré `npm run sync-shared`
   (copia a web/merge.js y a server/src/merge.js). No edites esas copias a mano.

   Forma de los datos (todo se identifica por id y se combina entidad por entidad; gana el cambio más reciente `u`):
   {
     name, nameU,                              cómo te llamamos
     inbox:    { id: { id, t, c, u, del } },   ideas capturadas sin clasificar
     tasks:    { id: { id, t, n, s, p, d, tm, r, rk, pr, par, ev, evl, dn, c, u, del } }
                  t título · n notas · s estado (todo|doing|done) · p prioridad 0-3
                  d fecha 'AAAA-MM-DD' · tm hora 'HH:MM' · r recordatorio (ms) · rk tipo de recordatorio
                  pr proyecto · par tarea madre (subtareas) · ev/evl bloque en Google Calendar · dn cuándo se completó
     projects: { id: { id, n, e, ar, c, u, del } },
     lists:    { id: { id, n, e, k, c, u, del, items: { id: { id, n, no, d, dn, c, u, del } } } },
     last, lastU                               última lista abierta
   } */

const DAY = 86400000, TOMB_TTL = 30 * DAY;
const LIM = { inbox: 1000, tasks: 3000, projects: 100, lists: 100, items: 1000 };
const idOk = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const str = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';
const num = x => Number.isFinite(+x) ? +x : 0;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const TASK_STATES = ['todo', 'doing', 'done'];
const REMINDER_KINDS = ['', 'at', '10m', '1h', 'day9', 'prev9', 'custom'];
const LIST_KINDS = ['wish', 'course', 'book', 'place', 'custom'];
const ymdOk = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const hmOk = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/* Emoji de una lista/proyecto: un solo carácter emoji (banderas, familias y teclas incluidas) o vacío. */
const EMO = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣/u;
const isEmoji = g => typeof g === 'string' && g.length > 0 && g.length <= 16 && EMO.test(g);
function firstEmoji(s) {
  s = typeof s === 'string' ? s.trim() : '';
  if (!s) return '';
  let g;
  try { const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next(); g = it.done ? '' : it.value.segment; }
  catch (_) { g = Array.from(s)[0] || ''; }
  return isEmoji(g) ? g : '';
}

function emptyState() { return { name: '', nameU: 0, inbox: {}, tasks: {}, projects: {}, lists: {}, last: '', lastU: 0 }; }

/* ---- Limpieza de cada tipo de entidad: devuelve la entidad saneada o null si no sirve ---- */
const isObj = x => x && typeof x === 'object';
function fixInbox(r, id) {
  if (!isObj(r)) return null;
  const del = !!r.del, t = del ? '' : str(r.t, 500).trim();
  if (!t && !del) return null;
  return { id, t, c: num(r.c), u: num(r.u), del };
}
function fixTask(r, id) {
  if (!isObj(r)) return null;
  const del = !!r.del, t = str(r.t, 200).trim();
  if (!t && !del) return null;
  const s = TASK_STATES.includes(r.s) ? r.s : 'todo', u = num(r.u);
  const rr = num(r.r) > 0 ? Math.round(num(r.r)) : 0;
  return {
    id, t, n: del ? '' : str(r.n, 2000), s,
    p: Math.min(3, Math.max(0, Math.round(num(r.p)))),
    d: ymdOk(r.d) ? r.d : '', tm: hmOk(r.tm) ? r.tm : '',
    r: rr, rk: rr && REMINDER_KINDS.includes(r.rk) ? r.rk : (rr ? 'custom' : ''),
    pr: idOk(r.pr) ? r.pr : '', par: idOk(r.par) ? r.par : '',
    ev: str(r.ev, 120), evl: typeof r.evl === 'string' && /^https:\/\/\S+$/.test(r.evl) ? r.evl.slice(0, 400) : '',
    dn: s === 'done' ? (num(r.dn) || u) : 0, c: num(r.c), u, del
  };
}
function fixProject(r, id) {
  if (!isObj(r)) return null;
  return { id, n: str(r.n, 80).trim() || 'Proyecto', e: firstEmoji(r.e), ar: !!r.ar, c: num(r.c), u: num(r.u), del: !!r.del };
}
function fixItem(r, id) {
  if (!isObj(r)) return null;
  const del = !!r.del, n = str(r.n, 200).trim();
  if (!n && !del) return null;
  const d = !!r.d, u = num(r.u);
  return { id, n, no: del ? '' : str(r.no, 1000), d, dn: d ? (num(r.dn) || u) : 0, c: num(r.c), u, del };
}
function fixList(r, id, now) {
  if (!isObj(r)) return null;
  const del = !!r.del;
  return {
    id, n: str(r.n, 80).trim() || 'Lista', e: firstEmoji(r.e), k: LIST_KINDS.includes(r.k) ? r.k : 'custom',
    c: num(r.c), u: num(r.u), del, items: del ? {} : pruneMap(r.items, LIM.items, now, fixItem)
  };
}

/* Aplica `fix` a cada entrada, descarta tumbas viejas y acota la cantidad (se queda con lo más reciente). */
function pruneMap(src, max, now, fix) {
  const out = {};
  if (!isObj(src)) return out;
  let arr = [];
  for (const id of Object.keys(src).slice(0, max * 2)) {
    if (!idOk(id)) continue;
    const e = fix(src[id], id, now);
    if (!e) continue;
    if (e.del && e.u < now - TOMB_TTL) continue;
    arr.push(e);
  }
  if (arr.length > max) { arr.sort((a, b) => (a.del - b.del) || b.u - a.u); arr = arr.slice(0, max); }
  for (const e of arr) out[e.id] = e;
  return out;
}

/* Limpia y acota cualquier dato que venga de afuera (disco, red, otro dispositivo). */
function sanitizeState(d, now) {
  now = now || Date.now();
  const out = emptyState();
  if (!isObj(d)) return out;
  out.name = str(typeof d.name === 'string' ? d.name.trim() : '', 30);
  out.nameU = num(d.nameU);
  out.inbox = pruneMap(d.inbox, LIM.inbox, now, fixInbox);
  out.tasks = pruneMap(d.tasks, LIM.tasks, now, fixTask);
  out.projects = pruneMap(d.projects, LIM.projects, now, fixProject);
  out.lists = pruneMap(d.lists, LIM.lists, now, fixList);
  out.last = idOk(d.last) ? d.last : '';
  out.lastU = num(d.lastU);
  return out;
}

/* ---- Combinación de dos estados: gana el cambio más reciente por entidad ---- */
function mergeMap(a, b) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id], y = b[id];
    out[id] = !x ? y : !y ? x : (x.u >= y.u ? x : y);
  }
  return out;
}
function mergeState(a, b, now) {
  a = sanitizeState(a, now);
  b = sanitizeState(b, now);
  const out = emptyState();
  out.inbox = mergeMap(a.inbox, b.inbox);
  out.tasks = mergeMap(a.tasks, b.tasks);
  out.projects = mergeMap(a.projects, b.projects);
  for (const id of new Set([...Object.keys(a.lists), ...Object.keys(b.lists)])) {
    const x = a.lists[id], y = b.lists[id];
    if (!x || !y) { out.lists[id] = x || y; continue; }
    const w = x.u >= y.u ? x : y;
    out.lists[id] = { ...w, items: w.del ? {} : mergeMap(x.items, y.items) };
  }
  const wl = a.lastU >= b.lastU ? a : b;
  out.last = wl.last; out.lastU = wl.lastU;
  const wn = a.nameU >= b.nameU ? a : b;
  out.name = wn.name; out.nameU = wn.nameU;
  return sanitizeState(out, now);
}
