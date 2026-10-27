# Foco

Organizador personal pensado para personas con TDAH: sacá las cosas de la cabeza **sin clasificarlas**, convertilas después en acciones concretas y dejá que la app te lo recuerde. PWA instalable en el celular y usable en la compu. Funciona sin conexión y sincroniza con tu cuenta.

## Qué incluye (MVP)

| | |
|---|---|
| **Cuenta y sincronización** | Email + contraseña. Datos en la nube; dos dispositivos se combinan sin perder cambios (cada tarea, idea e ítem se combina por separado). |
| **Captura rápida** | Campo en *Hoy* y botón **+** flotante en todas las pantallas (también el atajo del ícono: "Capturar"). Enter guarda y deja listo para la siguiente. Todo cae en la **Bandeja**, sin clasificar. |
| **Bandeja → acción** | Cada idea se convierte con un toque en **tarea** (con fecha, aviso, prioridad y subtareas) o se pasa a una **lista**. |
| **Tareas y proyectos** | Tareas con notas, estado, prioridad, fecha y hora, subtareas y proyectos. Al escribir `llamar al dentista mañana a las 18` entiende fecha y hora. |
| **Listas personalizadas** | Deseos, cursos, libros, lugares o las tuyas, con emoji. Se marcan como *conseguido/terminado/leído/visitado* y cada ítem puede volverse tarea. |
| **Recordatorios** | A la hora, 10 min o 1 h antes, ese día 9:00, el día anterior, o fecha y hora a elección. **Posponer** (1 h, esta tarde, mañana, fin de semana, semana próxima) o reprogramar. Llegan como notificación aunque la app esté cerrada. |
| **Hoy** | Lo de hoy, lo atrasado (sin culpa, con ⏰ para reprogramar), "cuando tengas energía" (importantes sin fecha) y próximos eventos de Google. |
| **Google Calendar** | Ver eventos (Hoy y Agenda), crear **bloques de tiempo** desde una tarea o eventos sueltos. |
| **Historial** | *Tareas → Hecho*: lo completado por día, tareas y cosas de tus listas. Tocar una para reabrirla. |

## Cómo está armado

```
foco/
├── web/       La app (HTML/CSS/JS sin build). Es lo que va a Vercel.
├── server/    API en Cloudflare Worker + KV: cuentas, sincronización y envío de avisos.
├── shared/    Lógica de combinación de datos (una sola fuente para app y servidor).
└── scripts/   setup-server.sh, íconos, pruebas.
```

Es una copia de **Compras** (mismo esquema de cuentas, sincronización, hojas flotantes, barra flotante), con otra paleta (índigo) y un modelo de datos nuevo. Usa **su propio** servidor, KV y secretos: no reutilices los de Compras.

Cómo funcionan los avisos con la app cerrada: el servidor revisa cada minuto (Cron de Cloudflare) si hay recordatorios vencidos y manda un *Web Push* cifrado (VAPID + RFC 8291, sin librerías). Para no gastar el cupo gratis de KV, lleva un índice con la hora del próximo aviso de cada cuenta y solo lee más datos cuando algo vence.

## Publicar

Necesitás Node 20+ y cuentas gratuitas de Cloudflare y Vercel.

### 1) Servidor (un solo comando)

En la Terminal, dentro de la carpeta del proyecto:

```bash
sh scripts/setup-server.sh
```

Instala lo necesario, abre el navegador para iniciar sesión en Cloudflare, crea la base, genera las claves secretas (incluidas las de avisos) y publica. Al final muestra la dirección `https://foco-server.TU-USUARIO.workers.dev`. Abrí `…/health`: debe responder `{"ok":true}`. Si la dirección no coincide con la de `web/config.js` (`API_URL`), corregila ahí.

### 2) App (Vercel)

Nuevo proyecto en Vercel desde el repositorio, con **Root Directory = `web`** y sin comando de build. Después de publicar, abrí la URL desde el celular.

### 3) Google Calendar (opcional, 5–10 min, una vez)

La app pide permiso a Google desde el navegador; no hay servidor de por medio. Necesita un "ID de cliente" propio y gratuito:

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com) → **Nuevo proyecto** (nombre: Foco).
2. **APIs y servicios → Biblioteca** → buscá **Google Calendar API** → **Habilitar**.
3. **Pantalla de consentimiento de OAuth** (o *Google Auth Platform*): nombre *Foco*, tu email de contacto, público **Externo**. En **Público → Usuarios de prueba** agregá **tu Gmail**. En **Acceso a los datos** agregá el permiso `…/auth/calendar.events`.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**. En **Orígenes autorizados de JavaScript** poné la URL de tu app en Vercel (ej. `https://foco.vercel.app`, sin barra al final). Crear.
5. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pegalo en `web/config.js` → `GOOGLE_CLIENT_ID`. Volvé a publicar.
6. En la app: **Agenda → Conectar con Google**. Aparecerá "Google no verificó esta aplicación": **Configuración avanzada → Ir a Foco** (es tu propia app, en modo de prueba).

Notas: Google entrega una llave que dura ~1 hora; pasado ese tiempo la Agenda te pide "Actualizar" con un toque. En iPhone, la ventana de Google dentro de la app instalada puede comportarse distinto: si no abre, conectá una vez desde Safari.

### 4) Avisos en el celular

*Ajustes → Activar avisos de recordatorios* → aceptar el permiso. Después probá con **Enviar aviso de prueba**.

- **Android (Chrome):** funciona instalada o no.
- **iPhone:** primero **instalá la app** (Safari → Compartir → *Agregar a inicio*) y abrila desde el ícono; iOS 16.4 o más nuevo.
- Sin avisos configurados en el servidor, igual aparecen tarjetas de recordatorio mientras la app está abierta.

## Pruebas

```bash
npm run sync-shared     # copia shared/merge.js a web/ y server/ (hacelo tras editarlo)
node scripts/test.mjs   # 24 pruebas: datos, cifrado de avisos (con el ejemplo oficial del RFC 8291) y servidor
node scripts/e2e.mjs    # 22 pasos en un navegador real (E2E_CSP=1 aplica los encabezados de seguridad reales)
```

Lo que **no** se puede probar sin cuentas reales: el consentimiento de Google y la entrega real de avisos por los servidores de Apple/Google (se prueban con simulaciones y con el cifrado verificado contra el RFC).

## Privacidad

Contraseñas con PBKDF2 (100.000 iteraciones). Sesiones de 60 días. La llave de Google queda solo en tu navegador. Para el contacto técnico de los avisos se usa el email que escribas en `setup-server.sh`, no el de las cuentas. *Ajustes → Exportar* descarga todo en JSON; *Eliminar mi cuenta* borra todo.
