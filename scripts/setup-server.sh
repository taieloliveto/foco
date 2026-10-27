#!/bin/sh
# Prepara y publica el servidor de Foco en Cloudflare con UN solo comando:   sh scripts/setup-server.sh
# Hace: instalar herramientas → iniciar sesión → crear la base (KV) → generar claves secretas → publicar.
# Se puede volver a correr sin problema (no recrea lo que ya existe, ni invalida las sesiones).
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
cd server

echo "== 1/5  Instalando herramientas (puede tardar un minuto)…"
npm install --silent

echo "== 2/5  Iniciando sesión en Cloudflare (se abre el navegador; tocá «Allow»)…"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

echo "== 3/5  Base de datos (KV)…"
if grep -q "REEMPLAZAR_CON_EL_ID_DE_TU_KV" wrangler.toml; then
  OUT="$(npx wrangler kv namespace create foco_kv 2>&1)" || { echo "$OUT"; exit 1; }
  ID="$(echo "$OUT" | grep -o 'id = "[0-9a-f]\{32\}"' | head -1 | sed 's/id = "\(.*\)"/\1/')"
  if [ -z "$ID" ]; then echo "No pude leer el id del KV. Esto devolvió Cloudflare:"; echo "$OUT"; exit 1; fi
  sed "s/REEMPLAZAR_CON_EL_ID_DE_TU_KV/$ID/" wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml
  echo "   KV creado."
else
  echo "   Ya estaba creado."
fi

echo "== 4/5  Claves secretas…"
if [ ! -f .secrets-set ]; then
  printf "Tu email (solo se usa como contacto técnico de los avisos; no se comparte con nadie más): "
  read EMAIL
  case "$EMAIL" in *@*.*) ;; *) echo "Ese email no parece válido."; exit 1;; esac
  printf '\n[vars]\nVAPID_SUBJECT = "mailto:%s"\n' "$EMAIL" >> wrangler.toml
  openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SERVER_SECRET
  KEYS="$(node "$ROOT/scripts/gen-vapid.mjs")"
  echo "$KEYS" | sed -n 's/^PUBLICA=//p' | tr -d '\n' | npx wrangler secret put VAPID_PUBLIC
  echo "$KEYS" | sed -n 's/^PRIVADA=//p' | tr -d '\n' | npx wrangler secret put VAPID_PRIVATE
  date > .secrets-set
else
  echo "   Ya estaban cargadas."
fi

echo "== 5/5  Publicando el servidor…"
npx wrangler deploy

echo
echo "Listo. Copiá la dirección que termina en .workers.dev (arriba) y abrila agregando /health al final."
echo "Tiene que mostrar {\"ok\":true}. Si la dirección es distinta a la de web/config.js, avisame cuál es."
