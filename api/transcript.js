// Vercel serverless: /api/transcript?v=VIDEO_ID&lang=hi
// Fetches YouTube captions via the watch-page player response, returns clean transcript JSON.
// NOTE: uses only public YouTube pages — no private keys or secrets anywhere.

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
  // Capture cookies — caption requests often need the same session
  const cookies = [];
  const rawSet = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of rawSet) {
    const pair = c.split(';')[0];
    if (pair && pair.includes('=')) cookies.push(pair);
  }
  const cookieHeader = cookies.join('; ');
  const html = await res.text();
  if (html.includes('google.com/sorry')) return null; // bot check
  const player = extractJson(html, 'ytInitialPlayerResponse =') ||
                 extractJson(html, 'var ytInitialPlayerResponse =');
  if (!player) return null;
  const title = player?.videoDetails?.title || '';
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return { title, tracks, cookieHeader };
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
    const info = await getTracksFromWatchPage(videoId);
    stage('watchpage:' + (info ? info.tracks.length + ' tracks' : 'none'));
    if (!info || !info.tracks.length) {
      return res.status(404).json({
        ok: false,
        error: 'Is video me captions/subtitles nahi mile. Kuch videos me subtitles off hote hain.',
        ...(dbg ? { debug: dbg.stages } : {}),
      });
    }

    const { title, tracks, cookieHeader } = info;
    // Prefer: exact lang track > English track > first track
    const track =
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks[0];
    const translated = track.languageCode !== lang;

    const capHeaders = {
      'User-Agent': UA,
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookieHeader) capHeaders['Cookie'] = cookieHeader;

    // Try caption formats in order: raw XML (as-is), then json3, then vtt
    const variants = [
      track.baseUrl,
      track.baseUrl + '&fmt=json3',
      track.baseUrl + '&fmt=vtt',
    ];
    if (translated) {
      variants.unshift(track.baseUrl + `&tlang=${encodeURIComponent(lang)}`);
    }

    let segments = [];
    for (const url of variants) {
      try {
        const capRes = await fetch(url, { headers: capHeaders });
        stage('capfetch:' + capRes.status + ' ' + (capRes.headers.get('content-type') || ''));
        if (!capRes.ok) continue;
        const capText = await capRes.text();
        stage('capbytes:' + capText.length);
        if (!capText || capText.length < 50) continue;
        try { segments = parseJson3(capText); }
        catch { segments = parseXml(capText); }
        stage('segments:' + segments.length);
        if (segments.length) break;
      } catch { /* try next variant */ }
    }

    if (!segments.length) {
      return res.status(404).json({
        ok: false,
        error: 'Transcript nahi nikal paya. Kuch videos ke captions block hote hain.',
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
