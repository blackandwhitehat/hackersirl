// Admin queue UI. Extracted from inline <script> in index.html so the
// strict /admin/* CSP (script-src 'self') doesn't have to allow
// 'unsafe-inline'. Auth: Cloudflare Access only — CF Access sets
// cf-access-authenticated-user-email server-side and the Pages
// Functions enforce it. The browser never holds a credential.

const WHO = document.getElementById('who');

// Strip any legacy ?token= from the URL without storing it. The
// bearer-via-URL pattern was removed: tokens leaked via history,
// CF Access redirect_url echo-back, and Referer.
if (new URLSearchParams(location.search).get('token')) {
  history.replaceState(null, '', location.pathname);
}
// Clean any stale bearer from a previous deployment so the browser
// never sends an Authorization header to /api/admin.
localStorage.removeItem('hir_admin_bearer');

const authHeaders = () => ({});

document.getElementById('logout-btn').addEventListener('click', () => {
  location.href = '/cdn-cgi/access/logout?redirect_url=/admin/';
});

// Gate-render: hit /api/admin/whoami first. Everything else (queue,
// show-assets, identity badge) only runs after we know the API
// considers the caller admin. Until that resolves, the body sits at
// data-auth="unknown" which keeps both the queue and the sign-in
// card hidden — no flash of either state.
async function probeAuth() {
  try {
    const r = await fetch('/api/admin/whoami', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.admin ? j : null;
  } catch {
    return null;
  }
}

probeAuth().then(me => {
  if (!me) {
    document.body.dataset.auth = 'anon';
    return;
  }
  document.body.dataset.auth = 'admin';
  if (me.email) WHO.textContent = me.email;
  loadShowAssets();
  load();
});

const ASSET_LABELS = {
  intro:       { label: 'Intro voice',         tts: true,  upload: true,  hint: 'Manifesto-y opener. 20-30s ideal.' },
  outro:       { label: 'Outro voice',         tts: true,  upload: true,  hint: 'Phone CTA + sign-off. 20-30s ideal.' },
  bg_intro:    { label: 'BG music (intro)',    tts: false, upload: true,  hint: 'Mixed at -14dB under intro voice. 20-60s loopable.' },
  bg_outro:    { label: 'BG music (outro)',    tts: false, upload: true,  hint: 'Mixed at -14dB under outro voice.' },
  phone_tones: { label: 'Phone-tones intro',   tts: false, upload: true,  hint: 'Plays before the show intro. 10-15s.' },
};

let _voiceCache = null;
async function getVoices() {
  if (_voiceCache) return _voiceCache;
  try {
    const r = await fetch('/api/admin/voices', { credentials: 'include' });
    if (!r.ok) return [];
    const { voices } = await r.json();
    _voiceCache = voices || [];
    return _voiceCache;
  } catch { return []; }
}

async function loadShowAssets() {
  const panel = document.getElementById('show-assets-panel');
  try {
    const [r, voices] = await Promise.all([
      fetch('/api/admin/show-assets', { credentials: 'include', headers: authHeaders() }).then(x => x.ok ? x.json() : Promise.reject(new Error('http ' + x.status))),
      getVoices(),
    ]);
    const { assets } = r;
    panel.innerHTML = Object.entries(ASSET_LABELS).map(([type, cfg]) => {
      const a = assets[type];
      const voiceOpts = voices.map(v => {
        const sel = a && a.voice_id === v.id ? ' selected' : '';
        return `<option value="${esc(v.id)}"${sel}>${esc(v.label)}</option>`;
      }).join('');
      return `
        <div class="asset-card" data-type="${type}" style="border:1px dashed #2a2;border-radius:6px;padding:0.6rem;margin-bottom:0.6rem">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="color:#00ff88">${cfg.label}</strong>
            <span style="color:#999;font-size:0.85rem">${cfg.hint}</span>
          </div>
          ${a ? `<audio controls preload="metadata" src="${audioSrc(a.audio_url)}" style="width:100%;margin-top:0.4rem"></audio>` :
                 '<div style="color:#888;font-size:0.85rem;margin-top:0.4rem">(none configured)</div>'}
          ${cfg.tts ? `
            <div class="tts-form" style="margin-top:0.6rem;display:flex;flex-direction:column;gap:0.4rem">
              <textarea class="tts-text" rows="3" placeholder="Text the presenter will say..."
                style="background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:0.5rem;font-size:0.85rem;resize:vertical">${esc(a?.text_source || '')}</textarea>
              <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
                <label style="font-family:var(--mono);font-size:0.65rem;color:var(--dim);text-transform:uppercase;letter-spacing:1px">Voice</label>
                <select class="tts-voice" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:0.35rem 0.5rem;font-family:inherit;font-size:0.85rem">${voiceOpts}</select>
                <button class="btn btn-tts-save" data-type="${type}">Save & render</button>
              </div>
            </div>
          ` : ''}
          ${cfg.upload ? `<div style="margin-top:0.5rem"><button class="btn btn-upload" data-type="${type}">${cfg.tts ? 'Or upload MP3' : 'Upload MP3'}</button></div>` : ''}
        </div>
      `;
    }).join('');
    panel.querySelectorAll('.btn-tts-save').forEach(b => b.addEventListener('click', onTtsAsset));
    panel.querySelectorAll('.btn-upload').forEach(b => b.addEventListener('click', onUploadAsset));
  } catch (e) {
    panel.innerHTML = `<div style="color:#ff3355">Failed to load: ${esc(e.message)}</div>`;
  }
}

async function onTtsAsset(ev) {
  const card = ev.target.closest('.asset-card');
  const type = ev.target.dataset.type;
  const text = card.querySelector('.tts-text').value.trim();
  const voiceId = card.querySelector('.tts-voice').value;
  if (text.length < 5) { alert('Need at least 5 characters of text.'); return; }
  ev.target.disabled = true; ev.target.textContent = 'Rendering...';
  const r = await fetch('/api/admin/show-assets', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ asset_type: type, mode: 'tts', text, voice_id: voiceId || undefined }),
  });
  if (r.ok) { loadShowAssets(); } else { alert('Render failed: ' + r.status + '\n' + (await r.text()).slice(0, 200)); ev.target.disabled = false; ev.target.textContent = 'Save & render'; }
}

