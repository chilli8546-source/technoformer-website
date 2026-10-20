// Vercel serverless: /api/transcript?v=VIDEO_ID&lang=hi
// Tries multiple methods to fetch YouTube captions, returns clean transcript JSON.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Extract balanced JSON after a marker (for ytInitialPlayerResponse)
function extractJson(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  const jsonStart = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
  }
  try { return JSON.parse(html.slice(jsonStart, i + 1)); }
  catch { return null; }
}

async function getTracksFromWatchPage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&app=desktop`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (html.includes('google.com/sorry')) return null; // bot check
  const player = extractJson(html, 'ytInitialPlayerResponse =') ||
                 extractJson(html, 'var ytInitialPlayerResponse =');
  if (!player) return null;
  const title = player?.videoDetails?.title || '';
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return { title, tracks };
}

async function getTracksFromInnertube(videoId) {
  const clients = [
    { clientName: 'WEB', clientVersion: '2.20241010.01.00' },
    { clientName: 'TVHTML5', clientVersion: '7.20241009.18.00' },
  ];
  for (const client of clients) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(
        'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({
            videoId,
            context: { client: { ...client, hl: 'en', gl: 'US' } },
          }),
          signal: ctrl.signal,
        }
      );
      clearTimeout(to);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.playabilityStatus?.status === 'LOGIN_REQUIRED') continue;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const title = data?.videoDetails?.title || '';
      if (tracks.length) return { title, tracks };
    } catch { /* try next */ }
  }
  return null;
}

function parseJson3(json3text) {
  const data = JSON.parse(json3text);
  const segs = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = decodeEntities(ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim());
    if (!text) continue;
    segs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
  }
  return segs;
}

function parseXml(xml) {
  const segs = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    segs.push({ start: parseFloat(m[1]), dur: parseFloat(m[2]), text: decodeEntities(m[3].replace(/\n/g, ' ').trim()) });
  }
  return segs;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const { v: videoId, lang = 'en', debug } = req.query || {};
  const dbg = debug === '1' ? { stages: [] } : null;
  const stage = (s) => { if (dbg) dbg.stages.push(s); };
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).json({ ok: false, error: 'Sahi YouTube video ID do.' });
  }

  try {
    let info = await getTracksFromWatchPage(videoId);
    stage('watchpage:' + (info ? info.tracks.length + ' tracks' : 'none'));
    if (!info) {
      info = await getTracksFromInnertube(videoId);
      stage('innertube:' + (info ? info.tracks.length + ' tracks' : 'none'));
    }
    if (!info || !info.tracks.length) {
      return res.status(404).json({
        ok: false,
        error: 'Is video me captions/subtitles nahi mile. Kuch videos me subtitles off hote hain.',
        ...(dbg ? { debug: dbg.stages } : {}),
      });
    }

    const { title, tracks } = info;
    // Prefer: exact lang track > English track > first track
    let track =
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks[0];
    let url = track.baseUrl + '&fmt=json3';
    const translated = track.languageCode !== lang;
    if (translated) url += `&tlang=${encodeURIComponent(lang)}`;

    const capRes = await fetch(url, { headers: { 'User-Agent': UA } });
    stage('capfetch:' + capRes.status + ' ' + (capRes.headers.get('content-type') || ''));
    if (!capRes.ok) throw new Error('caption fetch failed');
    const capText = await capRes.text();
    stage('capbytes:' + capText.length);
    let segments = [];
    try { segments = parseJson3(capText); }
    catch {
      // fallback: try XML
      const xmlRes = await fetch(url.replace('&fmt=json3', ''), { headers: { 'User-Agent': UA } });
      const xml = await xmlRes.text();
      segments = parseXml(xml);
    }
    stage('segments:' + segments.length);

    if (!segments.length) {
      return res.status(404).json({
        ok: false,
        error: 'Transcript khaali mila. Dobara try karo.',
        ...(dbg ? { debug: dbg.stages } : {}),
      });
    }

    return res.status(200).json({
      ok: true,
      videoId,
      title,
      lang,
      translated,
      sourceLang: track.languageCode,
      segments,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Kuch gadbad ho gayi. Thodi der baad try karo.' });
  }
}
