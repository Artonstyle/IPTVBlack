/* global require, process, Buffer, fetch */
// filmpalast.to nutzt wechselnde Cloudflare-Zertifikate – in manchen Umgebungen
// schlägt die TLS-Verifikation beim serverseitigen Abruf fehl. Für den Scraper
// erlauben wir daher unsichere TLS-Verbindungen zum Ziel.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// filmpalast.to Resolver – HTTP-Server im Stil des AniWorld-Resolvers.
// Endpunkte: /health, /catalog, /item?id=..., /importMeta?url=..., /resolve?streamUrl=...
//
// Starten:  node filmpalast-resolver.server.js   (PORT über process.env.PORT)
// Hinweis:  Serverseitig ausgeführt (kein CORS). Die Hoster-Auflösung
//           (VOE, Streamtape, Doodstream, generic) stammt vom AniWorld-Vorbild.

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = "https://filmpalast.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
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

// ---------------------------------------------------------------------------
// Katalog (Startseite: neueste Filme aus dem Slider)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Katalog-Parser (mehrere HTML-Strukturen)
// ---------------------------------------------------------------------------
function extractSlugFromStreamUrl(url) {
  const m = String(url || "").match(/\/stream\/([^?#]+)/i);
  return m ? m[1] : "";
}

// Liest ein Poster/Bild aus src, data-src, data-original, data-lazy-src, poster.
function findCoverInChunk(chunk) {
  const m = String(chunk || "").match(
    /(?:src|data-src|data-original|data-lazy-src|poster)\s*=\s*"([^"]+\.(?:jpe?g|png|webp|gif)[^"]*)"/i
  );
  return m ? normalizeUrl(m[1]) : "";
}

// Titelerkennung aus Überschrift, span.title, img alt, title-Attribut oder Linktext.
function findTitleInChunk(chunk, fallback) {
  let t = (String(chunk || "").match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1];
  if (t) return stripTags(t);
  t = (String(chunk || "").match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  if (t) return stripTags(t);
  t = (String(chunk || "").match(/<img[^>]*\balt="([^"]+)"/i) || [])[1];
  if (t && t.trim().length > 1) return stripTags(t);
  t = (String(chunk || "").match(/\btitle="([^"]+)"/i) || [])[1];
  if (t && t.trim().length > 1) return stripTags(t);
  return stripTags(fallback || "");
}

// Erkennt Block-/Fehler-/Leerseiten, die keinen echten Katalog enthalten.
function detectBlockedOrNonCatalogPage(text) {
  const t = String(text || "");
  if (!t.trim()) return "Leere Antwort";
  if (t.length < 500) return "Antwort zu kurz für eine Katalogseite";
  // HTML-Entities dekodieren, damit "verf&uuml;gbar" -> "verfügbar" erkannt wird.
  const decoded = t
    .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü").replace(/&szlig;/g, "ß")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const lower = decoded.toLowerCase();
  const markers = [
    "just a moment",
    "cf-browser-verification",
    "cf-challenge",
    "captcha",
    "access denied",
    "attention required",
    "checking your browser before accessing",
    "enable javascript and cookies to continue",
    "ddos protection",
    "webseite nicht verfügbar",
    "seite nicht verfügbar",
    "seite kann nicht angezeigt werden",
    "leider nicht verfügbar",
    "404 not found",
    "404 - nicht gefunden",
    "internal server error",
    "service unavailable"
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
  const tested = ["slider-li", "generic /stream/ links", "container (article/div/li)"];

  const add = (item) => {
    const key = String(item.slug || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  // --- Strategie 1: slider-li Blöcke (aktuelle Live-Struktur) ---
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

    const title =
      stripTags((block.match(/<span class="title rb">([\s\S]*?)<\/span>/i) || [])[1] || "") || slug;
    const coverMatch = block.match(
      /<img[^>]*src="((?:https?:\/\/filmpalast\.to)?\/files\/movies\/[^"]+)"/i
    );
    const cover = coverMatch ? normalizeUrl(coverMatch[1]) : findCoverInChunk(block);
    const yearMatch = block.match(/class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})<\/b>/i);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const descMatch = block.match(
      /<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i
    );
    const description = descMatch ? decodeBasicEntities(descMatch[1]) : "";

    add({
      title,
      slug,
      url: url || `${BASE_URL}/stream/${slug}`,
      cover,
      year,
      description
    });
  }
  if (out.length) return out;

  // --- Strategie 2: generische Detail-Link-Suche (alle /stream/<slug> Links) ---
  const linkRe = /<a\b[^>]*href="([^"]*filmpalast\.to\/stream\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRe.exec(source)) && out.length < 200) {
    const url = normalizeUrl(lm[1]);
    const slug = extractSlugFromStreamUrl(url);
    if (!slug) continue;
    const inner = lm[2];
    const cover = findCoverInChunk(inner);
    const title = findTitleInChunk(inner, stripTags(inner)) || slug;
    add({ title, slug, url, cover, year: null, description: "" });
  }
  if (out.length) return out;

  // --- Strategie 3: container-basiert (article / div.movie / div.item / card / poster) ---
  const containerRe = /<(?:article|div|li)[^>]*class="[^"]*(?:movie|item|card|poster)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|li)>/gi;
  let cm;
  while ((cm = containerRe.exec(source)) && out.length < 200) {
    const block = cm[1];
    const linkMatch = block.match(/href="([^"]*filmpalast\.to\/stream\/[^"#?]+)"/i);
    if (!linkMatch) continue;
    const url = normalizeUrl(linkMatch[1]);
    const slug = extractSlugFromStreamUrl(url);
    if (!slug) continue;
    const cover = findCoverInChunk(block);
    const title = findTitleInChunk(block, slug) || slug;
    add({ title, slug, url, cover, year: null, description: "" });
  }

  if (!out.length) {
    console.warn("[filmpalast-catalog] 0 Treffer. Getestete Muster:", tested.join(", "));
  }
  return out;
}

