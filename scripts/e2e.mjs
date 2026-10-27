// Prueba de punta a punta con un navegador real (Playwright): app + servidor con KV simulado.
// Uso: node scripts/e2e.mjs   (requiere `playwright` con Chromium instalado)
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
process.env.TZ = 'America/Buenos_Aires';
import worker from '../server/src/index.js';
import { b64u } from '../server/src/push.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', 'web');
const SHOTS = process.env.SHOTS_DIR || join(here, '..', '.shots');
mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [here, '/opt/npm-tools/node_modules'] }));

// ---- servidor de la API (Worker + KV en memoria) ----
const store = new Map();
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vpub = b64u(await crypto.subtle.exportKey('raw', vk.publicKey)), vpriv = (await crypto.subtle.exportKey('jwk', vk.privateKey)).d;
const pushed = [];
const env = { SERVER_SECRET: 'e2e-secret-largo-largo', VAPID_PUBLIC: vpub, VAPID_PRIVATE: vpriv, __fetch: async (u, i) => { pushed.push(u); return { status: 201 }; },
  KV: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); }, list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) } };
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://api.local' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
// ---- servidor estático de la app ----
// config.js: por defecto trae el servidor "de fábrica" (como en producción). Con la cookie noserver=1 queda vacío.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let API = '';
const web = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = join(WEB, p);
  if (!f.startsWith(WEB) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  const headers = { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' };
  if (process.env.E2E_CSP) {   // mismos encabezados de seguridad que web/vercel.json (localhost → 127.0.0.1)
    const rule = JSON.parse(readFileSync(join(WEB, 'vercel.json'), 'utf8')).headers.find(h => h.source === '/(.*)');
    for (const { key, value } of rule.headers) headers[key] = value.replace('http://localhost:*', 'http://127.0.0.1:*');
  }
  if (p === '/config.js') {   // el config.js real apunta a producción: en la prueba se reemplaza
    const none = /noserver=1/.test(req.headers.cookie || '');
    res.writeHead(200, headers); return res.end(`window.FOCO_CONFIG={API_URL:${JSON.stringify(none ? '' : API)},GOOGLE_CLIENT_ID:'test-client'};`);
  }
  res.writeHead(200, headers); res.end(readFileSync(f));
});
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const [apiPort, webPort] = [await listen(api), await listen(web)];
const APP = `http://127.0.0.1:${webPort}/`;
API = `http://127.0.0.1:${apiPort}`;

const browser = await chromium.launch();
const errors = [];
let n = 0;
const step = async (name, fn) => { try { await fn(); n++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name); throw e; } };

// Google falso: script de identidad + API de Calendar
const gcalPosts = [];
const soon = new Date(Date.now() + 60000);
const GEVENTS = [{ id: 'g1', summary: 'Reunión con Pedro', status: 'confirmed', htmlLink: 'https://calendar.google.com/e/g1', start: { dateTime: soon.toISOString() }, end: { dateTime: new Date(soon.getTime() + 3600000).toISOString() } }];
const FAKE_GSI = `window.google={accounts:{oauth2:{initTokenClient:c=>({requestAccessToken:()=>setTimeout(()=>c.callback({access_token:'tok-test',expires_in:3600}),30)}),revoke:(t,cb)=>cb&&cb()}}};`;
// Push falso: Chromium sin conexión a FCM no puede suscribirse
const FAKE_PUSH = `(()=>{const sub={endpoint:'https://push.example.com/send/e2e',toJSON(){return{endpoint:this.endpoint,keys:{p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'}}},unsubscribe:async()=>{window.__subbed=false;return true}};
const pm={getSubscription:async()=>window.__subbed?sub:null,subscribe:async()=>{window.__subbed=true;return sub}};
Object.defineProperty(ServiceWorkerRegistration.prototype,'pushManager',{get(){return pm}});
let perm='default';Object.defineProperty(Notification,'permission',{get:()=>perm});Notification.requestPermission=async()=>{perm='granted';return perm};})();`;
const newDevice = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'America/Buenos_Aires', locale: 'es-AR', permissions: ['notifications'], ...opts });
  await ctx.addInitScript(FAKE_PUSH);
  await ctx.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_GSI }));
  await ctx.route('https://www.googleapis.com/calendar/v3/**', async r => {
    if (r.request().method() === 'POST') { gcalPosts.push(JSON.parse(r.request().postData())); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'new1', htmlLink: 'https://calendar.google.com/e/new1' }) }); }
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: GEVENTS }) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push('console: ' + m.text()); });
  return { ctx, page };
};
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name + '.png') });
const toast = async (page, re) => page.locator('#t').filter({ hasText: re }).waitFor({ timeout: 4000 });
const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymdL(d); };
const pw = 'clave-segura-1';

