'use strict';
/* Foco — organizador personal (PWA). Usa merge.js (globales: mergeState, sanitizeState, emptyState, norm, firstEmoji, isEmoji) y gcal.js (GCal). */
(() => {
const VERSION = '1.0.0';
const CFG = window.FOCO_CONFIG || {};
const KEY = 'foco.v1', LKEY = 'foco.local';
const $ = s => document.querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
let seq = 0;
const uid = () => Math.random().toString(36).slice(2, 8) + now().toString(36);
const stamp = () => now() + (++seq % 1000) / 1000;
function lastEmoji(s) {
  let out = '';
  try { for (const g of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(s))) if (isEmoji(g.segment)) out = g.segment; }
  catch (_) { out = firstEmoji(Array.from(String(s)).pop() || ''); }
  return out;
}

/* ---------- Fechas (siempre en hora local) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addD = (s, n) => { const d = pYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MON = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const short = s => { const d = pYmd(s); return `${DOW[d.getDay()].slice(0, 3)} ${d.getDate()} ${MON[d.getMonth()].slice(0, 3)}`; };
function dayLabel(s) { const t = today(); return s === t ? 'Hoy' : s === addD(t, 1) ? 'Mañana' : s === addD(t, -1) ? 'Ayer' : short(s); }
const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const nextDow = (from, dow) => { const d = pYmd(from); let n = (dow - d.getDay() + 7) % 7; if (n === 0) n = 7; return addD(from, n); };
const weekend = () => { const d = new Date(); return d.getDay() === 6 ? addD(today(), 0) : nextDow(today(), 6); };
const nextWeek = () => nextDow(today(), 1);

/* ---------- Estado ---------- */
let S = { email: '', token: '', server: '', data: emptyState(), dirty: false };
try {
  const r = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (r && typeof r === 'object') { S.email = String(r.email || ''); S.token = String(r.token || ''); S.server = String(r.server || ''); S.dirty = !!r.dirty; S.data = sanitizeState(r.data); }
} catch (_) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {} };
/* Preferencias de este dispositivo (no se sincronizan) */
let L = { fired: {}, pushEp: '', pushErr: '', notif: false, events: null, open: {} };
try { const r = JSON.parse(localStorage.getItem(LKEY) || 'null'); if (r && typeof r === 'object') L = { ...L, ...r }; } catch (_) {}
const saveL = () => { try { localStorage.setItem(LKEY, JSON.stringify(L)); } catch (_) {} };

let view = 'auth', sheet = null, busy = false, st = 'ok', rev = 0, cur = '', curP = '';
let authMode = 'login', authErr = '', authEmail = S.email, authPass = '', authName = '';
let dragging = false, installEvt = null, tfilter = 'proj', histN = 40, evErr = '', evBusy = false;
const D = () => S.data;

/* ---------- Consultas ---------- */
const tasks = () => Object.values(D().tasks).filter(t => !t.del);
const top = () => tasks().filter(t => !t.par);
const openT = () => top().filter(t => t.s !== 'done');
const subsOf = id => tasks().filter(t => t.par === id).sort((a, b) => a.c - b.c);
const ordK = e => e.o || e.c;
const byOrd = (a, b) => ordK(a) - ordK(b);
const projects = () => Object.values(D().projects).filter(p => !p.del && !p.ar).sort(byOrd);
const proj = id => { const p = D().projects[id]; return p && !p.del ? p : null; };
const lists = () => Object.values(D().lists).filter(l => !l.del).sort((a, b) => a.c - b.c);
const itemsOf = l => Object.values(l.items).filter(i => !i.del);
const inbox = () => Object.values(D().inbox).filter(i => !i.del).sort((a, b) => b.c - a.c);
const curList = () => { const l = D().lists[cur]; return l && !l.del ? l : null; };
const curProj = () => proj(curP);
const cmp = (a, b) => (a.d || '9').localeCompare(b.d || '9') || (a.tm || '99').localeCompare(b.tm || '99') || b.p - a.p || a.c - b.c;
const KINDS = {
  wish: { e: '🎁', n: 'Deseos', ph: 'Mis deseos', done: 'Conseguido', add: 'Agregar algo…' },
  course: { e: '🎓', n: 'Cursos', ph: 'Cursos para hacer', done: 'Terminado', add: 'Agregar algo…' },
  book: { e: '📚', n: 'Libros', ph: 'Libros para leer', done: 'Leído', add: 'Agregar algo…' },
  place: { e: '📍', n: 'Lugares', ph: 'Lugares para ir', done: 'Visitado', add: 'Agregar algo…' },
  custom: { e: '📝', n: 'Otra', ph: 'Mi lista', done: 'Hecho', add: 'Agregar algo…' }
};
const EMOS = ['🎁', '🎓', '📚', '📍', '🎬', '🎧', '🍽️', '✈️', '🏠', '💡', '🛒', '💪', '🎮', '🌱', '🎨', '💼'];

/* ---------- Servidor ---------- */
class ApiErr extends Error { constructor(m, status, net) { super(m); this.status = status; this.net = !!net; } }
const apiBase = () => String(CFG.API_URL || S.server || '').trim().replace(/\/+$/, '');
async function api(path, opts = {}) {
  const base = apiBase();
  if (!base) throw new ApiErr('Falta la URL del servidor', 0);
  const h = { 'Content-Type': 'application/json' };
  if (S.token) h.Authorization = 'Bearer ' + S.token;
  let r;
  try { r = await fetch(base + path, { ...opts, headers: h }); } catch (_) { throw new ApiErr('Sin conexión con el servidor', 0, true); }
  let b = null; try { b = await r.json(); } catch (_) {}
  if (!r.ok) throw new ApiErr((b && b.error) || 'Error del servidor', r.status);
  return b;
}

/* ---------- Sincronización ---------- */
let syncing = false, again = false, syncT = null;
function setSt(v) { st = v; paintSync(); }
function queueSync(ms = 900) { if (!S.token) return; setSt('pend'); clearTimeout(syncT); syncT = setTimeout(() => sync(), ms); }
async function sync() {
  if (!S.token || !apiBase()) return false;
  if (syncing) { again = true; return false; }
  syncing = true;
  const r0 = rev, wasDirty = S.dirty;
  try {
    const res = wasDirty ? await api('/data', { method: 'PUT', body: JSON.stringify({ data: S.data }) }) : await api('/data');
    S.data = mergeState(S.data, res.data);
    if (rev === r0) S.dirty = false; else again = true;
    save(); setSt(S.dirty ? 'pend' : 'ok'); afterRemote();
    return true;
  } catch (e) {
    if (e.status === 401) { expireSession(); return false; }
    setSt(e.net ? 'off' : 'err'); return false;
  } finally { syncing = false; if (again) { again = false; queueSync(300); } }
}
function expireSession() { S.token = ''; save(); authErr = 'Tu sesión venció. Ingresá de nuevo.'; authEmail = S.email; authPass = ''; go('auth'); }
function afterRemote() {
  if (view === 'auth' || sheet || dragging) { paintNav(); return; }
  if ((view === 'list' && !curList()) || (view === 'project' && !curProj())) { go(view === 'list' ? 'lists' : 'tasks'); return; }
  paint(); paintNav();
}
function touch() { S.dirty = true; rev++; save(); queueSync(); }

