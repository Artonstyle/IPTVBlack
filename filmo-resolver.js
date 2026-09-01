/* global require, process, Buffer, fetch */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const BASE_URL = "https://filmpalast.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function normalizeUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/^\/\//.test(u)) return "https:" + u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return BASE_URL + u;
  return u;
}

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\u200b/g, "")
    .trim();
}

function stripTags(value) {
  return decodeBasicEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, opts = {}) {
  try {
    const response = await fetch(url, {
      redirect: opts.redirect || "follow",
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        referer: opts.referer || BASE_URL + "/"
      }
    });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    const err = new Error(
      `fetch failed for ${url}: ${String(error && error.message ? error.message : error)}`
    );
    err.cause = error;
    throw err;
  }
}

function extractSlugFromStreamUrl(url) {
  const m = String(url || "").match(/\/stream\/([^?#]+)/i);
  return m ? m[1] : "";
}

function findCoverInChunk(chunk) {
  const m = String(chunk || "").match(
    /(?:src|data-src|data-original|data-lazy-src|poster)\s*=\s*"([^"]+\.(?:jpe?g|png|webp|gif)[^"]*)"/i
  );
  return m ? normalizeUrl(m[1]) : "";
}

function detectBlockedOrNonCatalogPage(text) {
  const t = String(text || "");
  if (!t.trim()) return "Leere Antwort";
  if (t.length < 500) return "Antwort zu kurz für eine Katalogseite";
  const decoded = t
    .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü").replace(/&szlig;/g, "ß")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const lower = decoded.toLowerCase();
  const markers = [
    "just a moment", "cf-browser-verification", "cf-challenge", "captcha",
    "access denied", "attention required", "checking your browser before accessing",
    "enable javascript and cookies to continue", "ddos protection",
    "webseite nicht verfügbar", "seite nicht verfügbar", "404 not found"
  ];
  for (const mk of markers) {
    if (lower.includes(mk)) return `Blockseite/Fehler erkannt: "${mk}"`;
  }
  return null;
}

function parseFilmpalastCatalogFromHtml(html) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const sliderRe = /<li[^>]*class="[^"]*slider-li[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let sm;
  while ((sm = sliderRe.exec(source)) && out.length < 200) {
    const block = sm[1];
    const linkMatch =
      block.match(/href="((?:https?:)?\/\/filmpalast\.to\/stream\/[^"#?]+)"[^>]*class="[^"]*moviSliderPlay"/i) ||
      block.match(/href="((?:https?:)?\/\/filmpalast\.to\/stream\/[^"#?]+)"/i);
    const url = normalizeUrl(linkMatch ? linkMatch[1] : "");
    const slug = extractSlugFromStreamUrl(url);
    if (!slug) continue;

    const title = stripTags((block.match(/<span class="title rb">([\s\S]*?)<\/span>/i) || [])[1] || "") || slug;
    const coverMatch = block.match(/<img[^>]*src="((?:https?:\/\/filmpalast\.to)?\/files\/movies\/[^"]+)"/i);
    const cover = coverMatch ? normalizeUrl(coverMatch[1]) : findCoverInChunk(block);
    const yearMatch = block.match(/class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})<\/b>/i);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const descMatch = block.match(/<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i);
    const description = descMatch ? decodeBasicEntities(descMatch[1]) : "";

    const item = { title, slug, url: url || `${BASE_URL}/stream/${slug}`, cover, year, description };
    if (!seen.has(slug)) { seen.add(slug); out.push(item); }
  }
  return out;
}

function posterFromSlug(slug) {
  return `${BASE_URL}/files/movies/240/${encodeURIComponent(slug)}.jpg`;
}

function buildCatalogUrl(params) {
  const type = String(params.type || "movie").toLowerCase();
  const source = String(params.source || "new").toLowerCase();
  const page = Math.max(parseInt(params.page, 10) || 1, 1);
  const letter = encodeURIComponent(String(params.letter || "A"));
  const genre = encodeURIComponent(String(params.genre || ""));
  const query = encodeURIComponent(String(params.query || ""));
  const paged = page > 1 ? `/page/${page}` : "";

  if (type === "series") return `${BASE_URL}/search/serien/alpha/${letter}`;
  if (source === "top") return `${BASE_URL}/movies/top${paged}`;
  if (source === "alpha") return `${BASE_URL}/search/alpha/${letter}`;
  if (source === "genre") return `${BASE_URL}/search/genre/${genre}`;
  if (source === "search") return `${BASE_URL}/search?search=${query}`;
  return `${BASE_URL}/movies/new${paged}`;
}

async function fetchCatalog(params) {
  const targetUrl = buildCatalogUrl(params);
  const { response, text } = await fetchText(targetUrl, { referer: BASE_URL + "/" });
  const blockReason = detectBlockedOrNonCatalogPage(text);
  if (blockReason) {
    return { ok: false, error: "Quelle blockiert", reason: blockReason };
  }
  const items = parseFilmpalastCatalogFromHtml(text).map((m) => ({
    id: m.slug, slug: m.slug, title: m.title, type: "movie", category: "Film",
    year: m.year ? String(m.year) : "", poster: m.cover || posterFromSlug(m.slug),
    description: m.description || "", url: m.url
  }));
  return { ok: true, count: items.length, page: parseInt(params.page, 10) || 1, items };
}

function parseFilmpalastHostersFromHtml(html) {
  const out = [];
  const source = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const blockRe = /<ul class="currentStreamLinks">([\s\S]*?)<\/ul>/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(source))) {
    const block = blockMatch[1];
    const nameMatch = block.match(/<p class="hostName">([\s\S]*?)<\/p>/i);
    const name = nameMatch ? stripTags(nameMatch[1]).replace(/\s+(HD|SD|4K)$/i, "") : "";
    const dpMatch = block.match(/data-player-url="([^"]+)"/i);
    const aMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/i);
    const raw = dpMatch ? dpMatch[1] : aMatch ? aMatch[1] : "";
    if (raw) out.push({ name, url: normalizeUrl(raw) });
  }
  return out;
}

