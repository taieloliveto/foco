'use strict';
/* Google Calendar para Foco. Todo ocurre en el navegador: Google te pide permiso y entrega una llave temporal (≈1 hora).
   No hay servidor de por medio ni se guarda ninguna contraseña. Se carga el script de Google solo cuando hace falta. */
(() => {
const LK = 'foco.g';
const cfg = () => (window.FOCO_CONFIG || {}).GOOGLE_CLIENT_ID || '';
let loading = null;

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

async function call(path, opts = {}) {
  const g = get();
  if (!g.tok || g.exp < Date.now() + 15000) throw new GErr('Hay que volver a conectar Google Calendar', true);
  let r;
  try { r = await fetch('https://www.googleapis.com/calendar/v3' + path, { ...opts, headers: { Authorization: 'Bearer ' + g.tok, 'Content-Type': 'application/json' } }); }
  catch (_) { throw new GErr('Sin conexión con Google'); }
  if (r.status === 401) { put({ ...g, tok: '', exp: 0 }); throw new GErr('Hay que volver a conectar Google Calendar', true); }
  let b = null; try { b = await r.json(); } catch (_) {}
  if (!r.ok) throw new GErr((b && b.error && b.error.message) || 'Google Calendar devolvió un error');
  return b;
}

const GCal = {
  enabled: () => !!cfg(),
  linked: () => !!get().on,                                                // ya dio permiso alguna vez
  valid: () => { const g = get(); return !!g.tok && g.exp > Date.now() + 60000; },
  /* Debe llamarse desde un toque del usuario (el navegador bloquea ventanas emergentes si no). */
  async connect() {
    await load();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: cfg(),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          put({ on: 1, tok: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000 });
          res();
        },
        error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Cerraste la ventana de Google antes de terminar' : 'No se pudo abrir la ventana de Google'))
      });
      tc.requestAccessToken({ prompt: get().on ? '' : 'consent' });
    });
  },
  disconnect() {
    const g = get();
    try { if (g.tok && window.google && google.accounts) google.accounts.oauth2.revoke(g.tok, () => {}); } catch (_) {}
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