function onUploadAsset(ev) {
  const type = ev.target.dataset.type;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm';
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    ev.target.disabled = true; ev.target.textContent = 'Uploading...';
    const fd = new FormData();
    fd.append('asset_type', type);
    fd.append('mode', 'upload');
    fd.append('file', f);
    const r = await fetch('/api/admin/show-assets', {
      method: 'POST', credentials: 'include',
      headers: authHeaders(),
      body: fd,
    });
    if (r.ok) { loadShowAssets(); } else { alert('Upload failed: ' + r.status); ev.target.disabled = false; ev.target.textContent = 'Upload MP3'; }
  });
  input.click();
}

const LIST = document.getElementById('list');
const FILTERS = document.querySelectorAll('.filter-btn');
let currentStatus = 'ready,processing,recording,publishing,published';

function fmtDate(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleDateString();
}
function fmtDur(s) { if (!s) return '-'; const m = Math.floor(s/60); const r = s%60; return m+':'+String(r).padStart(2,'0'); }
function esc(s) { return String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
// Defense-in-depth: only allow https URLs through to href/src. Stops
// `javascript:` (and any other scheme) cold if a malicious row ever
// lands in the DB. The data path is admin-only today, but cheap.
function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? esc(u) : ''; }

// Old submissions still reference api.twilio.com for handle/body audio.
// Browser can't authenticate to Twilio (basic auth), and our admin CSP
// doesn't allow api.twilio.com in media-src either. Rewrite the URL
// to our same-origin /api/admin/audio-proxy which streams the MP3
// after basic-auth on the server side.
function audioSrc(u) {
  if (typeof u !== 'string') return '';
  const m = u.match(/^https:\/\/api\.twilio\.com\/.*\/Recordings\/(RE[a-f0-9]{32})/i);
  if (m) return `/api/admin/audio-proxy?sid=${m[1]}`;
  return safeUrl(u);
}