function catalogItemFromParsed(m) {
  return {
    id: m.slug,
    title: m.title,
    type: "movie",
    category: "Film",
    year: m.year ? String(m.year) : "",
    poster: m.cover || "",
    description: m.description || ""
  };
}

async function fetchMovieCatalog() {
  const { response, text } = await fetchText(BASE_URL + "/", { referer: BASE_URL + "/" });
  const status = response && response.status ? response.status : 0;
  const htmlLen = String(text || "").length;
  console.log(`[filmpalast-catalog] HTTP ${status} | ${htmlLen} Bytes HTML`);

  const blockReason = detectBlockedOrNonCatalogPage(text);
  if (blockReason) {
    console.warn("[filmpalast-catalog] Kein Katalog geladen:", blockReason);
    return {
      ok: false,
      error: "Source page is blocked or not a catalog page",
      reason: blockReason,
      debug: { status, htmlLen, snippet: String(text || "").slice(0, 300) }
    };
  }

  const parsed = parseFilmpalastCatalogFromHtml(text);
  const items = parsed.map(catalogItemFromParsed);
  if (!items.length) {
    const hasStreamLinks = /\/stream\/[a-z0-9-]/i.test(text || "");
    console.warn(
      `[filmpalast-catalog] 0 Treffer trotz ${htmlLen} Bytes. Stream-Links vorhanden? ${hasStreamLinks}`
    );
    return {
      ok: false,
      error: "No catalog items parsed",
      debug: {
        status,
        htmlLen,
        hasStreamLinks,
        snippet: String(text || "").slice(0, 500)
      }
    };
  }
  return { ok: true, count: items.length, items };
}