function parseStreamPageDetails(html, finalUrl) {
  const source = String(html || "");
  const slug = finalUrl ? (finalUrl.match(/\/stream\/([^?#]+)/) || [])[1] || "" : "";
  let title = stripTags((source.match(/<span class="title rb">([\s\S]*?)<\/span>/i) || [])[1] || "") || slug;
  const descMatch = source.match(/<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i);
  const description = descMatch ? decodeBasicEntities(descMatch[1]) : "";
  const ogImg = source.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const poster = ogImg ? ogImg[1] : "";
  const hosters = parseFilmpalastHostersFromHtml(source);
  return { id: slug, slug, title, type: "movie", category: "Film", poster, description, hosters, url: finalUrl };
}

async function fetchItemById(id) {
  if (!id) return { ok: false, error: "id missing" };
  const streamUrl = /^https?:\/\//i.test(id) ? id : `${BASE_URL}/stream/${id}`;
  const { text, response } = await fetchText(streamUrl, { referer: BASE_URL + "/" });
  const d = parseStreamPageDetails(text, response.url || streamUrl);
  return { ok: true, item: d, hosters: d.hosters };
}

async function resolveVoe(url) {
  const { text } = await fetchText(url);
  let match = text.match(/'hls':\s*'([^']+)'/i) || text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  if (match) return match[1] || match[0];
  const b64Match = text.match(/prompt\(['"]([^'"]+)['"]\)/i) || text.match(/window\.location\.href\s*=\s*atob\(['"]([^'"]+)['"]\)/i);
  if (b64Match) {
    try {
      const decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
      if (decoded.startsWith("http")) return await resolveVoe(decoded);
    } catch (e) {}
  }
  return "";
}

async function resolveDoodstream(url) {
  const { text, response } = await fetchText(url);
  const passMatch = text.match(/\/pass_md5\/[^\s"'`<>]+/i);
  if (!passMatch) return "";
  const passUrl = "https://" + new URL(response.url || url).host + passMatch[0];
  const { text: token } = await fetchText(passUrl, { referer: response.url || url });
  const randomChars = Math.random().toString(36).substring(2, 12);
  return `${token}${randomChars}?token=${passMatch[0].split("/").pop()}&expiry=${Date.now()}`;
}

async function resolveGeneric(url) {
  const { text } = await fetchText(url);
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi) || [];
  return matches[0] || "";
}

async function resolveHosterUrl(hosterUrl, sourceName = "") {
  const url = normalizeUrl(hosterUrl);
  if (!url) return "";
  const name = sourceName.toLowerCase();
  
  if (name.includes("voe") || url.includes("voe.sx")) return await resolveVoe(url);
  if (name.includes("dood") || url.includes("dood")) return await resolveDoodstream(url);
  return await resolveGeneric(url);
}

const SUPPORTED_VIDEO_RE = /\.(m3u8|mp4|webm|ogg|mkv|ts)(?:[?#]|$)/i;
function isValidPlayableUrl(u) {
  return SUPPORTED_VIDEO_RE.test(String(u || "")) || /\/(?:get_video|stream)(?:[/?#]|$)/i.test(String(u || ""));
}

async function resolveSingleHoster(hosterUrl, sourceName) {
  const url = normalizeUrl(hosterUrl);
  try {
    const playableUrl = await resolveHosterUrl(url, sourceName);
    if (!isValidPlayableUrl(playableUrl)) {
      return { ok: false, sourceName, error: "Quelle nicht verfügbar", reason: "no direct url" };
    }
    return { ok: true, sourceName, hosterUrl: url, playableUrl };
  } catch (error) {
    return { ok: false, sourceName, error: String(error) };
  }
}

async function resolveMovie(params) {
  const streamUrl = params && params.streamUrl;
  const hosterUrl = params && params.hosterUrl;
  const sourceName = params && params.sourceName || "";

  if (hosterUrl) {
    return await resolveSingleHoster(hosterUrl, sourceName);
  }

  let cleanUrl = normalizeUrl(streamUrl);
  if (!cleanUrl) return { ok: false, error: "streamUrl missing" };
  if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = `${BASE_URL}/stream/${cleanUrl}`;

  const { text: pageHtml, response } = await fetchText(cleanUrl, { referer: BASE_URL + "/" });
  const details = parseStreamPageDetails(pageHtml, response.url || cleanUrl);
  const sources = details.hosters || [];

  for (const source of sources) {
    const result = await resolveSingleHoster(source.url, source.name);
    if (result.ok) return { ok: true, playableUrl: result.playableUrl, sourceName: source.name, sources };
  }
  return { ok: true, needsSelection: true, item: details, sources };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health" || url.pathname === "/" || url.pathname === "/index.html") {
    sendJson(res, 200, { ok: true, service: "filmpalast-resolver", port: PORT });
    return;
  }

  if (url.pathname === "/catalog") {
    const result = await fetchCatalog({
      type: url.searchParams.get("type"),
      source: url.searchParams.get("source"),
      page: url.searchParams.get("page"),
      letter: url.searchParams.get("letter"),
      genre: url.searchParams.get("genre"),
      query: url.searchParams.get("query")
    });
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (url.pathname === "/item" || url.pathname === "/importMeta") {
    const result = await fetchItemById(url.searchParams.get("id") || url.searchParams.get("url"));
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/resolve") {
    const result = await resolveMovie({
      streamUrl: url.searchParams.get("streamUrl"),
      hosterUrl: url.searchParams.get("hosterUrl"),
      sourceName: url.searchParams.get("sourceName")
    });
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Filmpalast resolver listening on http://0.0.0.0:${PORT}`);
});
