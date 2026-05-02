// Constant-time string comparison + small auth helpers shared across
// the admin handlers + the Twilio signature verifier. Plain `===` on
// secrets short-circuits on first mismatched byte and leaks structure
// over time; for short fixed-length tokens (HMACs, bearers) the leak
// is small but real, and removing it is one well-understood line.
//
// Workers runtime exposes Web Crypto + ArrayBuffer; we hand-roll the
// XOR-fold rather than reach for crypto.subtle.timingSafeEqual which
// isn't broadly available there.

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const av = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bv = b instanceof Uint8Array ? b : new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

// ── Cloudflare Access JWT verification ─────────────────────────────
// CF Access fronts /admin and /api/admin. After the user authenticates
// it forwards the request to origin with `cf-access-jwt-assertion: <jwt>`.
// Some configurations also set `cf-access-authenticated-user-email`
// directly, but that header is no longer guaranteed — the canonical
// identity lives in the JWT itself, signed by the team's RSA key.
//
// We verify the signature against the public JWKS at
//   https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
// and check `aud` matches the Access application audience tag. With
// those two checks, the JWT body's `email` claim is trustworthy.

const _certsCache = new Map(); // key = teamDomain, value = { keys, fetchedAt }
const CERTS_TTL_MS = 60 * 60 * 1000;

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
}

async function getCerts(teamDomain) {
  const cached = _certsCache.get(teamDomain);
  if (cached && (Date.now() - cached.fetchedAt) < CERTS_TTL_MS) return cached.keys;
  const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certs fetch ${r.status}`);
  const { keys } = await r.json();
  _certsCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

export async function verifyAccessJwt(jwt, teamDomain, audience) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt malformed');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlDecodeJson(headerB64);
  const payload = b64urlDecodeJson(payloadB64);

  if (header.alg !== 'RS256') throw new Error(`unsupported alg ${header.alg}`);
  const keys = await getCerts(teamDomain);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('no matching kid');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const sig = b64urlDecode(sigB64);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data);
  if (!ok) throw new Error('signature invalid');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('not yet valid');

  // `aud` may be a string or array
  const audMatch = Array.isArray(payload.aud)
    ? payload.aud.includes(audience)
    : payload.aud === audience;
  if (!audMatch) throw new Error('aud mismatch');

  return payload;
}

// Pull the verified email from the request. Tries the legacy header
// first (cheap, still set on some Access plans), falls back to JWT
// validation. Returns the lowercased email or '' on any failure.
export async function accessEmail(request, env) {
  const headerEmail = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (headerEmail) return headerEmail;

  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return '';
  const team = env.CF_ACCESS_TEAM_DOMAIN; // e.g. "bamboosec.cloudflareaccess.com"
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return '';

  try {
    const payload = await verifyAccessJwt(jwt, team, aud);
    return (payload.email || '').toLowerCase();
  } catch {
    return '';
  }
}

// Shared admin authorization gate. Every /api/admin/* handler should
// call this exactly once at the top of the request.
//
// Acceptable signal: Cloudflare Access has authenticated the request
// (verified JWT or legacy header) and the email matches env.ADMIN_EMAIL
// case-insensitively. The previous bearer fallback was removed —
// CF Access is the only path.
export async function isAdmin(request, env) {
  const email = await accessEmail(request, env);
  const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  return !!(email && adminEmail && email === adminEmail);
}