async function load() {
  LIST.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const r = await fetch('/api/admin/submissions?status=' + encodeURIComponent(currentStatus), { credentials: 'include', headers: authHeaders() });
    if (!r.ok) {
      LIST.innerHTML = '<div class="empty">' + (r.status === 403 ? 'Access denied. Make sure your Cloudflare Access session is valid.' : 'Failed to load: ' + r.status) + '</div>';
      return;
    }
    const rows = await r.json();
    if (!rows.length) { LIST.innerHTML = '<div class="empty">No submissions in this state.</div>'; return; }
    LIST.innerHTML = rows.map(renderSubmission).join('');
    LIST.querySelectorAll('.btn-publish').forEach(b => b.addEventListener('click', onPublish));
    LIST.querySelectorAll('.btn-reject').forEach(b => b.addEventListener('click', onReject));
    LIST.querySelectorAll('.btn-update').forEach(b => b.addEventListener('click', onUpdate));
    LIST.querySelectorAll('.btn-unpublish').forEach(b => b.addEventListener('click', onUnpublish));
    LIST.querySelectorAll('.btn-rerender').forEach(b => b.addEventListener('click', onRerender));
    LIST.querySelectorAll('.btn-intro-render').forEach(b => b.addEventListener('click', onIntroRender));
  } catch (e) {
    LIST.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

function renderSubmission(s) {
  const isAnon = !!s.anon;
  const bodyAudio = isAnon && s.body_audio_anon_url ? s.body_audio_anon_url : s.body_audio_url;
  const ep = (s.hir_episodes && s.hir_episodes[0]) || null;
  const isPublishable = s.status === 'ready';
  const isPublished   = s.status === 'published' && ep;
  const isPublishing  = s.status === 'publishing';
  return `
    <div class="sub" data-id="${esc(s.id)}" ${ep ? `data-episode-id="${esc(ep.id)}"` : ''}>
      <div class="sub-head">
        <div>
          <span class="pill pill-status pill-${esc(s.status)}">${esc(s.status)}</span>
          ${isAnon ? '<span class="pill pill-anon">ANON · ' + esc(s.anon_voice_id || '?') + '</span>' : ''}
          <div class="sub-meta" style="margin-top:0.3rem">
            ${fmtDate(s.created_at)} · ${fmtDur(s.duration_seconds)}
          </div>
        </div>
      </div>
      ${s.handle_audio_url ? `<div class="audio-row"><label>Handle (caller)</label><audio controls preload="metadata" src="${audioSrc(s.handle_audio_url)}"></audio></div>` : ''}
      ${s.handle_intro_url || s.handle_intro_text ? `
        <div class="audio-row" style="border:1px dashed #00ff88;padding:0.6rem;border-radius:6px;margin-top:0.4rem">
          <label>Host intro (TTS in presenter voice)</label>
          ${s.handle_intro_url ? `<audio controls preload="metadata" src="${audioSrc(s.handle_intro_url)}"></audio>` : ''}
          <textarea class="intro-text" rows="2" style="background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:0.5rem;font-size:0.85rem;resize:vertical;margin-top:0.4rem;width:100%">${esc(s.handle_intro_text || '')}</textarea>
          <div style="margin-top:0.4rem">
            <button class="btn btn-intro-render">Save & re-render intro</button>
          </div>
        </div>` : ''}
      ${bodyAudio ? `<div class="audio-row"><label>Body${isAnon && s.body_audio_anon_url ? ' (anonymized)' : ''}</label><audio controls preload="metadata" src="${audioSrc(bodyAudio)}"></audio></div>` : '<div class="sub-meta">No body audio yet.</div>'}
      ${isAnon && s.body_audio_url && s.body_audio_anon_url ? `<details><summary>Original audio (anon caller)</summary><audio controls preload="metadata" src="${audioSrc(s.body_audio_url)}"></audio></details>` : ''}
      <details>
        <summary>Transcript</summary>
        <div class="transcript ${s.transcript ? '' : 'empty-tr'}">${esc(s.transcript || 'No transcript yet.')}</div>
      </details>
      ${s.preview_audio_url ? `
      <div class="audio-row" style="border:1px dashed #00ff88;padding:0.6rem;border-radius:6px;margin-top:0.6rem">
        <label>Final-mix preview (intro + handle + body + outro · ~${fmtDur(s.preview_duration_seconds)})</label>
        <audio controls preload="metadata" src="${audioSrc(s.preview_audio_url)}"></audio>
        <div style="margin-top:0.3rem"><a href="${safeUrl(s.preview_audio_url)}" download style="color:#00ff88">download mp3</a></div>
      </div>` : (s.body_audio_url && s.status !== 'recording' ? '<div class="sub-meta">Final-mix preview rendering... refresh in ~2 min</div>' : '')}
      ${isPublishable ? `
      <div class="draft">
        <label>Episode title</label>
        <input type="text" class="ep-title" value="${esc(s.suggested_title || '')}" placeholder="Title">
        <label>Description</label>
        <textarea class="ep-desc" placeholder="Description">${esc(s.suggested_description || '')}</textarea>
        <label>Episode number (optional)</label>
        <input type="number" class="ep-num" placeholder="e.g. 12">
        <div class="actions">
          <button class="btn btn-publish">Publish to feed</button>
          <button class="btn btn-rerender">Re-render preview</button>
          <button class="btn btn-reject">Reject</button>
        </div>
      </div>
      ` : ''}
      ${isPublishing ? `<div class="sub-meta">Publishing... cron picks up within 2 min</div>` : ''}
      ${isPublished ? `
      <div class="draft" style="border-top:1px solid #00ff88;margin-top:0.6rem;padding-top:0.6rem">
        <div style="font-weight:bold;color:#00ff88;margin-bottom:0.3rem">Published episode (editable)</div>
        ${ep.audio_url ? `<div class="audio-row"><label>Final episode</label><audio controls preload="metadata" src="${audioSrc(ep.audio_url)}"></audio><div><a href="${safeUrl(ep.audio_url)}" download style="color:#00ff88">download mp3</a></div></div>` : ''}
        <label>Title</label>
        <input type="text" class="ep-title" value="${esc(ep.title || '')}">
        <label>Description</label>
        <textarea class="ep-desc">${esc(ep.description || '')}</textarea>
        <label>Episode number</label>
        <input type="number" class="ep-num" value="${esc(ep.episode_number ?? '')}">
        <div class="actions">
          <button class="btn btn-update">Save changes</button>
          <button class="btn btn-rerender">Re-render</button>
          <button class="btn btn-unpublish">Unpublish (back to queue)</button>
          <button class="btn btn-reject">Reject (remove)</button>
        </div>
      </div>` : ''}
      ${(!isPublishable && !isPublished && !isPublishing) ? `<div class="actions"><button class="btn btn-reject">Reject</button></div>` : ''}
    </div>`;
}

async function onUpdate(ev) {
  const card = ev.target.closest('.sub');
  const episode_id = card.dataset.episodeId;
  if (!episode_id) { alert('No episode id on this card.'); return; }
  const title = card.querySelector('.ep-title').value.trim();
  const description = card.querySelector('.ep-desc').value.trim();
  const epNumRaw = card.querySelector('.ep-num').value.trim();
  if (!title || !description) { alert('Title and description required.'); return; }
  ev.target.disabled = true; ev.target.textContent = 'Saving...';
  const r = await fetch('/api/admin/update-episode', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      episode_id, title, description,
      episode_number: epNumRaw ? parseInt(epNumRaw, 10) : null,
    }),
  });
  if (r.ok) { ev.target.textContent = 'saved'; setTimeout(() => load(), 600); }
  else { alert('Save failed: ' + r.status); ev.target.disabled = false; ev.target.textContent = 'Save changes'; }
}

