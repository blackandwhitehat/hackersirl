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
  // Length difference is a hard fail; comparing different lengths
  // would either pad and obscure the result or short-circuit, so
  // declare unequal up front. The lengths themselves are not secrets.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Same idea but for byte-array inputs (used by the HMAC compare path).
export function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const av = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bv = b instanceof Uint8Array ? b : new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

// Shared admin authorization gate. Every /api/admin/* handler should
// call this exactly once at the top of the request.
//
// Single acceptable signal: Cloudflare Access has authenticated the
// request and the email matches env.ADMIN_EMAIL (case-insensitive).
// CF Access is doing the JWT validation at the edge before we see
// the request; the function only needs to assert the identity is
// the configured admin.
//
// The previous bearer fallback (Authorization: Bearer <ADMIN_BEARER>)
// was removed: an admin-only back-channel that lives in env vars and
// localStorage is exactly the thing the public web should never have
// to think about, and it was the largest XSS-takeover surface on
// the page. CF Access OTP is the only path now.
export function isAdmin(request, env) {
  const accessEmail = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  return !!(accessEmail && adminEmail && accessEmail === adminEmail);
}
