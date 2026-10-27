// Configuración pública de Foco (no son secretos).
window.FOCO_CONFIG = {
  // URL del servidor (Cloudflare Worker). Si está completa, la app NO la pide en el ingreso.
  API_URL: "https://foco-server.cierreproyecto.workers.dev",
  // Clave pública de avisos (la genera scripts/setup-server.sh). Vacía = sin avisos con la app cerrada.
  VAPID_PUBLIC: "",
  // ID de cliente OAuth de Google para Calendar (ver README). Vacío = Agenda desactivada.
  GOOGLE_CLIENT_ID: ""
};