console.log('Teléfono A');
const A = await newDevice();
const p = A.page;
await p.goto(APP);

await step('registro con nombre y entra a Hoy', async () => {
  await p.getByRole('button', { name: 'Crear cuenta' }).first().click();
  await p.fill('[data-au=name]', 'Ana');
  await p.fill('[data-au=email]', 'ana@mail.com');
  await p.fill('[data-au=pass]', pw);
  await p.locator('form#af button[type=submit]').click();
  await p.locator('#hi').filter({ hasText: 'Hola Ana' }).waitFor();
  assert.equal(await p.locator('[data-au=server]').count(), 0);
  await shot(p, '01-hoy-vacio');
});
await step('captura rápida inline: dos ideas sin clasificar', async () => {
  await p.fill('#ci', 'Comprar regalo para mamá');
  await p.keyboard.press('Enter');
  await toast(p, /bandeja/i);
  await p.fill('#ci', 'Aprender a hacer pan');
  await p.keyboard.press('Enter');
  await p.locator('#nb-in').filter({ hasText: '2' }).waitFor();
  await p.locator('.card.inb').filter({ hasText: '2 ideas' }).waitFor();
  assert.equal(await p.evaluate(() => document.activeElement.id), 'ci');
});
await step('captura con el botón +: varias seguidas sin cerrar', async () => {
  await p.locator('.fab').click();
  await p.fill('#ci2', 'Revisar el seguro del auto');
  await p.keyboard.press('Enter');
  await p.locator('.ok').filter({ hasText: 'Guardadas: 1' }).waitFor();
  await p.fill('#ci2', 'Ver turno del médico');
  await p.keyboard.press('Enter');
  await p.locator('.ok').filter({ hasText: 'Guardadas: 2' }).waitFor();
  await p.getByRole('button', { name: 'Listo' }).click();
  await p.locator('#nb-in').filter({ hasText: '4' }).waitFor();
});
await step('Bandeja: convertir una idea en tarea concreta con subtareas, fecha, aviso y prioridad', async () => {
  await p.locator('.card.inb').click();
  await p.locator('.ib').filter({ hasText: 'Revisar el seguro' }).waitFor();
  await shot(p, '02-bandeja');
  await p.locator('.ib').filter({ hasText: 'Revisar el seguro' }).getByRole('button', { name: /Tarea/ }).click();
  assert.equal(await p.inputValue('#tt'), 'Revisar el seguro del auto');
  assert.equal(await p.evaluate(() => document.activeElement.id === 'tt'), false, 'no abre el teclado solo');
  await p.fill('#tn', 'Primero: buscar la póliza en el mail');
  await p.getByRole('button', { name: 'Mañana', exact: true }).click();
  await p.fill('#tm', '10:30');
  await p.locator('#tm').dispatchEvent('change');
  await p.selectOption('#tr', '1h');
  await p.getByRole('button', { name: 'Alta' }).click();
  await p.fill('#ns', 'Buscar la póliza');
  await p.keyboard.press('Enter');
  await p.fill('#ns', 'Llamar a la aseguradora');
  await p.getByRole('button', { name: 'Agregar subtarea' }).click();
  await p.locator('.sub').nth(1).waitFor();
  await p.waitForTimeout(400);
  await shot(p, '03-tarea-sheet');
  await p.locator('#sf button[type=submit]').click();
  await toast(p, /guardada/i);
  // la idea salió de la bandeja
  await p.locator('.ib').filter({ hasText: 'Revisar el seguro' }).waitFor({ state: 'detached' });
});
await step('la tarea quedó guardada con todo (y el aviso a 1 h antes)', async () => {
  const t = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('foco.v1')).data.tasks).filter(x => !x.par && !x.del));
  assert.equal(t.length, 1);
  const x = t[0];
  assert.equal(x.d, addDays(1)); assert.equal(x.tm, '10:30'); assert.equal(x.p, 3); assert.equal(x.rk, '1h');
  const want = new Date(`${addDays(1)}T09:30:00-03:00`).getTime();
  assert.equal(x.r, want);
  const subs = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('foco.v1')).data.tasks).filter(x => x.par));
  assert.equal(subs.length, 2);
});
await step('Bandeja: pasar una idea a una lista nueva', async () => {
  await p.locator('.ib').filter({ hasText: 'Aprender a hacer pan' }).getByRole('button', { name: /Lista/ }).click();
  await p.getByRole('button', { name: /Cursos/ }).click();
  assert.equal(await p.inputValue('#se'), '🎓');
  await p.fill('#sn', 'Para aprender');
  await p.getByRole('button', { name: 'Crear lista' }).click();
  await p.locator('#lt').filter({ hasText: 'Para aprender' }).waitFor();
  await p.locator('.it').filter({ hasText: 'Aprender a hacer pan' }).waitFor();
});
await step('Listas: agregar ítems, marcar como hecho, nota y convertir a tarea', async () => {
  await p.fill('#li', 'Curso de fotografía; Curso de Excel');
  await p.keyboard.press('Enter');
  await p.locator('.it').filter({ hasText: 'Curso de Excel' }).waitFor();
  await p.locator('.it').filter({ hasText: 'Curso de Excel' }).locator('.chk').click();
  await toast(p, /Terminado/);
  await p.locator('.it').filter({ hasText: 'Curso de fotografía' }).locator('.main').click();
  await p.fill('#snote', 'en Domestika');
  await p.locator('#sf button[type=submit]').click();
  await p.locator('.mt').filter({ hasText: 'en Domestika' }).waitFor();
  await p.locator('.it').filter({ hasText: 'Curso de fotografía' }).locator('.main').click();
  await p.getByRole('button', { name: /Convertir en tarea/ }).click();
  assert.equal(await p.inputValue('#tt'), 'Curso de fotografía');
  assert.equal(await p.inputValue('#tn'), 'en Domestika');
  await p.locator('.chip[data-v=today]').click();
  await p.locator('#sf button[type=submit]').click();
  await shot(p, '04-lista');
});
await step('Tareas: alta rápida entiende "mañana a las 18" y crea aviso', async () => {
  await p.getByRole('button', { name: 'Tareas' }).click();
  await p.fill('#ti', 'Llamar al dentista mañana a las 18');
  await p.keyboard.press('Enter');
  const row = p.locator('.it').filter({ hasText: 'Llamar al dentista' });
  await row.waitFor();
  await row.locator('.mt').filter({ hasText: 'Mañana 18:00' }).waitFor();
  await row.locator('.mt').filter({ hasText: '🔔' }).waitFor();
  await p.fill('#ti', 'Comprar 2 manzanas');
  await p.keyboard.press('Enter');
  const apples = p.locator('.it').filter({ hasText: 'Comprar 2 manzanas' });
  await apples.waitFor();
  assert.equal(await apples.locator('.mt').filter({ hasText: /\d{2}:\d{2}/ }).count(), 0, 'no confunde cantidades con horas');
  await p.locator('.sec h3').filter({ hasText: 'Sin fecha' }).waitFor();
  await shot(p, '05-tareas');
});
await step('Proyectos: crear, agregar tareas y ver avance', async () => {
  await p.getByRole('button', { name: 'Proyectos' }).click();
  await p.getByRole('button', { name: '+ Nuevo proyecto' }).click();
  await p.fill('#se', '✈️');
  await p.fill('#sn', 'Viaje a Mendoza');
  await p.getByRole('button', { name: 'Crear proyecto' }).click();
  await p.locator('#pt').filter({ hasText: 'Viaje a Mendoza' }).waitFor();
  await p.fill('#pi', 'Reservar alojamiento');
  await p.keyboard.press('Enter');
  await p.fill('#pi', 'Sacar pasajes');
  await p.keyboard.press('Enter');
  await p.locator('.it').filter({ hasText: 'Sacar pasajes' }).locator('.chk').click();
  await p.locator('.sec h3').filter({ hasText: 'Hechas · 1' }).waitFor();
  await p.getByRole('button', { name: 'Volver a proyectos' }).click();
  await p.locator('.card').filter({ hasText: 'Viaje a Mendoza' }).filter({ hasText: '1 pendientes · 2 en total' }).waitFor();
});
await step('Hoy: tarea de hoy, atrasada con posponer, y "cuando tengas energía"', async () => {
  // una tarea atrasada y una importante sin fecha, vía el formulario
  await p.getByRole('button', { name: 'Hoy', exact: true }).first().click();
  await p.locator('[data-a=newtask]').click();
  await p.fill('#tt', 'Pagar la factura de internet');
  await p.fill('#td', addDays(-1));
  await p.locator('#td').dispatchEvent('change');
  await p.locator('#sf button[type=submit]').click();
  await p.locator('.sec h3').filter({ hasText: 'Atrasadas · 1' }).waitFor();
  await p.locator('[data-a=newtask]').click();
  await p.fill('#tt', 'Renovar el pasaporte');
  await p.locator('.chip[data-v=""]').click();
  await p.getByRole('button', { name: 'Alta' }).click();
  await p.locator('#sf button[type=submit]').click();
  await p.locator('.sec h3').filter({ hasText: 'Cuando tengas energía' }).waitFor();
  await p.locator('.it').filter({ hasText: 'Curso de fotografía' }).waitFor();   // la de Hoy
  await shot(p, '06-hoy-lleno');
  await p.locator('.it').filter({ hasText: 'Pagar la factura' }).getByRole('button', { name: /Posponer/ }).click();
  await shot(p, '07-posponer');
  await p.getByRole('button', { name: /Mañana/ }).click();
  await toast(p, /Reprogramada: Mañana/);
  await p.locator('.sec h3').filter({ hasText: 'Atrasadas' }).waitFor({ state: 'detached' });
});
await step('completar tareas y verlas en el historial junto con lo hecho en listas', async () => {
  await p.locator('.it').filter({ hasText: 'Curso de fotografía' }).locator('.chk').click();
  await toast(p, /Deshacer/);
  await p.locator('.cheer').filter({ hasText: 'completaste 2' }).waitFor();
  await p.getByRole('button', { name: 'Tareas' }).click();
  await p.getByRole('button', { name: 'Hecho', exact: true }).click();
  await p.locator('.it.done').filter({ hasText: 'Curso de fotografía' }).waitFor();
  await p.locator('.it.done').filter({ hasText: 'Curso de Excel' }).filter({ hasText: 'Terminado' }).waitFor();
  await p.locator('.it.done').filter({ hasText: 'Sacar pasajes' }).waitFor();
  await p.locator('.sec h3').filter({ hasText: 'Hoy · 3' }).waitFor();
  await shot(p, '08-historial');
  // reabrir desde el historial
  await p.locator('.it.done').filter({ hasText: 'Curso de fotografía' }).locator('.chk').click();
  await p.locator('.it.done').filter({ hasText: 'Curso de fotografía' }).waitFor({ state: 'detached' });
});
await step('recordatorio vencido muestra aviso en la app con acciones', async () => {
  await p.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('foco.v1'));
    const t = Object.values(S.data.tasks).find(x => x.t === 'Renovar el pasaporte');
    t.r = Date.now() - 2000; t.rk = 'custom'; t.u = Date.now() + 5; S.dirty = true;
    localStorage.setItem('foco.v1', JSON.stringify(S));
  });
  await p.reload();
  await p.locator('.rmc').filter({ hasText: 'Renovar el pasaporte' }).waitFor({ timeout: 8000 });
  await shot(p, '09-aviso');
  await p.locator('.rmc').getByRole('button', { name: '+1 h' }).click();
  await p.locator('.rmc').waitFor({ state: 'detached' });
  const t = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('foco.v1')).data.tasks).find(x => x.t === 'Renovar el pasaporte'));
  assert.ok(t.r > Date.now() + 50 * 60000 && t.r < Date.now() + 70 * 60000, 'aviso movido ~1 hora');
  assert.equal(t.rk, 'at');
  // un empujón de push mientras la app está abierta también muestra la tarjeta
  await p.evaluate(id => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'reminder', id, r: 77 } })), t.id);
  await p.locator('.rmc').filter({ hasText: 'Renovar el pasaporte' }).waitFor();
  await p.locator('.rmc').getByRole('button', { name: 'Hecha' }).click();
});
await step('Ajustes: activar avisos suscribe el dispositivo en el servidor y la prueba llega', async () => {
  await p.getByRole('button', { name: 'Ajustes' }).click();
    await p.getByRole('button', { name: 'Activar avisos de recordatorios' }).click();
  await p.locator('.set-row').filter({ hasText: 'Activados' }).waitFor();
  const user = JSON.parse(store.get('user:ana@mail.com'));
  assert.equal(user.push.length, 1);
  assert.equal(user.push[0].endpoint, 'https://push.example.com/send/e2e');
  await p.getByRole('button', { name: 'Enviar aviso de prueba' }).click();
  await toast(p, /Aviso enviado/);
  assert.ok(pushed.includes('https://push.example.com/send/e2e'));
  await shot(p, '10-ajustes');
});
await step('Agenda: conectar Google Calendar, ver eventos y tareas con fecha', async () => {
  await p.getByRole('button', { name: 'Volver' }).click();
  await p.getByRole('button', { name: 'Agenda' }).click();
  await shot(p, '11-agenda-sin-conectar');
  await p.getByRole('button', { name: 'Conectar con Google' }).click();
  await p.locator('.ev').filter({ hasText: 'Reunión con Pedro' }).waitFor();
  await p.locator('.dayh').filter({ hasText: 'Mañana' }).waitFor();
  await p.locator('.it').filter({ hasText: 'Llamar al dentista' }).waitFor();
  await shot(p, '12-agenda');
});
await step('Hoy muestra los próximos eventos de Google', async () => {
  await p.getByRole('button', { name: 'Hoy', exact: true }).first().click();
  await p.locator('.sec h3').filter({ hasText: 'Próximos eventos' }).waitFor();
  await p.locator('.ev').filter({ hasText: 'Reunión con Pedro' }).waitFor();
});
await step('crear un bloque de tiempo desde una tarea', async () => {
  await p.getByRole('button', { name: 'Agenda' }).click();
  await p.locator('.it').filter({ hasText: 'Llamar al dentista' }).locator('.main').click();
  await p.selectOption('#tdur', '45');
  await p.getByRole('button', { name: /Bloquear tiempo/ }).click();
  await toast(p, /Bloque creado/);
  assert.equal(gcalPosts.length, 1);
  const g = gcalPosts[0];
  assert.equal(g.summary, 'Llamar al dentista');
  assert.equal(new Date(g.end.dateTime) - new Date(g.start.dateTime), 45 * 60000);
  assert.equal(new Date(g.start.dateTime).getTime(), new Date(`${addDays(1)}T18:00:00-03:00`).getTime());
  assert.equal(g.start.timeZone, 'America/Buenos_Aires');
  await p.locator('.it').filter({ hasText: 'Llamar al dentista' }).locator('.mt').filter({ hasText: '📅' }).waitFor();
});
await step('crear un evento suelto desde la Agenda', async () => {
  await p.getByRole('button', { name: /Bloque de tiempo o evento/ }).click();
  await p.fill('#et', 'Estudiar inglés');
  await p.fill('#em', '20:00');
  await p.getByRole('button', { name: 'Crear en Google Calendar' }).click();
  await toast(p, /Evento creado/);
  assert.equal(gcalPosts.length, 2);
  assert.equal(gcalPosts[1].summary, 'Estudiar inglés');
});
await step('sincronización: otro dispositivo ve todo', async () => {
  await p.getByRole('button', { name: 'Hoy', exact: true }).first().click();
  await p.getByRole('button', { name: 'Ajustes' }).click();
  await p.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await toast(p, /sincronizado/i);
  const B = await newDevice();
  await B.page.goto(APP);
  await B.page.fill('[data-au=email]', 'ana@mail.com');
  await B.page.fill('[data-au=pass]', pw);
  await B.page.locator('form#af button[type=submit]').click();
  await B.page.locator('#hi').filter({ hasText: 'Hola Ana' }).waitFor();
  const d = await B.page.evaluate(() => JSON.parse(localStorage.getItem('foco.v1')).data);
  assert.ok(Object.values(d.tasks).some(t => t.t === 'Llamar al dentista' && t.ev === 'new1'));
  assert.equal(Object.values(d.lists).filter(l => !l.del)[0].n, 'Para aprender');
  assert.equal(Object.values(d.projects)[0].n, 'Viaje a Mendoza');
  await B.page.getByRole('button', { name: 'Tareas' }).click();
  await B.page.locator('.it').filter({ hasText: 'Llamar al dentista' }).waitFor();
  await B.ctx.close();
});
await step('modo oscuro y sin desbordes horizontales', async () => {
  const D = await newDevice({ colorScheme: 'dark' });
  await D.page.goto(APP);
  await D.page.fill('[data-au=email]', 'ana@mail.com');
  await D.page.fill('[data-au=pass]', pw);
  await D.page.locator('form#af button[type=submit]').click();
  await D.page.locator('#hi').waitFor();
  await shot(D.page, '13-hoy-oscuro');
  for (const tab of ['Hoy', 'Tareas', 'Listas', 'Agenda']) {
    await D.page.getByRole('button', { name: tab, exact: true }).first().click();
    const over = await D.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `desborde horizontal en ${tab}: ${over}`);
  }
  await D.ctx.close();
});
await step('escritorio: se ve bien en pantalla ancha', async () => {
  const W = await newDevice({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await W.page.goto(APP);
  await W.page.fill('[data-au=email]', 'ana@mail.com');
  await W.page.fill('[data-au=pass]', pw);
  await W.page.locator('form#af button[type=submit]').click();
  await W.page.locator('#hi').waitFor();
  await shot(W.page, '14-escritorio');
  await W.ctx.close();
});
await step('sesión vencida: vuelve al ingreso con aviso', async () => {
  await p.evaluate(() => { const S = JSON.parse(localStorage.getItem('foco.v1')); S.token = S.token.slice(0, -3) + 'xxx'; localStorage.setItem('foco.v1', JSON.stringify(S)); });
  await p.reload();
  await p.locator('.err').filter({ hasText: 'sesión venció' }).waitFor();
});
await step('eliminar la cuenta borra todo', async () => {
  await p.fill('[data-au=email]', 'ana@mail.com'); await p.fill('[data-au=pass]', pw);
  await p.locator('form#af button[type=submit]').click();
  await p.locator('#hi').waitFor();
  await p.getByRole('button', { name: 'Ajustes' }).click();
  await p.getByRole('button', { name: 'Eliminar mi cuenta y mis datos' }).click();
  await p.getByRole('button', { name: 'Sí, eliminar todo' }).click();
  await p.locator('.auth').waitFor();
  assert.equal(store.has('user:ana@mail.com'), false);
});

assert.deepEqual(errors, [], 'errores en la consola del navegador');
await browser.close(); api.close(); web.close();
console.log(`\n${n} pasos OK`);