/* ---------- Texto → fecha/hora ("llamar al dentista mañana a las 18") ---------- */
function parseWhen(s) {
  let t = s.trim().replace(/\s+/g, ' '), d = '', tm = '', m;
  m = t.match(/\s+(?:a\s+las\s+(\d{1,2})(?::(\d{2}))?|(\d{1,2}):(\d{2})|(\d{1,2})\s*hs)$/i);
  if (m) {
    const h = +(m[1] ?? m[3] ?? m[5]), mi = +(m[2] ?? m[4] ?? 0);
    if (h < 24 && mi < 60) { tm = `${pad(h)}:${pad(mi)}`; t = t.slice(0, m.index); }
  }
  m = t.match(/(?:^|\s+)(?:para\s+|el\s+)?(hoy|pasado mañana|mañana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)$/i);
  if (m && t.length > m[0].length) {
    const w = m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    d = w === 'hoy' ? today() : w === 'manana' ? addD(today(), 1) : w === 'pasado manana' ? addD(today(), 2) : nextDow(today(), ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'].indexOf(w));
    t = t.slice(0, m.index);
  }
  if (tm && !d) d = today();
  if (!t.trim()) return { t: s.trim(), d: '', tm: '' };
  return { t: t.trim(), d, tm };
}

/* ---------- Recordatorios ---------- */
function calcR(d, tm, rk, custom) {
  if (rk === 'custom') return custom > 0 ? custom : 0;
  if (!rk || !d) return 0;
  const [Y, M, Dd] = d.split('-').map(Number), [h, mi] = (tm || '09:00').split(':').map(Number);
  const at = (hh, mm, dd = Dd) => new Date(Y, M - 1, dd, hh, mm).getTime();
  return rk === 'at' ? at(h, mi) : rk === '10m' ? at(h, mi) - 600000 : rk === '1h' ? at(h, mi) - 3600000 : rk === 'day9' ? at(9, 0) : rk === 'prev9' ? at(9, 0, Dd - 1) : 0;
}
const RK_LABEL = { '': 'Sin aviso', at: 'A la hora', '10m': '10 minutos antes', '1h': '1 hora antes', day9: 'Ese día a las 9:00', prev9: 'El día anterior a las 9:00', custom: 'Elegir fecha y hora…' };
const rkOptions = (d, tm) => ['', 'at', ...(d && tm ? ['10m', '1h'] : []), ...(d ? ['day9', 'prev9'] : []), 'custom'];
const toLocalInput = ms => { const d = new Date(ms); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* ---------- Mutaciones ---------- */
function newTask(o) {
  const id = uid(), t = now();
  const task = { id, t: '', n: '', s: 'todo', p: 0, d: '', tm: '', r: 0, rk: '', pr: '', par: '', ev: '', evl: '', dn: 0, o: 0, c: stamp(), u: t, del: false, ...o };
  task.r = calcR(task.d, task.tm, task.rk, task.r);
  if (!task.r) task.rk = '';
  D().tasks[id] = task; return task;
}
function capture(text) {
  const lines = String(text).split(/\n+/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  let n = 0;
  for (const s of lines) {
    if (Object.keys(D().inbox).length >= 900) { toast('La bandeja está llena: pasá algunas ideas a tareas'); break; }
    const id = uid(); D().inbox[id] = { id, t: s.slice(0, 500), c: stamp(), u: now(), del: false }; n++;
  }
  if (n) touch();
  return n;
}
const whenText = t => t.d ? `${dayLabel(t.d).toLowerCase()}${t.tm ? ' ' + t.tm : ''}${t.r ? ' · 🔔' : ''}` : '';
function setDone(id, v) {
  const t = D().tasks[id]; if (!t) return;
  t.s = v ? 'done' : 'todo'; t.dn = v ? now() : 0; t.u = now(); touch();
}
function delTask(id) {
  const t = D().tasks[id]; if (!t) return [];
  const ids = [id, ...subsOf(id).map(x => x.id)], u = now();
  ids.forEach(i => { D().tasks[i].del = true; D().tasks[i].u = u; });
  touch(); return ids;
}
function undel(ids) { const u = now(); ids.forEach(i => { if (D().tasks[i]) { D().tasks[i].del = false; D().tasks[i].u = u; } }); touch(); }
function resched(id, d, tm) {
  const t = D().tasks[id]; if (!t) return;
  t.d = d; if (tm !== undefined) t.tm = tm;
  if (tm && !t.rk) t.rk = 'at';
  if (t.rk && t.rk !== 'custom') { t.r = calcR(t.d, t.tm, t.rk); if (!t.r) t.rk = ''; }
  else if (t.rk === 'custom' && t.r) { const o = new Date(t.r); const nd = pYmd(d); nd.setHours(o.getHours(), o.getMinutes()); t.r = nd.getTime(); }
  t.s = t.s === 'done' ? 'todo' : t.s; t.u = now(); touch();
}
function snooze(id, kind) {
  const t = D().tasks[id]; if (!t) return;
  const before = { d: t.d, tm: t.tm, r: t.r, rk: t.rk, s: t.s, dn: t.dn };
  if (kind === 'h1') {
    const x = new Date(now() + 3600000); x.setSeconds(0, 0);
    t.d = ymd(x); t.tm = hm(x.getTime()); t.rk = 'at'; t.r = calcR(t.d, t.tm, 'at'); t.u = now(); touch();
  } else if (kind === 'eve') {
    resched(id, today(), '18:00'); t.rk = 'at'; t.r = calcR(t.d, '18:00', 'at'); touch();
  } else resched(id, kind === 'tom' ? addD(today(), 1) : kind === 'we' ? weekend() : nextWeek());
  L.fired = L.fired || {};
  toast('Reprogramada: ' + dayLabel(t.d) + (t.tm ? ' ' + t.tm : ''), 'Deshacer', () => { Object.assign(t, before, { u: now() }); touch(); paint(); });
}
function newList(name, emoji, kind) {
  const id = uid(), k = KINDS[kind] ? kind : 'custom';
  D().lists[id] = { id, n: (name || '').trim().slice(0, 80) || KINDS[k].ph, e: firstEmoji(emoji), k, c: stamp(), u: now(), del: false, items: {} };
  touch(); return id;
}
function addItems(l, text) {
  const arr = String(text).split(/[\n;]+/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  let n = 0;
  for (const s of arr) {
    if (itemsOf(l).length >= 900) { toast('La lista llegó al máximo'); break; }
    const id = uid(); l.items[id] = { id, n: s[0].toUpperCase().slice(0, 1) + s.slice(1, 200), no: '', d: false, dn: 0, c: stamp(), u: now(), del: false }; n++;
  }
  if (n) { l.u = now(); touch(); }
  return n;
}
function newProject(name, emoji) {
  const id = uid();
  D().projects[id] = { id, n: (name || '').trim().slice(0, 80) || 'Proyecto', e: firstEmoji(emoji), ar: false, o: 0, c: stamp(), u: now(), del: false };
  touch(); return id;
}

/* ---------- Plantillas de HTML ---------- */
const SYL = { ok: 'Sincronizado', pend: 'Guardando…', off: 'Sin conexión', err: 'Error al sincronizar' };
const syncBadge = () => `<span class="sy ${st}" role="status">${SYL[st]}</span>`;
function paintSync() { document.querySelectorAll('.sy').forEach(e => { e.className = 'sy ' + st; e.textContent = SYL[st]; }); }
const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="#fff"/></svg>';
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
const nm = o => `${o.e ? `<span class="em" aria-hidden="true">${esc(o.e)}</span>` : ''}${esc(o.n)}`;

function vAuth() {
  const login = authMode === 'login';
  return `<div class="auth"><div class="logo">${LOGO}</div><h1>Foco</h1>
<p class="mut">Anotá lo que se te ocurre, convertilo en acciones y dejá de depender de tu memoria.</p>
<div class="seg" role="group" aria-label="Modo"><button type="button" data-a="am" data-m="login" aria-pressed="${login}">Ingresar</button><button type="button" data-a="am" data-m="signup" aria-pressed="${!login}">Crear cuenta</button></div>
<form id="af" novalidate>
${login ? '' : `<label class="f">¿Cómo te gustaría que te llamen?<input type="text" data-au="name" value="${esc(authName)}" maxlength="30" placeholder="Tu nombre o apodo" autocomplete="given-name" autocapitalize="words"></label>`}
<label class="f">Email<input type="email" data-au="email" value="${esc(authEmail)}" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false"></label>
<label class="f">Contraseña<input type="password" data-au="pass" value="${esc(authPass)}" autocomplete="${login ? 'current-password' : 'new-password'}" ${login ? '' : 'placeholder="Mínimo 8 caracteres"'}></label>
${CFG.API_URL ? '' : `<label class="f">URL del servidor<input type="url" data-au="server" value="${esc(S.server)}" placeholder="https://foco-server.tu-usuario.workers.dev" autocapitalize="none" spellcheck="false"></label>`}
<p class="err" role="alert">${esc(authErr)}</p>
<button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Un momento…' : login ? 'Ingresar' : 'Crear cuenta'}</button>
</form></div>`;
}

const capForm = (ph, id, inp, cls = '', btn = '+', aria = 'Guardar') => `<form id="${id}" class="qa ${cls}" autocomplete="off"><div class="qr"><input id="${inp}" class="in" type="text" placeholder="${esc(ph)}" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" aria-label="${esc(ph)}"><button class="btn" type="submit" aria-label="${esc(aria)}">${btn}</button></div></form>`;

function vToday() {
  const d = new Date();
  return `<div class="hbg" aria-hidden="true"></div>
<div class="bar clear"><span class="date">${DOW[d.getDay()][0].toUpperCase() + DOW[d.getDay()].slice(1)} ${d.getDate()} de ${MON[d.getMonth()]}</span><span class="rt">${syncBadge()}<button class="icon" data-a="tab" data-t="set" aria-label="Ajustes">${GEAR}</button></span></div>
<section class="hero"><h1 class="hi" id="hi"></h1><p class="ask">¿Qué tenés que hacer?</p>
${capForm('Nueva tarea… (ej: llamar al dentista mañana 18)', 'cf', 'ci', 'home', '+', 'Crear tarea')}</section>
<div id="body"></div>`;
}
function taskRow(t, o = {}) {
  const subs = subsOf(t.id), sd = subs.filter(x => x.s === 'done').length, p = proj(t.pr), td = today();
  const meta = [];
  if (t.d) meta.push(`<span class="mt${t.d < td && t.s !== 'done' ? ' od' : ''}">${dayLabel(t.d)}${t.tm ? ' ' + t.tm : ''}</span>`);
  if (t.r) meta.push('<span class="mt" title="Con aviso">🔔</span>');
  if (t.ev) meta.push('<span class="mt" title="En Google Calendar">📅</span>');
  if (subs.length) meta.push(`<span class="mt">☑ ${sd}/${subs.length}</span>`);
  if (p && !o.noProject) meta.push(`<span class="mt">${p.e ? esc(p.e) + ' ' : ''}${esc(p.n)}</span>`);
  if (t.p && !(t.s === 'done')) meta.unshift(`<span class="mt pp${t.p}">${['', 'Baja', 'Media', 'Alta'][t.p]}</span>`);
  const done = t.s === 'done';
  return `<div class="it pr${done ? 0 : t.p}${done ? ' done' : ''}" data-id="${esc(t.id)}"><button class="chk p${t.p}" data-a="tdone" data-id="${esc(t.id)}" aria-pressed="${done}" aria-label="${done ? 'Reabrir' : 'Completar'} ${esc(t.t)}"><span class="box" aria-hidden="true"></span></button><button class="main" data-a="topen" data-id="${esc(t.id)}"><span class="nm">${esc(t.t)}</span>${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}</button>${o.snz ? `<button class="more" data-a="tsnz" data-id="${esc(t.id)}" aria-label="Posponer ${esc(t.t)}">⏰</button>` : ''}${o.grip ? gripBtn('Reordenar ' + t.t) : ''}</div>`;
}
const GRIP = '<svg viewBox="0 0 12 20" width="12" height="20" fill="currentColor" aria-hidden="true"><circle cx="3" cy="4" r="1.6"/><circle cx="9" cy="4" r="1.6"/><circle cx="3" cy="10" r="1.6"/><circle cx="9" cy="10" r="1.6"/><circle cx="3" cy="16" r="1.6"/><circle cx="9" cy="16" r="1.6"/></svg>';
const gripBtn = label => `<button type="button" class="grip" aria-label="${esc(label)}" title="Arrastrá para reordenar">${GRIP}</button>`;
const secH = (t, extra = '') => `<div class="sec"><h3>${t}</h3>${extra}</div>`;
const fmtEv = e => e.allDay ? 'Todo el día' : `${hm(e.s)}–${hm(e.e)}`;

const PLBL = ['sin prioridad', 'prioridad baja', 'prioridad media', 'prioridad alta'];
function groupsHome() {
  const by = new Map();
  for (const t of openT()) { const k = proj(t.pr) ? t.pr : ''; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
  const out = [];
  for (const p of projects()) if (by.has(p.id)) out.push({ key: p.id, p, tasks: by.get(p.id).sort(byOrd) });
  if (by.has('')) out.push({ key: '', p: null, tasks: by.get('').sort(byOrd) });
  return out;
}
function groupHtml(g, isOpen) {
  const cnt = [0, 0, 0, 0]; g.tasks.forEach(t => cnt[t.p]++);
  const badges = [3, 2, 1, 0].filter(p => cnt[p]).map(p => `<i class="cnt c${p}" aria-label="${cnt[p]} de ${PLBL[p]}" title="${PLBL[p]}">${cnt[p]}</i>`).join('');
  return `<section class="pg${isOpen ? ' open' : ''}" data-key="${esc(g.key || '_none')}"><button class="ph" data-a="ptoggle" data-id="${esc(g.key || '_none')}" aria-expanded="${isOpen}"><span class="chev" aria-hidden="true">›</span><span class="pn">${g.p ? nm(g.p) : 'Sin proyecto'}</span><span class="cnts">${badges}</span></button>${isOpen ? `<div class="pbody" data-sort="tasks">${g.tasks.map(t => taskRow(t, { noProject: 1, grip: 1 })).join('')}</div>` : ''}</section>`;
}
function bodyToday() {
  const td = today(), O = openT().sort(cmp);
  const tod = O.filter(t => t.d && t.d <= td);
  const doneToday = top().filter(t => t.s === 'done' && ymd(new Date(t.dn)) === td).length;
  const ib = inbox().length, G = groupsHome();
  let h = '';
  if (ib) h += `<button class="card inb" data-a="inbox"><b>📥 Bandeja</b><small>${ib} ${ib === 1 ? 'idea' : 'ideas'} sin clasificar · tocá para convertirlas en acciones</small></button>`;
  h += secH(`Para hoy${tod.length ? ' · ' + tod.length : ''}`);
  h += tod.length ? tod.map(t => taskRow(t, { snz: 1 })).join('') : `<div class="empty small-e"><p class="mut">${doneToday ? '¡Terminaste lo de hoy! 🎉' : 'No tenés nada agendado para hoy.'}</p></div>`;
  if (G.length) {
    h += secH(`Pendientes por proyecto · ${O.length}`);
    h += '<div class="pgs">' + G.map(g => groupHtml(g, L.open && g.key in L.open ? !!L.open[g.key] : (L.open && (g.key || '_none') in L.open ? !!L.open[g.key || '_none'] : G.length === 1))).join('') + '</div>';
  }
  if (GCal.enabled()) {
    const evs = todayEvents();
    if (evs.length) h += secH('Próximos eventos') + evs.map(e => `<div class="ev"><span class="evt">${fmtEv(e)}</span><span class="nm">${esc(e.t)}</span></div>`).join('');
    else if (!GCal.linked()) h += `<button class="card" data-a="tab" data-t="agenda"><b>📅 Conectá Google Calendar</b><small>Mirá tus eventos acá y reservá tiempo para lo que tenés que hacer.</small></button>`;
  }
  if (doneToday) h += `<p class="cheer">Hoy completaste ${doneToday} ${doneToday === 1 ? 'tarea' : 'tareas'} ✓</p>`;
  return h;
}
function todayEvents() {
  if (!L.events) return [];
  const t0 = now(), e1 = pYmd(addD(today(), 1)).getTime();
  return L.events.items.filter(e => e.e > t0 && e.s < e1).slice(0, 5);
}

function vTasks() {
  return `<div class="bar"><h1>Proyectos</h1>${syncBadge()}</div>
<div class="seg three" role="group" aria-label="Ver"><button data-a="tf" data-f="proj" aria-pressed="${tfilter === 'proj'}">Proyectos</button><button data-a="tf" data-f="open" aria-pressed="${tfilter === 'open'}">Tareas</button><button data-a="tf" data-f="done" aria-pressed="${tfilter === 'done'}">Hecho</button></div>
${tfilter === 'open' ? capForm('Nueva tarea… (ej: llamar al dentista mañana 18:30)', 'tf-form', 'ti', '', 'Crear', 'Crear tarea') : ''}
<div id="body"></div>`;
}
function bodyTasks() {
  if (tfilter === 'proj') {
    const P = projects();
    let h = P.map(p => { const all = top().filter(t => t.pr === p.id), d = all.filter(t => t.s === 'done').length;
      return `<div class="card pc" data-id="${esc(p.id)}"><button class="pmain" data-a="oproj" data-id="${esc(p.id)}"><b>${nm(p)}</b><small>${all.length ? `${all.length - d} pendientes · ${all.length} en total` : 'Sin tareas'}</small><div class="pbar" aria-hidden="true"><i style="width:${all.length ? Math.round(d / all.length * 100) : 0}%"></i></div></button>${gripBtn('Reordenar ' + p.n)}</div>`; }).join('');
    if (!P.length) h = '<div class="empty"><div class="big" aria-hidden="true">🗂️</div><h2>Todavía no tenés proyectos</h2><p class="mut">Agrupá tareas relacionadas: “Mudanza”, “Trámites”, “Viaje”…</p></div>';
    return `<div id="cards" data-sort="projects">${h}</div><button class="btn newbtn" data-a="newproj">+ Nuevo proyecto</button>`;
  }
  if (tfilter === 'done') return bodyHistory();
  const td = today(), O = openT().sort(cmp);
  const groups = [['Atrasadas', t => t.d && t.d < td], ['Hoy', t => t.d === td], ['Mañana', t => t.d === addD(td, 1)], ['Esta semana', t => t.d > addD(td, 1) && t.d <= addD(td, 7)], ['Más adelante', t => t.d > addD(td, 7)], ['Sin fecha', t => !t.d]];
  let h = '';
  for (const [n, f] of groups) { const g = O.filter(f); if (g.length) h += secH(`${n} · ${g.length}`) + g.map(t => taskRow(t, { snz: n === 'Atrasadas' || n === 'Hoy' })).join(''); }
  return h || '<div class="empty"><div class="big" aria-hidden="true">✨</div><h2>Todo al día</h2><p class="mut">Escribí arriba una tarea nueva, o revisá tu bandeja.</p></div>';
}
/* Historial: tareas completadas y cosas de las listas marcadas como hechas, por día */
function bodyHistory() {
  const ev = [];
  for (const t of top()) if (t.s === 'done') ev.push({ ts: t.dn, kind: 't', t });
  for (const l of lists()) for (const i of itemsOf(l)) if (i.d) ev.push({ ts: i.dn || i.u, kind: 'i', i, l });
  ev.sort((a, b) => b.ts - a.ts);
  if (!ev.length) return '<div class="empty"><div class="big" aria-hidden="true">🏁</div><h2>Todavía no hay historial</h2><p class="mut">Lo que completes aparece acá.</p></div>';
  let h = '', last = '';
  for (const x of ev.slice(0, histN)) {
    const day = ymd(new Date(x.ts));
    if (day !== last) { last = day; const n = ev.filter(y => ymd(new Date(y.ts)) === day).length; h += secH(`${dayLabel(day)} · ${n}`); }
    h += x.kind === 't' ? taskRow(x.t) : `<div class="it done"><button class="chk" data-a="ihist" data-l="${esc(x.l.id)}" data-id="${esc(x.i.id)}" aria-pressed="true" aria-label="Reabrir ${esc(x.i.n)}"><span class="box" aria-hidden="true"></span></button><div class="main"><span class="nm">${esc(x.i.n)}</span><span class="meta"><span class="mt">${KINDS[x.l.k].done} · ${x.l.e ? esc(x.l.e) + ' ' : ''}${esc(x.l.n)}</span></span></div></div>`;
  }
  if (ev.length > histN) h += '<button class="btn ghost" data-a="histmore" style="margin-top:14px">Ver más</button>';
  return h;
}

function vInbox() {
  return `<div class="top"><button class="icon" data-a="tab" data-t="today" aria-label="Volver">‹</button><div class="ttl"><b>Bandeja</b><small>Ideas sin clasificar</small></div>${syncBadge()}</div><div id="body"></div>`;
}
function bodyInbox() {
  const I = inbox();
  if (!I.length) return '<div class="empty"><div class="big" aria-hidden="true">🧘</div><h2>Bandeja vacía</h2><p class="mut">Todo lo que anotes sin clasificar va a parar acá.</p></div>';
  return '<p class="mut small hint">Para cada idea pensá: ¿cuál es el primer paso concreto?</p>' + I.map(i => `<div class="ib"><p>${esc(i.t)}</p><div class="acts"><button data-a="i2t" data-id="${esc(i.id)}">📌 Tarea</button><button data-a="i2l" data-id="${esc(i.id)}">📋 Lista</button><button class="dng" data-a="idel" data-id="${esc(i.id)}" aria-label="Eliminar">🗑</button></div></div>`).join('');
}

function vLists() { return `<div class="bar"><h1>Mis listas</h1>${syncBadge()}</div><div id="body"></div>`; }
function bodyLists() {
  const L2 = lists();
  let h = L2.length ? '<div id="cards">' + L2.map(l => { const it = itemsOf(l), d = it.filter(i => i.d).length;
    return `<button class="card" data-a="olist" data-id="${esc(l.id)}"><b>${nm(l)}</b><small>${it.length ? `${it.length - d} pendientes · ${d} ${KINDS[l.k].done.toLowerCase()}s`.replace('hechos', 'hechos') : 'Vacía'}</small><div class="pbar" aria-hidden="true"><i style="width:${it.length ? Math.round(d / it.length * 100) : 0}%"></i></div></button>`; }).join('') + '</div>'
    : '<div class="empty"><div class="big" aria-hidden="true">📋</div><h2>Todavía no tenés listas</h2><p class="mut">Deseos, cursos, libros, lugares… o las que inventes.</p></div>';
  return h + '<button class="btn newbtn" data-a="newlist">+ Nueva lista</button>';
}
function vList() {
  return `<div class="top"><button class="icon" data-a="tab" data-t="lists" aria-label="Volver a mis listas">‹</button><div class="ttl"><b id="lt"></b><small id="ls"></small></div>${syncBadge()}<button class="icon" data-a="lmenu" aria-label="Opciones de la lista">⋯</button></div>${capForm(KINDS[(curList() || {}).k || 'custom'].add, 'lf', 'li')}<div id="body"></div>`;
}
function bodyList() {
  const l = curList(); if (!l) return '';
  const it = itemsOf(l), p = it.filter(i => !i.d).sort((a, b) => b.c - a.c), d = it.filter(i => i.d).sort((a, b) => b.dn - a.dn);
  $('#lt').innerHTML = nm(l); $('#ls').textContent = !it.length ? 'Lista vacía' : `${p.length} pendientes`;
  const row = i => `<div class="it${i.d ? ' done' : ''}"><button class="chk" data-a="itg" data-id="${esc(i.id)}" aria-pressed="${i.d}" aria-label="${i.d ? 'Reabrir' : KINDS[l.k].done} ${esc(i.n)}"><span class="box" aria-hidden="true"></span></button><button class="main" data-a="ied" data-id="${esc(i.id)}"><span class="nm">${esc(i.n)}</span>${i.no ? `<span class="meta"><span class="mt">${esc(i.no)}</span></span>` : ''}</button></div>`;
  let h = !it.length ? '<div class="empty"><div class="big" aria-hidden="true">📝</div><p class="mut">Escribí arriba lo que quieras guardar.<br>Podés poner varios separados por punto y coma.</p></div>' : p.map(row).join('');
  if (d.length) h += secH(`${KINDS[l.k].done}s · ${d.length}`) + d.map(row).join('');
  return h;
}
function vProject() {
  return `<div class="top"><button class="icon" data-a="back-proj" aria-label="Volver a proyectos">‹</button><div class="ttl"><b id="pt"></b><small id="ps"></small></div>${syncBadge()}<button class="icon" data-a="pmenu" aria-label="Opciones del proyecto">⋯</button></div>${capForm('Nueva tarea del proyecto…', 'pf', 'pi', '', 'Crear', 'Crear tarea')}<div id="body"></div>`;
}
function bodyProject() {
  const p = curProj(); if (!p) return '';
  const all = top().filter(t => t.pr === p.id), o = all.filter(t => t.s !== 'done').sort(byOrd), d = all.filter(t => t.s === 'done').sort((a, b) => b.dn - a.dn);
  $('#pt').innerHTML = nm(p); $('#ps').textContent = all.length ? `${o.length} pendientes · ${d.length} hechas` : 'Sin tareas';
  let h = o.length ? `<div data-sort="tasks">${o.map(t => taskRow(t, { noProject: 1, grip: 1 })).join('')}</div>` : '<div class="empty small-e"><p class="mut">Sin tareas pendientes.</p></div>';
  if (d.length) h += secH(`Hechas · ${d.length}`) + d.map(t => taskRow(t, { noProject: 1 })).join('');
  return h;
}

/* Agenda: lo que viene en los próximos 7 días (tareas con fecha + eventos de Google Calendar) */
function vAgenda() { return `<div class="bar"><h1>Agenda</h1>${syncBadge()}</div><div id="body"></div>`; }
function bodyAgenda() {
  const on = GCal.enabled(), valid = GCal.valid();
  let h = '';
  if (!on) h += '<div class="card note"><b>📅 Google Calendar sin configurar</b><small>Falta el ID de cliente de Google en config.js (la guía del README lo explica). Mientras tanto, acá ves tus tareas con fecha.</small></div>';
  else if (!valid) h += `<div class="card note"><b>📅 ${GCal.linked() ? 'Volvé a conectar Google Calendar' : 'Conectá Google Calendar'}</b><small>Vas a ver tus eventos y vas a poder crear bloques de tiempo desde acá.</small><button class="btn" data-a="gconn" style="margin-top:12px" ${evBusy ? 'disabled' : ''}>${evBusy ? 'Conectando…' : GCal.linked() ? 'Reconectar' : 'Conectar con Google'}</button></div>`;
  else h += `<div class="actrow"><button class="btn" data-a="newev">+ Bloque de tiempo o evento</button><button class="btn ghost" data-a="evref" aria-label="Actualizar eventos">↻</button></div>`;
  if (evErr) h += `<p class="err">${esc(evErr)}</p>`;
  const td = today(), days = Array.from({ length: 7 }, (_, i) => addD(td, i));
  const evs = (L.events && valid ? L.events.items : []);
  let any = false;
  for (const day of days) {
    const a = pYmd(day).getTime(), b = pYmd(addD(day, 1)).getTime();
    const E = evs.filter(e => e.s < b && e.e > a).sort((x, y) => x.s - y.s);
    const T = openT().filter(t => t.d === day).sort(cmp);
    if (!E.length && !T.length && day !== td) continue;
    any = any || E.length || T.length;
    h += `<div class="dayh"><b>${dayLabel(day)}</b><small>${short(day)}</small></div>`;
    h += E.map(e => `<div class="ev"><span class="evt">${fmtEv(e)}</span><span class="nm">${esc(e.t)}</span>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener" aria-label="Abrir en Google Calendar">↗</a>` : ''}</div>`).join('');
    h += T.map(t => taskRow(t)).join('');
    if (!E.length && !T.length) h += '<p class="mut small hint">Nada agendado.</p>';
  }
  if (!any && !h.includes('Nada agendado')) h += '<div class="empty"><p class="mut">No hay nada en los próximos días.</p></div>';
  return h;
}
async function loadEvents(force) {
  if (!GCal.enabled() || !GCal.valid()) return;
  if (!force && L.events && now() - L.events.at < 120000) return;
  evErr = '';
  try {
    const items = await GCal.list(pYmd(today()).getTime(), pYmd(addD(today(), 8)).getTime());
    L.events = { at: now(), items }; saveL();
  } catch (e) { evErr = e.message; }
  if (view === 'agenda' || view === 'today') { if (!sheet) paint(); }
}

function vSet() {
  const pn = pushState();
  return `<div class="top"><button class="icon" data-a="tab" data-t="today" aria-label="Volver">‹</button><div class="ttl"><b>Ajustes</b></div>${syncBadge()}</div>
<h3>Cuenta</h3>
<div class="set-row"><span class="mut">Sesión</span><span>${esc(S.email)}</span></div>
<div class="set-row"><span class="mut">Cómo te llamamos</span><span>${esc(D().name || '—')}</span></div>
<button class="sb" data-a="editname">Cambiar mi nombre</button>
<button class="sb" data-a="syncnow">Sincronizar ahora</button>
<h3>Avisos</h3>
<p class="mut small">${esc(pn.msg)}</p>
${pn.on ? '<div class="set-row"><span class="mut">Avisos</span><span>Activados</span></div>' : ''}
${pn.canEnable ? `<button class="sb" data-a="pushon">${pn.retry ? 'Reintentar activar avisos' : 'Activar avisos de recordatorios'}</button>` : ''}
${pn.on ? '<button class="sb" data-a="pushtest">Enviar aviso de prueba</button><button class="sb" data-a="pushoff">Desactivar avisos</button>' : ''}
${GCal.enabled() ? `<h3>Google Calendar</h3><p class="mut small">${GCal.linked() ? 'Conectado.' : 'Sin conectar.'} Foco solo lee y crea eventos; nunca borra los tuyos.</p>${GCal.valid() || GCal.linked() ? '<button class="sb dng" data-a="gdisc">Desconectar Google Calendar</button>' : '<button class="sb" data-a="gconn">Conectar Google Calendar</button>'}` : ''}
<h3>Instalar</h3>
${installEvt ? '<button class="sb" data-a="install">Instalar la app</button>' : '<p class="mut small">En Android: menú del navegador → <i>Instalar app</i>. En iPhone: Safari → Compartir → <i>Agregar a inicio</i> (necesario para recibir avisos).</p>'}
<h3>Datos</h3>
<button class="sb" data-a="export">Exportar todo (JSON)</button>
<h3>Sesión</h3>
<button class="sb" data-a="logout">Cerrar sesión</button>
<button class="sb dng" data-a="delacc">Eliminar mi cuenta y mis datos</button>
<p class="mut small" style="margin-top:22px">Foco ${VERSION}. Tus datos se guardan en este dispositivo y en la nube; funciona sin conexión y se sincroniza cuando vuelve.</p>`;
}

/* ---------- Navegación ---------- */
const TABOF = { today: 'today', inbox: 'today', tasks: 'tasks', project: 'tasks', lists: 'lists', list: 'lists', agenda: 'agenda', set: '' };
function paintNav() {
  document.querySelectorAll('#nv .nb[data-t]').forEach(b => (b.dataset.t === TABOF[view] ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const n = inbox().length, bd = $('#nb-in');
  if (bd) { bd.hidden = !n; bd.textContent = n > 99 ? '99+' : n; }
}
const SHELL = { auth: vAuth, today: vToday, tasks: vTasks, inbox: vInbox, lists: vLists, list: vList, project: vProject, agenda: vAgenda, set: vSet };
const BODY = { today: bodyToday, tasks: bodyTasks, inbox: bodyInbox, lists: bodyLists, list: bodyList, project: bodyProject, agenda: bodyAgenda };
function paint() {
  const b = $('#body'); if (!b || !BODY[view]) return;
  b.innerHTML = BODY[view]() || '';
  if (view === 'today') { const h = $('#hi'); if (h) h.textContent = D().name ? `Hola ${D().name} 👋` : 'Hola 👋'; }
  paintNav();
}
function go(v) { view = v; sheet = null; render(); window.scrollTo(0, 0); if (v === 'agenda' || v === 'today') loadEvents(); }
function render() {
  $('#v').innerHTML = SHELL[view]();
  const nav = view !== 'auth';
  $('#nv').hidden = !nav; document.body.classList.toggle('nonav', !nav);
  paint(); renderSheet(); paintSync(); paintNav();
}

/* ---------- Ventanas flotantes ---------- */
const chipsDate = d => [['Hoy', 'today', today()], ['Mañana', 'tom', addD(today(), 1)], ['Fin de semana', 'we', weekend()], ['Próx. semana', 'wk', nextWeek()], ['Sin fecha', '', '']].map(([n, v, dt]) => `<button type="button" class="chip" data-a="dset" data-v="${v}" aria-pressed="${d === dt}">${n}</button>`).join('');
function taskSheet() {
  const x = sheet.draft, isNew = !x.id, opts = rkOptions(x.d, x.tm);
  if (!opts.includes(x.rk)) x.rk = '';
  const P = projects(); if (x.pr && proj(x.pr) && !P.some(p => p.id === x.pr)) P.push(proj(x.pr));
  const subs = isNew ? x.subs.map((t, i) => ({ id: String(i), t, s: 'todo' })) : subsOf(x.id);
  const g = GCal.enabled() ? (x.evl ? `<a class="rowb" href="${esc(x.evl)}" target="_blank" rel="noopener">📅 Ver el bloque en Google Calendar ↗</a>` : x.d && x.tm ? `<div class="two"><select id="tdur" class="in" aria-label="Duración del bloque">${[15, 30, 45, 60, 90, 120].map(m => `<option value="${m}"${m === (x.dur || 60) ? ' selected' : ''}>${m < 60 ? m + ' min' : m / 60 + (m === 60 ? ' hora' : ' horas')}</option>`).join('')}</select><button type="button" class="btn ghost" data-a="blk">📅 Bloquear tiempo</button></div>` : '<p class="mut small">Poné fecha y hora para bloquear tiempo en Google Calendar.</p>') : '';
  return `<form id="sf" class="sh full" role="dialog" aria-modal="true" aria-label="${isNew ? 'Nueva tarea' : 'Tarea'}"><h2>${isNew ? 'Nueva tarea' : 'Tarea'}</h2>
<input id="tt" class="in" type="text" maxlength="200" value="${esc(x.t)}" placeholder="¿Qué hay que hacer?" autocomplete="off" aria-label="Título">
<p class="lab">Proyecto</p><select id="tp" class="in" aria-label="Proyecto"><option value="">Sin proyecto</option>${P.map(p => `<option value="${esc(p.id)}"${p.id === x.pr ? ' selected' : ''}>${p.e ? esc(p.e) + ' ' : ''}${esc(p.n)}</option>`).join('')}<option value="__new">＋ Nuevo proyecto…</option></select>
<p class="lab">Cuándo</p><div class="chips wrapc" role="group">${chipsDate(x.d)}</div>
<div class="two"><label class="dt"><span>Fecha</span><input id="td" class="in${x.d ? '' : ' empty'}" type="date" value="${esc(x.d)}" data-ph="Elegir fecha" aria-label="Fecha"></label><label class="dt"><span>Hora</span><input id="tm" class="in${x.tm ? '' : ' empty'}" type="time" value="${esc(x.tm)}" data-ph="Elegir hora" aria-label="Hora"></label></div>
<p class="lab">Prioridad</p><div class="seg four" role="group">${['Ninguna', 'Baja', 'Media', 'Alta'].map((n, i) => `<button type="button" class="sp${i}" data-a="pset" data-p="${i}" aria-pressed="${x.p === i}">${i ? '<i class="pdot"></i>' : ''}${n}</button>`).join('')}</div>
<p class="lab">Aviso</p><select id="tr" class="in" aria-label="Aviso">${opts.map(k => `<option value="${k}"${k === x.rk ? ' selected' : ''}>${RK_LABEL[k]}</option>`).join('')}</select>
${x.rk === 'custom' ? `<input id="trc" class="in${x.rc ? '' : ' empty'}" data-ph="Elegir fecha y hora" type="datetime-local" value="${x.rc ? toLocalInput(x.rc) : ''}" aria-label="Fecha y hora del aviso">` : ''}
<p class="lab">Notas</p><textarea id="tn" class="in ta" maxlength="2000" rows="2" placeholder="Notas o primer paso (opcional)" aria-label="Notas">${esc(x.n)}</textarea>
<p class="lab">Subtareas</p>
${subs.map(s => `<div class="sub${s.s === 'done' ? ' done' : ''}">${isNew ? '<span class="dot" aria-hidden="true">•</span>' : `<button type="button" class="chk sm" data-a="subtg" data-id="${esc(s.id)}" aria-pressed="${s.s === 'done'}" aria-label="Marcar ${esc(s.t)}"><span class="box" aria-hidden="true"></span></button>`}<span class="nm">${esc(s.t)}</span><button type="button" class="more" data-a="subdel" data-id="${esc(s.id)}" aria-label="Quitar ${esc(s.t)}">✕</button></div>`).join('')}
<div class="qr" style="margin-top:8px"><input id="ns" class="in" type="text" maxlength="200" placeholder="Agregar un paso…" autocomplete="off" enterkeyhint="done" aria-label="Nueva subtarea"><button type="button" class="btn" data-a="subadd" style="width:auto;min-width:56px" aria-label="Agregar subtarea">+</button></div>
${g}
<button class="btn" type="submit" style="margin-top:18px">Guardar</button>
${isNew ? '' : '<button class="btn danger" type="button" data-a="tdel">Eliminar tarea</button>'}
<button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
}
function listForm(title, name, emoji, kind, btn, withKind) {
  return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2>
${withKind ? `<div class="chips wrapc" role="group" aria-label="Tipo de lista">${Object.entries(KINDS).map(([k, v]) => `<button type="button" class="chip" data-a="kset" data-k="${k}" aria-pressed="${kind === k}">${v.e} ${v.n}</button>`).join('')}</div>` : ''}
<div class="erow" style="margin-top:12px"><input id="se" class="in emo" type="text" value="${esc(emoji)}" placeholder="🙂" maxlength="16" autocomplete="off" aria-label="Emoji"><input id="sn" class="in" type="text" maxlength="80" value="${esc(name)}" placeholder="${esc(withKind ? KINDS[kind].ph : 'Nombre')}" autocomplete="off" aria-label="Nombre"></div>
<div class="egrid" role="group" aria-label="Emojis sugeridos">${EMOS.map(x => `<button type="button" data-a="pe" data-e="${x}" aria-label="Emoji ${x}" aria-pressed="${x === emoji}">${x}</button>`).join('')}<button type="button" class="noemo" data-a="pe" data-e="" aria-label="Sin emoji">✕</button></div>
<button class="btn" type="submit" style="margin-top:14px">${btn}</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
}
function sheetHtml() {
  const s = sheet; if (!s) return '';
  switch (s.t) {
    case 'ask': return `<div class="sh" role="dialog" aria-modal="true" aria-label="${esc(s.msg)}"><h2>${esc(s.msg)}</h2>${s.sub ? `<p class="mut">${esc(s.sub)}</p>` : ''}<button class="btn" data-a="yes">${esc(s.yes || 'Sí, eliminar')}</button><button class="btn ghost" data-a="close">Cancelar</button></div>`;
    case 'task': return taskSheet();
    case 'capture': return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Anotar"><h2>Anotar ahora</h2><p class="mut small">Sin pensar dónde va. Después lo ordenás.</p><input id="ci2" class="in" type="text" maxlength="500" placeholder="Idea, pendiente, deseo…" autocomplete="off" enterkeyhint="done" aria-label="Idea o pendiente"><p id="capn" class="ok" role="status">${s.n ? `Guardadas: ${s.n}` : ''}</p><button class="btn" type="submit">Guardar</button><button class="btn ghost" type="button" data-a="close">Listo</button></form>`;
    case 'snooze': { const t = D().tasks[s.id]; if (!t) return '';
      return `<div class="sh" role="dialog" aria-modal="true" aria-label="Posponer"><h2>Posponer</h2><p class="mut">${esc(t.t)}</p><button class="rowb" data-a="snz" data-k="h1" data-id="${esc(t.id)}">En 1 hora</button>${new Date().getHours() < 17 ? `<button class="rowb" data-a="snz" data-k="eve" data-id="${esc(t.id)}">Esta tarde (18:00)</button>` : ''}<button class="rowb" data-a="snz" data-k="tom" data-id="${esc(t.id)}">Mañana</button><button class="rowb" data-a="snz" data-k="we" data-id="${esc(t.id)}">Fin de semana</button><button class="rowb" data-a="snz" data-k="wk" data-id="${esc(t.id)}">Próxima semana</button><button class="rowb" data-a="topen" data-id="${esc(t.id)}">Elegir fecha y hora…</button></div>`; }
    case 'newlist': return listForm('Nueva lista', '', s.e || '', s.k || 'wish', 'Crear lista', true);
    case 'editlist': return listForm('Editar lista', curList()?.n || '', curList()?.e || '', curList()?.k || 'custom', 'Guardar', false);
    case 'newproj': return listForm('Nuevo proyecto', '', '', 'custom', 'Crear proyecto', false).replace('placeholder="Mi lista"', 'placeholder="Nombre del proyecto"');
    case 'editproj': return listForm('Editar proyecto', curProj()?.n || '', curProj()?.e || '', 'custom', 'Guardar', false);
    case 'item': { const i = curList()?.items[s.id]; if (!i) return '';
      return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Editar"><h2>Editar</h2><input id="sn" class="in" type="text" maxlength="200" value="${esc(i.n)}" autocomplete="off" aria-label="Nombre"><textarea id="snote" class="in ta" maxlength="1000" rows="2" placeholder="Nota, autor, enlace… (opcional)" aria-label="Nota">${esc(i.no)}</textarea><button class="btn" type="submit" style="margin-top:14px">Guardar</button><button class="btn ghost" type="button" data-a="i2task" data-id="${esc(i.id)}">📌 Convertir en tarea</button><button class="btn danger" type="button" data-a="itdel" data-id="${esc(i.id)}">Eliminar</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`; }
    case 'pickl': return `<div class="sh" role="dialog" aria-modal="true" aria-label="Pasar a una lista"><h2>Pasar a una lista</h2>${lists().map(l => `<button class="rowb" data-a="i2l2" data-id="${esc(s.id)}" data-l="${esc(l.id)}"><span>${nm(l)}</span></button>`).join('')}<button class="rowb" data-a="i2lnew" data-id="${esc(s.id)}" style="color:var(--acc);font-weight:700">+ Lista nueva</button></div>`;
    case 'lmenu': return `<div class="sh" role="dialog" aria-modal="true" aria-label="Opciones"><h2>${curList() ? nm(curList()) : 'Lista'}</h2><button class="rowb" data-a="ledit">Editar nombre y emoji</button><button class="rowb" data-a="lclear">Vaciar los ya hechos</button><button class="rowb dng" data-a="ldel">Eliminar lista</button></div>`;
    case 'pmenu': return `<div class="sh" role="dialog" aria-modal="true" aria-label="Opciones"><h2>${curProj() ? nm(curProj()) : 'Proyecto'}</h2><button class="rowb" data-a="pedit">Editar nombre y emoji</button><button class="rowb" data-a="parch">Archivar proyecto</button><button class="rowb dng" data-a="pdel">Eliminar proyecto</button></div>`;
    case 'name': return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Tu nombre"><h2>¿Cómo te llamamos?</h2><input id="sn" class="in" type="text" maxlength="30" value="${esc(D().name || '')}" placeholder="Tu nombre o apodo" autocomplete="off" autocapitalize="words" aria-label="Tu nombre"><button class="btn" type="submit" style="margin-top:14px">Guardar</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
    case 'event': { const x = s.draft;
      return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Bloque de tiempo"><h2>Bloque de tiempo</h2><input id="et" class="in" type="text" maxlength="200" value="${esc(x.t)}" placeholder="¿Qué vas a hacer?" autocomplete="off" aria-label="Título"><div class="two"><input id="ed" class="in" type="date" value="${esc(x.d)}" aria-label="Fecha"><input id="em" class="in" type="time" value="${esc(x.tm)}" aria-label="Hora de inicio"></div><select id="edu" class="in" aria-label="Duración">${[15, 30, 45, 60, 90, 120, 180].map(m => `<option value="${m}"${m === x.dur ? ' selected' : ''}>${m < 60 ? m + ' min' : m / 60 + (m === 60 ? ' hora' : ' horas')}</option>`).join('')}</select><p class="err" role="alert">${esc(s.err || '')}</p><button class="btn" type="submit" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Creando…' : 'Crear en Google Calendar'}</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`; }
  }
  return '';
}
function renderSheet() {
  const root = $('#ov-root'), keep = root.querySelector('.sh')?.scrollTop || 0;
  root.innerHTML = '';
  if (!sheet) return;
  const o = document.createElement('div');
  o.className = 'ov'; o.innerHTML = sheetHtml();
  const d = o.firstElementChild;
  if (!d) { sheet = null; return; }
  o.addEventListener('mousedown', e => { if (e.target === o) closeSheet(); });
  root.append(o);
  d.scrollTop = keep;
  /* El teclado solo se abre solo donde lo único que hay que hacer es escribir (anotar, listas y proyectos nuevos). */
  const f = d.querySelector('#sn, #ci2');
  if (f && ['capture', 'newlist', 'newproj'].includes(sheet.t)) f.focus();
  else { d.tabIndex = -1; d.focus({ preventScroll: true }); }
}
function openSheet(s) { sheet = s; renderSheet(); }
function closeSheet() { sheet = null; renderSheet(); }
function markEmo() { const v = ($('#se') || {}).value || ''; document.querySelectorAll('.egrid button[data-e]').forEach(b => { if (b.dataset.e) b.setAttribute('aria-pressed', String(b.dataset.e === v)); }); }
function toast(msg, label, fn) {
  const root = $('#t-root'); root.innerHTML = '';
  const d = document.createElement('div'); d.id = 't'; d.setAttribute('role', 'status'); d.append(document.createTextNode(msg));
  if (label && fn) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { root.innerHTML = ''; fn(); }; d.append(b); }
  root.append(d);
  clearTimeout(toast.t); toast.t = setTimeout(() => { root.innerHTML = ''; }, label ? 6000 : 3200);
}
function ask(msg, sub, yes, fn) { sheet = { t: 'ask', msg, sub, yes, fn }; renderSheet(); }

/* Borrador de la tarea: se lee del formulario antes de volver a dibujar la ventana */
function taskDraft(t, o = {}) {
  return t ? { id: t.id, t: t.t, n: t.n, d: t.d, tm: t.tm, rk: t.rk, rc: t.rk === 'custom' ? t.r : 0, p: t.p, pr: t.pr, ev: t.ev, evl: t.evl, subs: [], dur: 60, ...o }
    : { id: '', t: '', n: '', d: '', tm: '', rk: '', rc: 0, p: 0, pr: '', ev: '', evl: '', subs: [], dur: 60, ...o };
}
function readDraft() {
  const x = sheet && sheet.draft; if (!x || sheet.t !== 'task') return;
  const g = id => $('#' + id);
  if (g('tt')) x.t = g('tt').value; if (g('tn')) x.n = g('tn').value;
  if (g('td')) x.d = g('td').value; if (g('tm')) x.tm = g('tm').value;
  if (g('tr')) x.rk = g('tr').value;
  if (g('trc')) x.rc = g('trc').value ? new Date(g('trc').value).getTime() || 0 : 0;
  if (g('tp')) x.pr = g('tp').value === '__new' ? '' : g('tp').value; if (g('tdur')) x.dur = +g('tdur').value || 60;
}
function openTask(id, o) {
  const t = id ? D().tasks[id] : null;
  if (id && (!t || t.del)) return;
  openSheet({ t: 'task', draft: taskDraft(t, o) });
}
function saveTask(x) {
  const title = (x.t || '').trim().slice(0, 200);
  if (!title) { toast('Poné un título para la tarea'); return null; }
  let t = x.id ? D().tasks[x.id] : null;
  if (!t) t = newTask({ t: title });
  if (x.rk === 'custom' && !x.rc) x.rk = '';
  const r = calcR(x.d, x.tm, x.rk, x.rc);
  Object.assign(t, { t: title, n: (x.n || '').slice(0, 2000), d: x.d || '', tm: x.d || x.rk === 'custom' ? (x.tm || '') : '', rk: r ? x.rk : '', r, p: x.p, pr: proj(x.pr) ? x.pr : '', u: now() });
  if (!x.id) { for (const s of x.subs) if (s.trim()) newTask({ t: s.trim().slice(0, 200), par: t.id }); }
  if (x.fromInbox && D().inbox[x.fromInbox]) { D().inbox[x.fromInbox].del = true; D().inbox[x.fromInbox].u = now(); }
  x.id = t.id; touch(); return t;
}
async function blockTime(x) {
  if (!GCal.valid()) { try { await GCal.connect(); } catch (e) { toast(e.message); return; } }
  const t = saveTask(x); if (!t) return;
  const [h, m] = t.tm.split(':').map(Number), s = pYmd(t.d); s.setHours(h, m, 0, 0);
  try {
    const r = await GCal.insert({ title: t.t, notes: t.n, startMs: s.getTime(), endMs: s.getTime() + (x.dur || 60) * 60000 });
    t.ev = r.id; t.evl = /^https:\/\//.test(r.link) ? r.link : ''; t.u = now(); touch(); L.events = null;
    closeSheet(); paint(); toast('Bloque creado en Google Calendar 📅');
  } catch (e) { toast(e.message); }
}
function sheetSubmit() {
  const s = sheet; if (!s) return;
  const val = ($('#sn') || $('#ci2') || {}).value || '';
  if (s.t === 'task') { readDraft(); const t = saveTask(s.draft); if (t) { closeSheet(); paint(); paintNav(); toast(t.d ? 'Tarea guardada: ' + whenText(t) : 'Tarea guardada'); } return; }
  if (s.t === 'capture') {
    if (capture(val)) { s.n = (s.n || 0) + 1; $('#ci2').value = ''; $('#capn').textContent = `Guardadas: ${s.n}`; paintNav(); if (view === 'today') paint(); }
    $('#ci2').focus(); return;
  }
  if (s.t === 'newlist') { const id = newList(val, ($('#se') || {}).value, s.k || 'wish'); closeSheet(); cur = id; if (s.fromInbox && D().inbox[s.fromInbox]) { addItems(D().lists[id], D().inbox[s.fromInbox].t); D().inbox[s.fromInbox].del = true; D().inbox[s.fromInbox].u = now(); touch(); } go('list'); }
  else if (s.t === 'editlist') { const l = curList(); if (l) { if (val.trim()) l.n = val.trim().slice(0, 80); l.e = firstEmoji(($('#se') || {}).value); l.u = now(); touch(); } closeSheet(); paint(); }
  else if (s.t === 'newproj') { const id = newProject(val, ($('#se') || {}).value); if (s.back) { openSheet({ t: 'task', draft: { ...s.back, pr: id } }); return; } closeSheet(); tfilter = 'proj'; curP = id; go('project'); }
  else if (s.t === 'editproj') { const p = curProj(); if (p) { if (val.trim()) p.n = val.trim().slice(0, 80); p.e = firstEmoji(($('#se') || {}).value); p.u = now(); touch(); } closeSheet(); paint(); }
  else if (s.t === 'name') { D().name = val.trim().slice(0, 30); D().nameU = now(); touch(); closeSheet(); render(); }
  else if (s.t === 'item') { const i = curList()?.items[s.id]; const n = val.trim().slice(0, 200); if (i && n) { i.n = n; i.no = (($('#snote') || {}).value || '').slice(0, 1000); i.u = now(); touch(); } closeSheet(); paint(); }
  else if (s.t === 'event') createEvent();
}
async function createEvent() {
  const s = sheet, x = s.draft;
  x.t = $('#et').value.trim(); x.d = $('#ed').value; x.tm = $('#em').value; x.dur = +$('#edu').value || 60;
  if (!x.t || !x.d || !x.tm) { s.err = 'Completá el título, la fecha y la hora.'; renderSheet(); return; }
  s.busy = true; s.err = ''; renderSheet();
  try {
    if (!GCal.valid()) await GCal.connect();
    const [h, m] = x.tm.split(':').map(Number), st0 = pYmd(x.d); st0.setHours(h, m, 0, 0);
    await GCal.insert({ title: x.t, startMs: st0.getTime(), endMs: st0.getTime() + x.dur * 60000 });
    closeSheet(); L.events = null; await loadEvents(true); toast('Evento creado en Google Calendar 📅');
  } catch (e) { s.busy = false; s.err = e.message; renderSheet(); }
}

/* ---------- Avisos ---------- */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushCapable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function pushState() {
  if (!('Notification' in window)) return { msg: 'Este navegador no permite avisos.', on: false, canEnable: false };
  if (isIOS && !standalone()) return { msg: 'En iPhone los avisos solo funcionan con la app instalada: Safari → Compartir → Agregar a inicio, y abrila desde ahí.', on: false, canEnable: false };
  if (Notification.permission === 'denied') return { msg: 'Bloqueaste los avisos para este sitio. Activalos desde los permisos del navegador.', on: false, canEnable: false };
  if (Notification.permission === 'granted' && L.notif && L.pushEp) return { msg: 'Activados: te aviso aunque la app esté cerrada.', on: true, canEnable: false };
  if (Notification.permission === 'granted' && L.notif) return { msg: 'El permiso está dado, pero este dispositivo no quedó conectado al servicio de avisos' + (L.pushErr ? ' (' + L.pushErr + ')' : '') + '. Tocá reintentar. Mientras tanto, los avisos solo se ven con la app abierta.', on: false, canEnable: true, retry: true };
  return { msg: 'Activalos para que Foco te avise a la hora de tus recordatorios.', on: false, canEnable: true };
}
const b64ToU8 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
/* Conecta este dispositivo al servicio de avisos. Si algo falla, guarda el motivo en L.pushErr para mostrarlo en Ajustes. */
async function subscribePush(silent) {
  if (!S.token) return false;
  const fail = m => { L.pushErr = m; saveL(); if (!silent) toast(m); return false; };
  if (!pushCapable()) return fail('este navegador no admite avisos con la app cerrada');
  let vapid = CFG.VAPID_PUBLIC || '';
  if (!vapid) { try { vapid = (await api('/config')).vapid || ''; } catch (e) { return fail(e.net ? 'sin conexión con el servidor' : e.message); } }
  if (!vapid) return fail('el servidor no tiene las claves de avisos');
  let sub;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('la app todavía no terminó de instalarse; cerrala y abrila de nuevo')), 8000))]);
    sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(vapid) });
  } catch (e) { return fail('el navegador no pudo crear la suscripción: ' + String((e && e.message) || e).slice(0, 120)); }
  try { await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ sub: sub.toJSON() }) }); }
  catch (e) { return fail(e.net ? 'sin conexión con el servidor' : e.message); }
  L.pushEp = sub.endpoint; L.pushErr = ''; saveL();
  return true;
}
async function enablePush() {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  if (p !== 'granted') { toast('No diste permiso para los avisos'); return; }
  L.notif = true; saveL();
  const ok = await subscribePush(true);
  if (ok) toast('Avisos activados ✓');
  else toast('No se pudo conectar con el servicio de avisos: ' + (L.pushErr || 'error desconocido'));
  if (view === 'set') render();
}
async function disablePush() {
  L.notif = false; saveL();
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) { try { await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch (_) {} await sub.unsubscribe(); } } catch (_) {}
  L.pushEp = ''; saveL(); toast('Avisos desactivados'); if (view === 'set') render();
}
/* Aviso dentro de la app (si está abierta) y respaldo local cuando no hay aviso del servidor */
function ring(t) {
  if (!t || t.del || t.s === 'done') return;
  const root = $('#rm-root');
  if (root.querySelector(`[data-rid="${CSS.escape(t.id)}"]`)) return;
  const d = document.createElement('div'); d.className = 'rmc'; d.dataset.rid = t.id; d.setAttribute('role', 'alert');
  d.innerHTML = `<b>🔔 ${esc(t.t)}</b>${t.tm ? `<small>${t.d === today() ? 'Hoy' : dayLabel(t.d)} ${t.tm}</small>` : ''}<div class="acts"><button data-a="rdone" data-id="${esc(t.id)}">Hecha</button><button data-a="rsnz" data-id="${esc(t.id)}">+1 h</button><button data-a="rtom" data-id="${esc(t.id)}">Mañana</button><button data-a="ropen" data-id="${esc(t.id)}">Abrir</button><button data-a="rx" aria-label="Cerrar">✕</button></div>`;
  root.append(d);
}
function checkDue() {
  const n = now();
  for (const t of openT().concat(tasks().filter(x => x.par && x.s !== 'done'))) {
    if (!t.r || t.r > n || n - t.r > 15 * 60000) continue;
    const k = t.id + ':' + t.r;
    if (L.fired[k]) continue;
    L.fired[k] = n; ring(t);
    if (!L.pushEp && 'Notification' in window && Notification.permission === 'granted' && L.notif && navigator.serviceWorker)
      navigator.serviceWorker.ready.then(r => r.showNotification(t.t, { body: t.tm ? 'Hoy a las ' + t.tm : 'Es hora de hacerlo.', tag: 'task-' + t.id, icon: 'icons/icon-192.png', data: { url: '/?task=' + t.id } })).catch(() => {});
  }
  for (const k of Object.keys(L.fired)) if (n - L.fired[k] > 86400000) delete L.fired[k];
  saveL();
}

