// Read episodes from our own /feed.xml — same source of truth Apple
// and Spotify see. Same-origin so no CORS proxy is needed and we
// don't depend on third-party services to display our show.
//
// Extracted from an inline <script> block so the strict CSP on /
// (script-src 'self' …) doesn't have to allow 'unsafe-inline'.

function esc(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseDuration(s) {
  // Accepts "M:SS" or "H:MM:SS"
  if (!s) return 0;
  const parts = s.split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseInt(s, 10) || 0;
}

async function fetchEpisodes() {
  const el = document.getElementById('episode-list');
  if (!el) return;
  try {
    const res = await fetch('/feed.xml', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const items = [...doc.querySelectorAll('item')];
    if (!items.length) {
      el.innerHTML = '<div class="loading" style="animation:none">No episodes yet. Call <strong>1-904-915-HACK</strong> or hit <a href="/call" style="color:var(--green)">/call</a> to leave the first.</div>';
      return;
    }
    el.innerHTML = items.map(it => {
      const title = it.querySelector('title')?.textContent || '';
      const desc  = it.querySelector('description')?.textContent || '';
      const enc   = it.querySelector('enclosure');
      const audio = enc?.getAttribute('url') || '';
      const pub   = it.querySelector('pubDate')?.textContent;
      const dur   = parseDuration(it.getElementsByTagNameNS('http://www.itunes.com/dtds/podcast-1.0.dtd', 'duration')[0]?.textContent);
      const date  = pub ? new Date(pub).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const mins  = dur ? Math.max(1, Math.round(dur / 60)) : 0;
      const epNum = it.getElementsByTagNameNS('http://www.itunes.com/dtds/podcast-1.0.dtd', 'episode')[0]?.textContent;
      return `
        <article class="episode">
          <div class="ep-date">${esc(date)}${epNum ? ` &middot; #${esc(epNum)}` : ''}</div>
          <div class="ep-title">${esc(title)}</div>
          <div class="ep-desc">${esc(desc.slice(0, 240))}</div>
          <div class="ep-meta">
            ${mins ? `<span>${mins} min</span>` : ''}
            <span>EPISODE</span>
          </div>
          ${audio ? `<audio controls preload="none" src="${esc(audio)}" style="width:100%;margin-top:0.75rem"></audio>` : ''}
        </article>
      `;
    }).join('');
  } catch (e) {
    console.error('feed fetch failed:', e);
    el.innerHTML = `
      <div class="loading" style="animation:none">
        Couldn't load episodes from the feed.<br>
        <a href="/feed.xml" style="color:var(--green);margin-top:0.5rem;display:inline-block">Open the raw RSS →</a>
        &nbsp;&middot;&nbsp;
        <a href="https://podcasts.apple.com/us/podcast/hackers-irl/id1780233906" style="color:var(--green);">Apple Podcasts</a>
      </div>`;
  }
}

fetchEpisodes();