// ---------------------------------------------------------------------------
// Stream-Seite: Details + Hoster
// ---------------------------------------------------------------------------
function parseStreamPageDetails(html, finalUrl) {
  const source = String(html || "");
  const slug = finalUrl ? (finalUrl.match(/\/stream\/([^?#]+)/) || [])[1] || "" : "";

  let title = stripTags((source.match(/<span class="title rb">([\s\S]*?)<\/span>/i) || [])[1] || "");
  if (!title) title = stripTags((source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  if (!title) {
    const t = (source.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    title = stripTags(t).replace(/\s*[-|]\s*Filmpalast.*$/i, "").replace(/\s*Stream.*$/i, "").trim();
  }
  title = title || slug;

  const descMatch = source.match(
    /<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i
  );
  const description = descMatch ? decodeBasicEntities(descMatch[1]) : "";

  const ogImg = source.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const coverMatch = source.match(/<img[^>]*src="((?:https?:\/\/filmpalast\.to)?\/files\/movies\/[^"]+)"/i);
  const poster = ogImg ? ogImg[1] : coverMatch ? normalizeUrl(coverMatch[1]) : "";

  const yearMatch = source.match(/class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})<\/b>/i);
  const year = yearMatch ? yearMatch[1] : "";

  const hosters = parseFilmpalastHostersFromHtml(source);

  return {
    id: slug,
    slug,
    title,
    type: "movie",
    category: "Film",
    year,
    poster,
    description,
    hosters,
    url: finalUrl
  };
}

async function fetchItemById(id) {
  if (!id) return { ok: false, error: "id missing" };
  const streamUrl = /^https?:\/\//i.test(id) ? id : `${BASE_URL}/stream/${id}`;
  const { text, response } = await fetchText(streamUrl, { referer: BASE_URL + "/" });
  const finalUrl = response.url || streamUrl;
  const d = parseStreamPageDetails(text, finalUrl);
  const item = {
    id: d.id,
    title: d.title,
    type: "movie",
    category: d.category,
    year: d.year,
    poster: d.poster,
    description: d.description,
    seasons: [
      {
        key: "s1",
        label: "Film",
        number: 1,
        episodes: [{ id: "e1", title: d.title, episode_num: 1, url: finalUrl }]
      }
    ]
  };
  return { ok: true, item, hosters: d.hosters };
}

// ---------------------------------------------------------------------------
// Hoster einer Stream-Seite
// ---------------------------------------------------------------------------
function parseFilmpalastHostersFromHtml(html) {
  const out = [];
  const seen = new Set();
  // HTML-Kommentare entfernen, damit auskomkommentierte <a>-Links nicht erfasst werden.
  const source = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const blockRe = /<ul class="currentStreamLinks">([\s\S]*?)<\/ul>/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(source))) {
    const block = blockMatch[1];

    const nameMatch = block.match(/<p class="hostName">([\s\S]*?)<\/p>/i);
    const name = nameMatch ? stripTags(nameMatch[1]).replace(/\s+(HD|SD|4K)$/i, "") : "";

    // data-player-url (Firestream/verystream) oder href (direkte Hoster-Links)
    const dpMatch = block.match(/data-player-url="([^"]+)"/i);
    const aMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/i);
    const raw = dpMatch ? dpMatch[1] : aMatch ? aMatch[1] : "";
    if (!raw) continue;
    const url = normalizeUrl(raw);
    if (!url) continue;

    const key = `${url}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hoster-Auflösung (aus dem AniWorld-Vorbild)
// ---------------------------------------------------------------------------
function pickBestUrl(urls) {
  const items = (urls || [])
    .map((u) => String(u || "").replace(/\\\//g, "/").trim())
    .filter(Boolean);
  if (!items.length) return "";
  items.sort((a, b) => scoreUrl(b) - scoreUrl(a));
  return items[0];
}

function scoreUrl(url) {
  const m = String(url).match(/(\d{3,4})p?/i);
  return m ? Number(m[1]) : 360;
}

// VOE leitet per JS auf eine rotierende Domain weiter – dieser Redirect wird
// hier verfolgt, bevor die eigentliche Quellen-Suche startet.
async function followJsRedirect(text, baseUrl) {
  const m = text.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
  if (m && m[1] && !/^https?:\/\//i.test(m[1]) === false) {
    try {
      return new URL(m[1], baseUrl).toString();
    } catch {
      return baseUrl;
    }
  }
  return baseUrl;
}

async function resolveVoe(url) {
  let current = url;
  let { text } = await fetchText(current, { referer: "https://filmpalast.to/" });
  const next = await followJsRedirect(text, current);
  if (next && next !== current) {
    current = next;
    ({ text } = await fetchText(current, { referer: url }));
  }

  let m = text.match(/"src"\s*:\s*"(https?:[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
  if (m) return m[1].replace(/\\\//g, "/");

  m = text.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)/i);
  if (m) {
    const scriptUrl = new URL(m[2], current).toString();
    const { text: helperJs } = await fetchText(scriptUrl, { referer: current });
    const repl = helperJs.match(/(\[(?:'\W{2}'[,\]]){1,9})/);
    if (repl) {
      const decoded = voeDecode(m[1], repl[1]);
      const sources = [];
      ["file", "source", "direct_access_url"].forEach((key) => {
        if (decoded[key]) sources.push(decoded[key]);
      });
      const best = pickBestUrl(sources);
      if (best) return best;
    }
  }

  const mediaMatches = text.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/gi) || [];
  return pickBestUrl(mediaMatches);
}

function voeDecode(cipherText, lutText) {
  const lut = lutText
    .slice(2, -2)
    .split("','")
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let text = "";
  for (const ch of cipherText) {
    let code = ch.charCodeAt(0);
    if (code > 64 && code < 91) code = ((code - 52) % 26) + 65;
    else if (code > 96 && code < 123) code = ((code - 84) % 26) + 97;
    text += String.fromCharCode(code);
  }
  for (const item of lut) {
    text = text.replace(new RegExp(item, "g"), "");
  }
  const step1 = Buffer.from(text, "base64").toString("utf8");
  const step2 = step1
    .split("")
    .map((ch) => String.fromCharCode(ch.charCodeAt(0) - 3))
    .join("");
  const step3 = Buffer.from(step2.split("").reverse().join(""), "base64").toString("utf8");
  return JSON.parse(step3);
}

async function resolveDoodstream(url) {
  const initial = await fetchText(url, { referer: "https://filmpalast.to/" });
  let finalUrl = initial.response.url || url;
  let html = initial.text;

  const iframeMatch = html.match(/<iframe\s*src="([^"]+)/i);
  if (iframeMatch) {
    finalUrl = new URL(iframeMatch[1], finalUrl).toString();
    const embedded = await fetchText(finalUrl, { referer: finalUrl });
    html = embedded.text;
  } else {
    const altUrl = finalUrl.replace("/d/", "/e/");
    const embedded = await fetchText(altUrl, { referer: finalUrl });
    html = embedded.text;
    finalUrl = altUrl;
  }

  const match = html.match(
    /dsplayer\.hotkeys[^']+'([^']+).+?function\s*makePlay.+?return[^?]+([^"]+)/is
  );
  if (!match) return await resolveGeneric(finalUrl, html);

  const token = match[2];
  const passUrl = new URL(match[1], finalUrl).toString();
  const { text: passResult } = await fetchText(passUrl, { referer: finalUrl });
  if (passResult.includes("cloudflarestorage.")) return passResult.trim();
  return doodDecode(passResult) + token + String(Date.now());
}

function doodDecode(data) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 10; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return String(data || "") + suffix;
}

async function resolveStreamtape(url) {
  const { text } = await fetchText(url, { referer: url });
  const direct = text.match(
    /(https?:\/\/[a-z0-9.-]*streamtape[a-z.]*\/get_video[^"'\s]+)/i
  );
  if (direct) return direct[1];
  return await resolveGeneric(url, text);
}

async function resolveGeneric(url, existingHtml = "") {
  const text = existingHtml || (await fetchText(url, { referer: url })).text;
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi) || [];
  const best = pickBestUrl(matches);
  if (best) return best;
  const iframe = text.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
  if (iframe) {
    return await resolveGeneric(iframe[1]);
  }
  return "";
}

async function resolveHosterUrl(hosterUrl) {
  const url = normalizeUrl(hosterUrl);
  if (!url) return "";
  // VOE und seine vielen Spiegel-Domains
  if (/voe|voeun|vidaraa|vidsonic|vixeo|filelion|lula|tracy|playmate/i.test(url)) {
    return await resolveVoe(url);
  }
  if (/dood|playmogo|myvidplay/i.test(url)) return await resolveDoodstream(url);
  if (/streamtape|stape/i.test(url)) return await resolveStreamtape(url);
  return await resolveGeneric(url);
}

// ---------------------------------------------------------------------------
// /resolve
// ---------------------------------------------------------------------------
async function resolveMovie(streamUrl) {
  let cleanUrl = normalizeUrl(streamUrl);
  if (!cleanUrl) return { ok: false, error: "streamUrl missing" };

  // "/stream/evil-dead-burn" oder "evil-dead-burn" → vollständige URL
  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = `${BASE_URL}/stream/${cleanUrl}`;
  }

  const { text: pageHtml, response } = await fetchText(cleanUrl, { referer: BASE_URL + "/" });
  const finalPageUrl = response.url || cleanUrl;

  const hosters = parseFilmpalastHostersFromHtml(pageHtml);
  if (!hosters.length) {
    return { ok: false, error: "No hosters found", streamUrl: finalPageUrl };
  }

  for (const hoster of hosters) {
    try {
      const playableUrl = await resolveHosterUrl(hoster.url);
      if (playableUrl) {
        return {
          ok: true,
          streamUrl: finalPageUrl,
          hoster: hoster.name,
          hosterUrl: hoster.url,
          playableUrl
        };
      }
    } catch (error) {
      hoster.error = String(error && error.message ? error.message : error);
    }
  }

  return { ok: false, error: "No playable stream found", streamUrl: finalPageUrl, hosters };
}

function errorToObject(error) {
  if (!error) return { message: "unknown error" };
  const cause = error.cause || null;
  return {
    message: String(error.message || error),
    stack: error.stack || "",
    cause: cause
      ? {
          message: String(cause.message || cause),
          stack: cause.stack || "",
          code: cause.code || "",
          errno: cause.errno || "",
          syscall: cause.syscall || ""
        }
      : null
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
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
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, port: PORT });
    return;
  }

  if (url.pathname === "/catalog") {
    try {
      const result = await fetchMovieCatalog();
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.message ? error.message : error),
        details: errorToObject(error)
      });
    }
    return;
  }

  if (url.pathname === "/item") {
    try {
      const result = await fetchItemById(url.searchParams.get("id"));
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.message ? error.message : error),
        details: errorToObject(error)
      });
    }
    return;
  }

  if (url.pathname === "/importMeta") {
    try {
      const result = await fetchItemById(url.searchParams.get("url"));
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.message ? error.message : error),
        details: errorToObject(error)
      });
    }
    return;
  }

  if (url.pathname === "/resolve") {
    try {
      const result = await resolveMovie(url.searchParams.get("streamUrl"));
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.message ? error.message : error),
        details: errorToObject(error)
      });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Filmpalast resolver listening on http://0.0.0.0:${PORT}`);
});