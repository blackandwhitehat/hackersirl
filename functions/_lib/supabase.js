// Supabase REST helpers — minimal client so Pages Functions don't need
// the @supabase/supabase-js dependency. All calls use the service role
// key from env (server-side only, never sent to the browser).

export function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'content-type': 'application/json',
  };
}

export async function sbInsert(env, table, row, opts = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const headers = sbHeaders(env);
  if (opts.returning !== false) headers.prefer = 'return=representation';
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`sbInsert ${table}: ${r.status} ${await r.text()}`);
  return opts.returning === false ? null : (await r.json())[0];
}

// Match values default to `eq.<v>` for ergonomics. If a value already
// starts with a PostgREST operator prefix (eq./neq./in./not./gt./
// lt./gte./lte./like./ilike./is.), it's passed through verbatim.
// Lets callers gate writes on a status condition, e.g.:
//   sbUpdate(env, 'hir_submissions',
//     { id, status: 'not.in.(published,rejected)' },
//     { ... });
//
// Returns the array of rows that matched + were updated. Empty array
// = the guard rejected the write (caller can detect replay/race).
const PGRST_OP_PREFIX = /^(eq|neq|in|not|gt|lt|gte|lte|like|ilike|is|fts)\./;

export async function sbUpdate(env, table, match, patch) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(match)) {
    const sv = String(v);
    params.set(k, PGRST_OP_PREFIX.test(sv) ? sv : `eq.${sv}`);
  }
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`sbUpdate ${table}: ${r.status} ${await r.text()}`);
  return await r.json();
}

export async function sbSelect(env, table, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${sp}`;
  const r = await fetch(url, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`sbSelect ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sbStorageUpload(env, bucket, key, body, contentType) {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  });
  if (!r.ok) throw new Error(`sbStorageUpload: ${r.status} ${await r.text()}`);
  return `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`;
}

// Delete an object from a Storage bucket. Used to actively scrub
// raw caller audio after an anon swap completes so the unscrambled
// voice doesn't sit in the public bucket forever.
export async function sbStorageDelete(env, bucket, key) {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  // 200 ok, 404 already gone — both are fine. Anything else is real.
  if (!r.ok && r.status !== 404) {
    throw new Error(`sbStorageDelete: ${r.status} ${await r.text()}`);
  }
  return true;
}

export async function sbStorageFetch(env, bucket, key) {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  const r = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`sbStorageFetch: ${r.status}`);
  return r;
}
