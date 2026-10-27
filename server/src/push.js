// Web Push sin librerías: firma VAPID (ES256) + cifrado de contenido aes128gcm (RFC 8188 / RFC 8291).
const enc = new TextEncoder();

export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/* Claves de recepción del navegador → clave pública P-256 importable */
const importPub = raw => crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

/* Claves y secreto compartido (comunes a cifrar y descifrar) */
async function deriveKeys(ecdh, uaPub, asPub, authSecret, salt) {
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  return { cek: await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt', 'decrypt']), nonce };
}

/* Cifra `payload` (string) para una suscripción {keys:{p256dh,auth}}. `fixed` solo se usa en las pruebas. */
export async function encryptPayload(sub, payload, fixed) {
  const uaPub = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  let asPriv, asPubRaw;
  if (fixed && fixed.asPrivJwk) {
    asPriv = await crypto.subtle.importKey('jwk', fixed.asPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPubRaw = fixed.asPub;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey;
    asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const salt = (fixed && fixed.salt) || crypto.getRandomValues(new Uint8Array(16));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPub(uaPub) }, asPriv, 256));
  const { cek, nonce } = await deriveKeys(ecdh, uaPub, asPubRaw, authSecret, salt);
  const plain = cat(enc.encode(payload), new Uint8Array([2]));      // 0x02 = último registro, sin relleno
  if (plain.length > 3993) throw new Error('payload too large');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, plain));
  const rs = new Uint8Array([0, 0, 0x10, 0]);                        // 4096
  return cat(salt, rs, new Uint8Array([asPubRaw.length]), asPubRaw, ct);
}

/* Descifra (para pruebas): el navegador hace esto con su clave privada. */
export async function decryptPayload(body, uaPrivJwk, uaPubRaw, authSecret) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const uaPriv = await crypto.subtle.importKey('jwk', uaPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPub(asPub) }, uaPriv, 256));
  const { cek, nonce } = await deriveKeys(ecdh, uaPubRaw, asPub, authSecret, salt);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, ct));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('bad padding');
  return new TextDecoder().decode(plain.slice(0, end));
}

/* Cabecera Authorization de VAPID (JWT firmado con la clave privada del servidor). */
export async function vapidAuth(endpoint, env, now) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor((now || Date.now()) / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:foco@example.com' })));
  const pub = unb64u(env.VAPID_PUBLIC);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)));  // ya viene r||s
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + env.VAPID_PUBLIC;
}

/* Envía un aviso. Devuelve el status HTTP (201 ok; 404/410 = suscripción muerta). */
export async function sendPush(sub, message, env, fetchFn) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await (fetchFn || fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '86400', Urgency: 'high'
    },
    body
  });
  return res.status;
}
