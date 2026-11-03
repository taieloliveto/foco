'use strict';
/* Google Calendar para Foco. Google entrega llaves que duran ≈1 hora.
   Si el servidor de Foco tiene Google configurado (GOOGLE_CLIENT_SECRET), se conecta una sola vez: el servidor guarda
   el permiso y la app le pide una llave nueva sola cada vez que se vence, así Calendar queda conectado siempre.
   Si no, se usa el modo viejo (solo navegador): la llave dura 1 hora y después hay que reconectar.
   Se carga el script de Google solo cuando hace falta. */
(() => {
const LK = 'foco.g';
const cfg = () => (window.FOCO_CONFIG || {}).GOOGLE_CLIENT_ID || '';
let loading = null, srvApi = null, renewing = null, probed = false;

function load() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res();
    s.onerror = () => { loading = null; rej(new Error('No se pudo cargar Google. Revisá tu conexión.')); };
    document.head.append(s);
  });
  return loading;
}
const get = () => { try { return JSON.parse(localStorage.getItem(LK) || '{}') || {}; } catch (_) { return {}; } };
const put = o => { try { localStorage.setItem(LK, JSON.stringify(o)); } catch (_) {} };

class GErr extends Error { constructor(m, auth) { super(m); this.auth = !!auth; } }

const saveTok = (b, srv) => put({ on: 1, srv: srv ? 1 : 0, tok: b.access_token, exp: Date.now() + (+b.expires_in || 3600) * 1000 });

/* Pide al servidor una llave nueva. Si el permiso ya no sirve, se olvida la conexión. Varias llamadas a la vez comparten un pedido. */
function renew() {
  if (renewing) return renewing;
  renewing = (async () => {
    let b;
    try { b = await srvApi('/gcal/token', { method: 'POST', body: '{}' }); }
    catch (e) {
      if (e.status === 401) { put({}); throw new GErr('Hay que volver a conectar Google Calendar', true); }
      throw new GErr(e.net ? 'Sin conexión con el servidor' : 'No se pudo renovar el acceso a Google Calendar');
    }
    if (!b || !b.access_token) { put({}); throw new GErr('Hay que volver a conectar Google Calendar', true); }
    saveTok(b, 1);
  })().finally(() => { renewing = null; });
  return renewing;
}
async function token() {
  const g = get();
  if (g.tok && g.exp > Date.now() + 60000) return g.tok;
  if (g.srv && g.on && srvApi) { await renew(); return get().tok; }
  throw new GErr('Hay que volver a conectar Google Calendar', true);
}

async function call(path, opts = {}, retry = true) {
  const tok = await token();
  let r;
  try { r = await fetch('https://www.googleapis.com/calendar/v3' + path, { ...opts, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } }); }
  catch (_) { throw new GErr('Sin conexión con Google'); }
  if (r.status === 401) {
    const g = get(); put({ ...g, tok: '', exp: 0 });
    if (g.srv && retry) return call(path, opts, false);     // la llave se cayó antes de tiempo: se pide otra una vez
    throw new GErr('Hay que volver a conectar Google Calendar', true);
  }
  let b = null; try { b = await r.json(); } catch (_) {}
  if (!r.ok) throw new GErr((b && b.error && b.error.message) || 'Google Calendar devolvió un error');
  return b;
}

const GCal = {
  enabled: () => !!cfg(),
  linked: () => !!get().on,                                                // ya dio permiso alguna vez
  /* Se puede usar ahora: llave vigente, o conexión guardada en el servidor (la llave se renueva sola). */
  valid: () => { const g = get(); return (!!g.tok && g.exp > Date.now() + 60000) || !!(g.srv && g.on && srvApi); },
  /* La app le pasa su función para hablar con el servidor de Foco (con la sesión). */
  useServer(fn) { srvApi = fn; },
  /* Debe llamarse desde un toque del usuario (el navegador bloquea ventanas emergentes si no). */
  async connect() {
    let srv = false;
    if (srvApi) { try { srv = !!(await srvApi('/config')).gcal; } catch (_) {} }
    await load();
    if (srv) return new Promise((res, rej) => {
      const cc = google.accounts.oauth2.initCodeClient({
        client_id: cfg(), ux_mode: 'popup',
        scope: 'https://www.googleapis.com/auth/calendar.events',
        callback: async r => {
          if (r.error || !r.code) return rej(new Error(r.error_description || r.error || 'Google no devolvió el permiso'));
          try { saveTok(await srvApi('/gcal/connect', { method: 'POST', body: JSON.stringify({ code: r.code, cid: cfg() }) }), 1); res(); }
          catch (e) { rej(new Error(e.message || 'No se pudo conectar Google Calendar')); }
        },
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Cerraste la ventana de Google antes de terminar' : 'No se pudo abrir la ventana de Google'))
      });
      cc.requestCode();
    });
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: cfg(),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          saveTok(r, 0);
          res();
        },
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Cerraste la ventana de Google antes de terminar' : 'No se pudo abrir la ventana de Google'))
      });
      tc.requestAccessToken({ prompt: get().on ? '' : 'consent' });
    });
  },
  /* Si este dispositivo no está conectado pero la cuenta sí (se conectó en otro), toma la conexión sin pedir nada. Una vez por apertura. */
  async probe() {
    if (probed || !srvApi || get().on || !cfg()) return false;
    probed = true;
    try { const b = await srvApi('/gcal/token', { method: 'POST', body: '{}' }); if (!b || !b.access_token) return false; saveTok(b, 1); return true; } catch (_) { return false; }
  },
  /* local=true: solo se olvida en este dispositivo (al cerrar sesión). Si no, también se revoca el permiso guardado en el servidor. */
  disconnect(local) {
    const g = get();
    if (g.srv && !local && srvApi) srvApi('/gcal/disconnect', { method: 'POST', body: '{}' }).catch(() => {});
    else { try { if (g.tok && window.google && google.accounts) google.accounts.oauth2.revoke(g.tok, () => {}); } catch (_) {} }
    put({});
  },
  /* Eventos entre dos instantes (ms). */
  async list(fromMs, toMs) {
    const q = new URLSearchParams({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
    const b = await call('/calendars/primary/events?' + q);
    return (b.items || []).filter(e => e.status !== 'cancelled' && e.start).map(e => {
      const allDay = !e.start.dateTime;
      return {
        id: e.id, t: e.summary || '(sin título)', allDay, link: e.htmlLink || '',
        s: allDay ? new Date(e.start.date + 'T00:00:00').getTime() : Date.parse(e.start.dateTime),
        e: allDay ? new Date(e.end.date + 'T00:00:00').getTime() : Date.parse(e.end.dateTime)
      };
    });
  },
  /* Crea un bloque de tiempo. Devuelve {id, link}. */
  async insert({ title, notes, startMs, endMs }) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const b = await call('/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({
        summary: title, description: notes || undefined,
        start: { dateTime: new Date(startMs).toISOString(), timeZone: tz },
        end: { dateTime: new Date(endMs).toISOString(), timeZone: tz },
        source: { title: 'Foco', url: location.origin + '/' }
      })
    });
    return { id: b.id, link: b.htmlLink || '' };
  }
};
window.GCal = GCal;
})();
