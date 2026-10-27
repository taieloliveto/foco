// Genera el par de claves VAPID (identifican a tu servidor ante los servicios de avisos del navegador).
// Uso: node scripts/gen-vapid.mjs   → imprime dos líneas: PUBLICA=… y PRIVADA=…
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
console.log('PUBLICA=' + b64u(await crypto.subtle.exportKey('raw', kp.publicKey)));
console.log('PRIVADA=' + (await crypto.subtle.exportKey('jwk', kp.privateKey)).d);
