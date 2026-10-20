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
  // Also extract the transcript-panel params from ytInitialData (for the panel API)
  const initialData = extractJson(html, 'var ytInitialData =') || extractJson(html, 'ytInitialData =');
  let transcriptParams = null;
  const findParams = (node) => {
    if (!node || typeof node !== 'object' || transcriptParams) return;
    if (node.getTranscriptEndpoint && typeof node.getTranscriptEndpoint.params === 'string') {
      transcriptParams = node.getTranscriptEndpoint.params;
      return;
    }
    for (const k of Object.keys(node)) findParams(node[k]);
  };
  if (initialData) findParams(initialData);
  return { title, tracks, cookieHeader, transcriptParams };
}

// Transcript via YouTube's own transcript-panel endpoint.
// The segments come inside the API response, so no IP-locked caption URL is fetched.
// Key is YouTube's public web client key, provided via env var (never in code).
async function getTranscriptViaPanel(params, stage) {
  const key = process.env.YT_PUB_KEY;
  if (!key) { stage('panel:no-key'); return null; }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20241010.01.00', hl: 'en', gl: 'US' } },
        params,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    stage('panel:http-' + res.status);
    if (!res.ok) return null;
    const data = await res.json();
    const renderer =
      data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
        ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer;
    const initial = renderer?.initialSegments || [];
    const segs = [];
    for (const item of initial) {
      const seg = item?.transcriptSegmentRenderer;
      if (!seg) continue;
      const text = (seg.snippet?.runs || []).map((r) => r.text || '').join('').trim();
      if (!text) continue;
      segs.push({
        start: parseInt(seg.startMs || '0', 10) / 1000,
        dur: (parseInt(seg.endMs || '0', 10) - parseInt(seg.startMs || '0', 10)) / 1000,
        text: decodeEntities(text),
      });
    }
    stage('panel:segments-' + segs.length);
    return segs.length ? segs : null;
  } catch (e) {
    stage('panel:fail-' + (e.name === 'AbortError' ? 'timeout' : 'err'));
    return null;
  }
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

    // METHOD 1: transcript-panel endpoint (segments arrive in the API response)
    if (info && info.transcriptParams) {
      const segs = await getTranscriptViaPanel(info.transcriptParams, stage);
      if (segs && segs.length) {
        return res.status(200).json({
          ok: true,
          videoId,
          title: info.title || '',
          lang,
          translated: false,
          sourceLang: 'auto',
          segments: segs,
        });
      }
    }

    if (!info || !info.tracks.length) {
      return res.status(404).json({
        ok: false,
        error: 'Is video me captions/subtitles nahi mile. Kuch videos me subtitles off hote hain.',
        ...(dbg ? { debug: dbg.stages } : {}),
      });
    }

    // METHOD 2: direct caption URL fetch
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