/* ---------- Acciones de cuenta ---------- */
function wipeLocal(keepEmail) { S = { email: keepEmail ? S.email : '', token: '', server: S.server, data: emptyState(), dirty: false }; cur = ''; curP = ''; L.events = null; L.pushEp = ''; save(); saveL(); GCal.disconnect(); }
async function doAuth() {
  if (busy) return;
  const em = authEmail.trim().toLowerCase(), pw = authPass;
  if (!CFG.API_URL) {
    const sv = $('[data-au=server]'), url = sv ? sv.value.trim() : S.server;
    if (!/^https?:\/\/\S+$/i.test(url)) { authErr = 'Pegá la URL del servidor (empieza con https://)'; render(); return; }
    S.server = url; save();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { authErr = 'Ingresá un email válido'; render(); return; }
  if (authMode === 'signup' && pw.length < 8) { authErr = 'La contraseña debe tener al menos 8 caracteres'; render(); return; }
  if (!pw) { authErr = 'Ingresá tu contraseña'; render(); return; }
  busy = true; authErr = ''; render();
  try {
    const r = await api('/' + authMode, { method: 'POST', body: JSON.stringify({ email: em, password: pw }) });
    if (S.email && S.email !== em) { S.data = emptyState(); S.dirty = false; }
    S.email = em; S.token = r.token; authPass = ''; save();
    if (authMode === 'signup') { S.dirty = true; const n = authName.trim().slice(0, 30); if (n) { D().name = n; D().nameU = now(); } save(); }
    await sync(); busy = false; go('today'); startup2();
    return;
  } catch (e) { authErr = e.message; }
  busy = false; render();
}
async function logout() {
  if (S.dirty) { toast('Sincronizando antes de salir…'); await sync(); }
  if (S.dirty) { closeSheet(); toast('Hay cambios sin subir. Conectate e intentá de nuevo.'); return; }
  try { await disablePush(); } catch (_) {}
  wipeLocal(true); authEmail = S.email; authPass = ''; authName = ''; authErr = ''; go('auth');
}
async function deleteAccount() {
  try { await api('/account', { method: 'DELETE' }); } catch (e) { closeSheet(); toast(e.net ? 'Sin conexión: no se pudo eliminar la cuenta' : e.message); return; }
  wipeLocal(false); authEmail = ''; authPass = ''; authErr = ''; authMode = 'signup'; go('auth'); toast('Cuenta eliminada');
}
function exportData() {
  const out = {
    exportado: new Date().toISOString(),
    bandeja: inbox().map(i => i.t),
    tareas: tasks().map(t => ({ titulo: t.t, notas: t.n, estado: t.s, prioridad: t.p, fecha: t.d, hora: t.tm, proyecto: proj(t.pr)?.n || '', tareaMadre: t.par ? D().tasks[t.par]?.t || '' : '', completada: t.dn ? new Date(t.dn).toISOString() : '' })),
    proyectos: projects().map(p => ({ nombre: p.n, emoji: p.e })),
    listas: lists().map(l => ({ nombre: l.n, emoji: l.e, tipo: l.k, elementos: itemsOf(l).map(i => ({ nombre: i.n, nota: i.no, hecho: i.d })) }))
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `foco-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function gconnect() {
  evBusy = true; evErr = ''; if (view === 'agenda') paint();
  try { await GCal.connect(); evBusy = false; await loadEvents(true); if (view === 'set') render(); else paint(); toast('Google Calendar conectado ✓'); }
  catch (e) { evBusy = false; evErr = e.message; if (view === 'set') toast(e.message); else paint(); }
}

/* ---------- Acciones ---------- */
const A = {
  tab(b) { if (b.dataset.t === 'tasks' && view !== 'tasks') tfilter = tfilter || 'open'; go(b.dataset.t); },
  am(b) { authMode = b.dataset.m; authErr = ''; render(); },
  capture() { openSheet({ t: 'capture', n: 0 }); },
  inbox() { go('inbox'); },
  tf(b) { tfilter = b.dataset.f; histN = 40; render(); },
  histmore() { histN += 40; paint(); },
  ptoggle(b) { const k = b.dataset.id; const g = groupsHome().find(x => (x.key || '_none') === k); const was = L.open && k in L.open ? !!L.open[k] : groupsHome().length === 1; L.open = { ...L.open, [k]: !was }; saveL(); paint(); const nb = document.querySelector(`.ph[data-id="${CSS.escape(k)}"]`); if (nb) nb.focus({ preventScroll: true }); },
  topen(b) { openTask(b.dataset.id); },
  tdone(b) {
    const id = b.dataset.id, t = D().tasks[id]; if (!t) return;
    const was = t.s === 'done'; setDone(id, !was); paint(); paintNav();
    toast(was ? 'Tarea reabierta' : '¡Hecho! ✓', 'Deshacer', () => { setDone(id, was); paint(); });
  },
  tsnz(b) { openSheet({ t: 'snooze', id: b.dataset.id }); },
  snz(b) { closeSheet(); snooze(b.dataset.id, b.dataset.k); paint(); },
  dset(b) { readDraft(); sheet.draft.d = ({ today: today(), tom: addD(today(), 1), we: weekend(), wk: nextWeek() })[b.dataset.v] || ''; if (!b.dataset.v) { sheet.draft.tm = ''; } renderSheet(); },
  pset(b) { readDraft(); sheet.draft.p = +b.dataset.p; renderSheet(); },
  subadd() {
    readDraft(); const v = ($('#ns') || {}).value?.trim(); if (!v) return;
    const x = sheet.draft;
    if (x.id) newTask({ t: v.slice(0, 200), par: x.id }), touch(); else x.subs.push(v.slice(0, 200));
    renderSheet(); const n = $('#ns'); if (n) n.focus();
  },
  subtg(b) { readDraft(); const t = D().tasks[b.dataset.id]; if (t) setDone(t.id, t.s !== 'done'); renderSheet(); },
  subdel(b) { readDraft(); const x = sheet.draft; if (x.id) { const t = D().tasks[b.dataset.id]; if (t) { t.del = true; t.u = now(); touch(); } } else x.subs.splice(+b.dataset.id, 1); renderSheet(); },
  tdel() { const id = sheet.draft.id; closeSheet(); const ids = delTask(id); paint(); paintNav(); toast('Tarea eliminada', 'Deshacer', () => { undel(ids); paint(); }); },
  blk() { readDraft(); blockTime(sheet.draft); },
  i2t(b) { const i = D().inbox[b.dataset.id]; if (i) { const w = parseWhen(i.t); openTask('', { t: w.t, d: w.d, tm: w.tm, rk: w.tm ? 'at' : '', fromInbox: i.id }); } },
  i2l(b) { if (!lists().length) { openSheet({ t: 'newlist', k: 'wish', fromInbox: b.dataset.id }); return; } openSheet({ t: 'pickl', id: b.dataset.id }); },
  i2l2(b) { const i = D().inbox[b.dataset.id], l = D().lists[b.dataset.l]; if (!i || !l) return; addItems(l, i.t); i.del = true; i.u = now(); touch(); closeSheet(); paint(); paintNav(); toast('Pasado a ' + l.n); },
  i2lnew(b) { openSheet({ t: 'newlist', k: 'wish', fromInbox: b.dataset.id }); },
  idel(b) { const id = b.dataset.id, i = D().inbox[id]; if (!i) return; i.del = true; i.u = now(); touch(); paint(); paintNav(); toast('Idea eliminada', 'Deshacer', () => { i.del = false; i.u = now(); touch(); paint(); paintNav(); }); },
  newlist() { openSheet({ t: 'newlist', k: 'wish' }); },
  kset(b) { const s = sheet, nameV = ($('#sn') || {}).value || '', e = ($('#se') || {}).value || ''; s.k = b.dataset.k; s.e = e || KINDS[s.k].e; renderSheet(); $('#sn').value = nameV; },
  pe(b) { const i = $('#se'); if (i) { i.value = b.dataset.e; markEmo(); } },
  olist(b) { cur = b.dataset.id; go('list'); },
  lmenu() { openSheet({ t: 'lmenu' }); },
  ledit() { openSheet({ t: 'editlist' }); },
  lclear() {
    const l = curList(); if (!l) return; closeSheet();
    const ids = itemsOf(l).filter(i => i.d).map(i => i.id), u = now(); if (!ids.length) { toast('No hay nada hecho para vaciar'); return; }
    ids.forEach(i => { l.items[i].del = true; l.items[i].u = u; }); touch(); paint();
    toast(`${ids.length} quitados`, 'Deshacer', () => { ids.forEach(i => { l.items[i].del = false; l.items[i].u = now(); }); touch(); paint(); });
  },
  ldel() { const l = curList(); if (l) ask(`¿Eliminar “${l.n}”?`, 'Se borra la lista con todo lo que tiene.', 'Sí, eliminar', () => { l.del = true; l.u = now(); l.items = {}; touch(); go('lists'); }); },
  itg(b) {
    const l = curList(), i = l?.items[b.dataset.id]; if (!i) return;
    i.d = !i.d; i.dn = i.d ? now() : 0; i.u = now(); touch(); paint();
    if (i.d) toast(`${KINDS[l.k].done} ✓`, 'Deshacer', () => { i.d = false; i.dn = 0; i.u = now(); touch(); paint(); });
  },
  ihist(b) { const i = D().lists[b.dataset.l]?.items[b.dataset.id]; if (i) { i.d = false; i.dn = 0; i.u = now(); touch(); paint(); } },
  ied(b) { openSheet({ t: 'item', id: b.dataset.id }); },
  itdel(b) { const l = curList(), i = l?.items[b.dataset.id]; if (!i) return; i.del = true; i.u = now(); touch(); closeSheet(); paint(); toast('Eliminado', 'Deshacer', () => { i.del = false; i.u = now(); touch(); paint(); }); },
  i2task(b) { const i = curList()?.items[b.dataset.id]; if (!i) return; openTask('', { t: i.n, n: i.no }); },
  newproj() { openSheet({ t: 'newproj' }); },
  oproj(b) { curP = b.dataset.id; go('project'); },
  'back-proj'() { tfilter = 'proj'; go('tasks'); },
  pmenu() { openSheet({ t: 'pmenu' }); },
  pedit() { openSheet({ t: 'editproj' }); },
  parch() { const p = curProj(); if (p) { p.ar = true; p.u = now(); touch(); closeSheet(); tfilter = 'proj'; go('tasks'); toast('Proyecto archivado'); } },
  pdel() { const p = curProj(); if (p) ask(`¿Eliminar “${p.n}”?`, 'Sus tareas no se borran: quedan sin proyecto.', 'Sí, eliminar', () => { p.del = true; p.u = now(); top().filter(t => t.pr === p.id).forEach(t => { t.pr = ''; t.u = now(); }); touch(); tfilter = 'proj'; go('tasks'); }); },
  editname() { openSheet({ t: 'name' }); },
  newev() { openSheet({ t: 'event', draft: { t: '', d: today(), tm: '', dur: 60 } }); },
  evref() { loadEvents(true).then(() => toast('Agenda actualizada')); },
  gconn() { gconnect(); },
  gdisc() { ask('¿Desconectar Google Calendar?', 'Tus eventos no se borran; solo dejás de verlos en Foco.', 'Desconectar', () => { GCal.disconnect(); L.events = null; saveL(); render(); toast('Desconectado'); }); },
  pushon() { enablePush(); },
  pushoff() { disablePush(); },
  async pushtest() {
    try {
      const r = await api('/push/test', { method: 'POST', body: '{}' });
      if (r.sent) { toast('Aviso enviado: debería llegar en unos segundos'); return; }
      const x = (r.results || [])[0] || {};
      toast(`El servicio de avisos${x.host ? ' (' + x.host + ')' : ''} respondió ${x.status || 'con un error'}${x.detail ? ': ' + x.detail : ''}`);
    } catch (e) { toast(e.message); }
  },
  rx(b) { b.closest('.rmc').remove(); },
  rdone(b) { const id = b.dataset.id; b.closest('.rmc').remove(); setDone(id, true); paint(); paintNav(); toast('¡Hecho! ✓', 'Deshacer', () => { setDone(id, false); paint(); }); },
  rsnz(b) { b.closest('.rmc').remove(); snooze(b.dataset.id, 'h1'); paint(); },
  rtom(b) { b.closest('.rmc').remove(); snooze(b.dataset.id, 'tom'); paint(); },
  ropen(b) { b.closest('.rmc').remove(); openTask(b.dataset.id); },
  close() { if (sheet && sheet.back) { openSheet({ t: 'task', draft: sheet.back }); return; } closeSheet(); },
  yes() { const f = sheet && sheet.fn; closeSheet(); if (f) f(); },
  syncnow() { toast('Sincronizando…'); sync().then(ok => { if (ok) toast('Todo sincronizado'); else if (S.token) toast(st === 'off' ? 'Sin conexión' : 'No se pudo sincronizar'); }); },
  export() { exportData(); },
  logout() { ask('¿Cerrar sesión?', 'Tus datos quedan guardados en la nube. Se borran de este dispositivo.', 'Cerrar sesión', logout); },
  delacc() { ask('¿Eliminar tu cuenta?', 'Se borra todo para siempre. No se puede deshacer.', 'Sí, eliminar todo', deleteAccount); },
  install() { if (!installEvt) return; installEvt.prompt(); installEvt = null; render(); }
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (b && A[b.dataset.a]) A[b.dataset.a](b);
});
document.addEventListener('mousedown', e => { if (e.target.closest('.egrid button, .chip, .seg button')) e.preventDefault(); });
document.addEventListener('submit', e => {
  e.preventDefault();
  const id = e.target.id;
  if (id === 'af') return doAuth();
  if (id === 'sf') return sheetSubmit();
  const qi = e.target.querySelector && e.target.querySelector('input.in'); if (!qi) return;
  const v = qi.value; if (!v.trim()) return;
  if (id === 'cf' || id === 'tf-form' || id === 'pf') {
    const w = parseWhen(v); qi.value = '';
    openTask('', { t: w.t[0].toUpperCase() + w.t.slice(1), d: w.d, tm: w.tm, rk: w.tm ? 'at' : '', pr: id === 'pf' ? curP : '' });
    return;
  } else if (id === 'lf') { const l = curList(); if (l && addItems(l, v)) { qi.value = ''; paint(); } }
  qi.focus();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'se') { t.value = lastEmoji(t.value); markEmo(); }
  const au = t.dataset && t.dataset.au;
  if (au === 'name') authName = t.value; else if (au === 'email') authEmail = t.value; else if (au === 'pass') authPass = t.value;
});
document.addEventListener('change', e => {
  const id = e.target.id;
  if (sheet && sheet.t === 'task' && id === 'tp' && e.target.value === '__new') { readDraft(); openSheet({ t: 'newproj', back: sheet.draft }); return; }
  if (sheet && sheet.t === 'task' && ['td', 'tm', 'tr', 'trc', 'tp', 'tdur'].includes(id)) { readDraft(); if (id === 'td' && !sheet.draft.d) sheet.draft.tm = ''; renderSheet(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheet) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'ns') { e.preventDefault(); A.subadd(); }
});

/* ---------- Reordenar (arrastrar con el agarre ⋮⋮, o con las flechas ↑ ↓ del teclado) ---------- */
function reorder(kind, ids) {
  const map = kind === 'projects' ? D().projects : D().tasks, t = now();
  let ch = false;
  ids.forEach((id, i) => { const e = map[id]; if (e && e.o !== i + 1) { e.o = i + 1; e.u = t; ch = true; } });
  if (ch) touch();
  paint();
}
const itemsIn = c => [...c.children].filter(x => x.dataset.id);
document.addEventListener('pointerdown', e => {
  const h = e.target.closest('.grip'); if (!h || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = h.parentElement.closest('[data-id]'), cont = el && el.parentElement;
  if (!cont || !cont.dataset.sort) return;
  e.preventDefault();
  dragging = true; h.setPointerCapture(e.pointerId); el.classList.add('drag'); document.body.classList.add('dragging');
  let startY = e.clientY;
  const move = ev => {
    let dy = ev.clientY - startY; el.style.transform = `translateY(${dy}px)`;
    const mid = el.getBoundingClientRect().top + el.offsetHeight / 2;
    for (const s of itemsIn(cont)) {
      if (s === el) continue;
      const r = s.getBoundingClientRect(), sm = r.top + r.height / 2, after = !!(el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
      if ((after && mid > sm) || (!after && mid < sm)) {
        const before = el.getBoundingClientRect().top;
        if (after) el.before(s); else el.after(s);   // se mueve el vecino (no el agarre) para no perder la captura del puntero
        const layoutTop = el.getBoundingClientRect().top - dy;
        dy = before - layoutTop; startY = ev.clientY - dy; el.style.transform = `translateY(${dy}px)`;
        break;
      }
    }
    if (ev.clientY < 90) window.scrollBy(0, -12); else if (ev.clientY > innerHeight - 110) window.scrollBy(0, 12);
  };
  const end = ev => {
    h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', end); h.removeEventListener('pointercancel', end);
    el.style.transform = ''; el.classList.remove('drag'); document.body.classList.remove('dragging'); dragging = false;
    reorder(cont.dataset.sort, itemsIn(cont).map(x => x.dataset.id));
  };
  h.addEventListener('pointermove', move); h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
});
document.addEventListener('keydown', e => {
  const h = e.target.closest && e.target.closest('.grip'); if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const el = h.parentElement.closest('[data-id]'), cont = el && el.parentElement; if (!cont || !cont.dataset.sort) return;
  e.preventDefault();
  const ids = itemsIn(cont).map(x => x.dataset.id), i = ids.indexOf(el.dataset.id), j = e.key === 'ArrowUp' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const id = el.dataset.id; reorder(cont.dataset.sort, ids);
  const nb = document.querySelector(`[data-id="${CSS.escape(id)}"] .grip`); if (nb) nb.focus();
});

/* ---------- Ciclo de vida ---------- */
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token) { sync(); checkDue(); } });
window.addEventListener('online', () => { if (S.token) sync(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (view === 'set') render(); });
setInterval(() => { if (document.visibilityState === 'visible' && S.token && !sheet) sync(); }, 60000);
setInterval(() => { if (S.token) checkDue(); }, 15000);

function handleUrl() {
  const p = new URLSearchParams(location.search), tid = p.get('task');
  if (p.get('capture')) openSheet({ t: 'capture', n: 0 });
  else if (tid && D().tasks[tid] && !D().tasks[tid].del) openTask(tid);
  if (p.get('capture') || tid) history.replaceState(null, '', location.pathname);
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  navigator.serviceWorker.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'reminder' && D().tasks[m.id]) { L.fired[m.id + ':' + m.r] = now(); saveL(); ring(D().tasks[m.id]); }
    else if (m.type === 'open' && m.url) { const id = new URL(m.url, location.href).searchParams.get('task'); if (id && D().tasks[id]) openTask(id); }
  });
}
function startup2() {
  checkDue(); loadEvents();
  if (L.notif && 'Notification' in window && Notification.permission === 'granted') subscribePush(true).then(() => { if (view === 'set') render(); }).catch(() => {});
}
if (S.token) {
  view = 'today';
  if (!navigator.onLine) st = 'off';
  render(); handleUrl(); startup2();
  sync().then(handleUrl);
} else render();
})();