async function onPublish(ev) {
  const card = ev.target.closest('.sub');
  const id = card.dataset.id;
  const title = card.querySelector('.ep-title').value.trim();
  const description = card.querySelector('.ep-desc').value.trim();
  const epNum = card.querySelector('.ep-num').value.trim();
  if (!title || !description) { alert('Title and description required.'); return; }
  ev.target.disabled = true; ev.target.textContent = 'Publishing...';
  const r = await fetch('/api/admin/publish', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      submission_id: id, title, description,
      episode_number: epNum ? parseInt(epNum, 10) : null,
    }),
  });
  if (r.ok) { load(); } else { alert('Publish failed: ' + r.status + ' ' + (await r.text()).slice(0, 200)); ev.target.disabled = false; ev.target.textContent = 'Publish to feed'; }
}

async function onReject(ev) {
  const card = ev.target.closest('.sub');
  const id = card.dataset.id;
  const reason = prompt('Reject reason (optional):', '');
  if (reason === null) return;
  ev.target.disabled = true;
  const r = await fetch('/api/admin/reject', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ submission_id: id, reason: reason || null }),
  });
  if (r.ok) { load(); } else { alert('Reject failed: ' + r.status); ev.target.disabled = false; }
}

async function onIntroRender(ev) {
  const card = ev.target.closest('.sub');
  const submission_id = card?.dataset.id;
  const text = card?.querySelector('.intro-text')?.value.trim();
  if (!submission_id) return;
  if (!text || text.length < 5) { alert('Intro text needs at least 5 characters.'); return; }
  ev.target.disabled = true; ev.target.textContent = 'Rendering...';
  const r = await fetch('/api/admin/intro-render', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ submission_id, text }),
  });
  if (r.ok) {
    ev.target.textContent = 'Saved ✓';
    setTimeout(() => load(), 1000);
  } else {
    alert('Re-render failed: ' + r.status + '\n' + (await r.text()).slice(0, 200));
    ev.target.disabled = false; ev.target.textContent = 'Save & re-render intro';
  }
}

