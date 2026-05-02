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
// Two acceptable signals (any one passes):
//   1. Cloudflare Access has authenticated the request and the email
//      matches env.ADMIN_EMAIL (case-insensitive). Production path.
//   2. An Authorization: Bearer <ADMIN_BEARER> header matches the
//      env's ADMIN_BEARER value via constant-time compare. Back-channel
//      for emergency use; should be rotated frequently.
export function isAdmin(request, env) {
  const accessEmail = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  if (accessEmail && adminEmail && accessEmail === adminEmail) return true;

  const auth = request.headers.get('authorization') || '';
  if (env.ADMIN_BEARER && auth.startsWith('Bearer ')) {
    const presented = auth.slice('Bearer '.length);
    return timingSafeEqual(presented, env.ADMIN_BEARER);
  }
  return false;
}
