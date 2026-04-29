// Public RSS feed — the canonical source of truth for the show.
// Apple Podcasts, Spotify, Overcast, Pocket Casts all consume this.
// Submit hackersirl.com/feed.xml once on each platform and every
// future episode auto-distributes.
//
// Spec: Apple Podcasts requires <itunes:*> tags + enclosure + RFC822
// pubDate. Spotify accepts the same. The Podcast 2.0 namespace adds
// <podcast:transcript> and <podcast:guid> which we emit too.

import { sbSelect } from './_lib/supabase.js';
import { xe } from './_lib/twiml.js';

const SITE_URL = 'https://hackersirl.com';
const FEED_URL = 'https://hackersirl.com/feed.xml';
const COVER_URL = 'https://is1-ssl.mzstatic.com/image/thumb/PodcastSource211/v4/1d/89/e8/1d89e8e0-c270-d70a-eccc-6e02ee0440ea/23a0af38-740f-441d-806f-de56ea136a56.png/1400x1400bf-60.jpg';
// Stable show GUID — never change once subscribed by Apple/Spotify.
const SHOW_GUID = '8e0c7afe-3c2e-5b4b-9f2e-hackersirl-podcast';

function rfc822(d) {
  return new Date(d).toUTCString();
}

function durationFmt(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export async function onRequest({ env }) {
  const eps = await sbSelect(env, 'hir_episodes', {
    select: '*',
    order: 'published_at.desc',
    limit: '500',
  });

  const items = eps.map(ep => `
    <item>
      <title>${xe(ep.title)}</title>
      <description><![CDATA[${ep.description || ''}]]></description>
      <itunes:summary><![CDATA[${ep.description || ''}]]></itunes:summary>
      <pubDate>${rfc822(ep.published_at)}</pubDate>
      <enclosure url="${xe(ep.audio_url)}" length="${ep.audio_size_bytes || 0}" type="${xe(ep.audio_mime_type || 'audio/mpeg')}"/>
      <guid isPermaLink="false">${xe(ep.guid)}</guid>
      <itunes:duration>${durationFmt(ep.audio_duration_seconds)}</itunes:duration>
      <itunes:explicit>${ep.is_explicit ? 'true' : 'false'}</itunes:explicit>
      ${ep.episode_number ? `<itunes:episode>${ep.episode_number}</itunes:episode>` : ''}
      ${ep.season ? `<itunes:season>${ep.season}</itunes:season>` : ''}
      <itunes:episodeType>full</itunes:episodeType>
      ${ep.cover_art_url ? `<itunes:image href="${xe(ep.cover_art_url)}"/>` : ''}
      <podcast:guid>${xe(ep.guid)}</podcast:guid>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
    <title>Hackers IRL</title>
    <link>${SITE_URL}</link>
    <description>A podcast about the people behind the screens. Voicemails from hackers about whatever's on their mind that day.</description>
    <language>en-us</language>
    <itunes:author>Hackers IRL</itunes:author>
    <itunes:summary>A podcast about the people behind the screens. Voicemails from hackers about whatever's on their mind that day.</itunes:summary>
    <itunes:owner>
      <itunes:name>Hackers IRL</itunes:name>
      <itunes:email>${xe(env.PODCAST_OWNER_EMAIL || 'hello@hackersirl.com')}</itunes:email>
    </itunes:owner>
    <itunes:image href="${COVER_URL}"/>
    <itunes:category text="Technology"/>
    <itunes:category text="Society &amp; Culture">
      <itunes:category text="Documentary"/>
    </itunes:category>
    <itunes:explicit>true</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <copyright>&#169; Hackers IRL</copyright>
    <podcast:guid>${SHOW_GUID}</podcast:guid>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
