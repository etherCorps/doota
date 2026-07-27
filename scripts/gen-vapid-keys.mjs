// SPDX-License-Identifier: Apache-2.0
// Generate a VAPID keypair for Web Push (docs/notifications.md, Phase B).
//   node scripts/gen-vapid-keys.mjs
// Then set on the web + mail-inbound + mail-jobs workers:
//   VAPID_PUBLIC_KEY  → plaintext var (safe to expose; the client subscribes with it)
//   VAPID_PRIVATE_KEY → secret  (wrangler secret put VAPID_PRIVATE_KEY)
//   VAPID_SUBJECT     → var, e.g. "mailto:admin@yourdomain"
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 0x04 || x || y (65)
const jwk = await subtle.exportKey('jwk', kp.privateKey); // jwk.d is base64url of the 32-byte scalar

const publicKey = Buffer.from(pubRaw).toString('base64url');
const privateKey = jwk.d;

console.log('VAPID_PUBLIC_KEY =', publicKey);
console.log('VAPID_PRIVATE_KEY =', privateKey);
console.log('\n# public var (all 3 workers):  wrangler ... [set VAPID_PUBLIC_KEY in wrangler vars]');
console.log('# private secret (all 3 workers):  echo "%s" | wrangler secret put VAPID_PRIVATE_KEY', privateKey);
console.log('# subject var:  VAPID_SUBJECT = mailto:admin@yourdomain');