async function onRerender(ev) {
  const card = ev.target.closest('.sub');
  const episode_id = card?.dataset.episodeId;
  const submission_id = card?.dataset.id;
  ev.target.disabled = true; ev.target.textContent = 'Queued...';
  const r = await fetch('/api/admin/rerender', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ episode_id, submission_id }),
  });
  if (r.ok) {
    ev.target.textContent = 'Queued ✓';
    setTimeout(() => load(), 800);
  } else {
    alert('Re-render failed: ' + r.status);
    ev.target.disabled = false; ev.target.textContent = 'Re-render';
  }
}

async function onRerenderAll() {
  if (!confirm('Mark every live episode for re-render? The cron picks them up in batches of 5 every 2 min.')) return;
  const btn = document.getElementById('rerender-all-btn');
  btn.disabled = true; btn.textContent = 'Queuing...';
  const r = await fetch('/api/admin/rerender', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (r.ok) {
    const { episodes_marked } = await r.json();
    btn.textContent = `Queued ${episodes_marked} ✓`;
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Re-render catalog'; load(); }, 1500);
  } else {
    alert('Re-render failed: ' + r.status);
    btn.disabled = false; btn.textContent = 'Re-render catalog';
  }
}

async function onUnpublish(ev) {
  const card = ev.target.closest('.sub');
  const episode_id = card.dataset.episodeId;
  if (!episode_id) { alert('No episode id on this card.'); return; }
  if (!confirm('Take this episode off the live RSS feed and back to the ready queue?')) return;
  ev.target.disabled = true; ev.target.textContent = 'Unpublishing...';
  const r = await fetch('/api/admin/unpublish', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ episode_id }),
  });
  if (r.ok) { load(); } else { alert('Unpublish failed: ' + r.status + '\n' + (await r.text()).slice(0, 200)); ev.target.disabled = false; ev.target.textContent = 'Unpublish (back to queue)'; }
}

FILTERS.forEach(b => b.addEventListener('click', () => {
  FILTERS.forEach(f => f.classList.remove('active'));
  b.classList.add('active');
  currentStatus = b.dataset.status;
  load();
}));
document.getElementById('rerender-all-btn')?.addEventListener('click', onRerenderAll);
