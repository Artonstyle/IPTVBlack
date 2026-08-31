const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8788);
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
  if (u.startsWith("/")) return "https://aniworld.to" + u;
  return u;
}

async function fetchText(url, opts = {}) {
  try {
    const response = await fetch(url, {
      redirect: opts.redirect || "follow",
      headers: {
        "user-agent": UA,
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        referer: opts.referer || "https://aniworld.to/"
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

function parseAniworldCatalogFromHtml(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const source = String(html || "");
  const anchorRe = /<a\b([^>]*?)href="([^"]*\/anime\/stream\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(source))) {
    const beforeAttrs = String(match[1] || "");
    const href = normalizeUrl(match[2] || "");
    const afterAttrs = String(match[3] || "");
    const inner = String(match[4] || "");
    if (!href) continue;
    const title =
      stripTags(inner)
        .replace(/\s*alle folgen ansehen\s*$/i, "")
        .trim() ||
      stripTags((beforeAttrs + " " + afterAttrs).match(/\btitle="([^"]+)"/i)?.[1] || "");
    if (!title) continue;
    const imgMatch = (beforeAttrs + " " + inner + " " + afterAttrs).match(
      /<img[^>]+src="([^"]+)"/i
    );
    const poster = imgMatch ? normalizeUrl(imgMatch[1]) : "";
    const genreMatch = source
      .slice(Math.max(0, match.index - 260), Math.min(source.length, match.index + inner.length + 260))
      .match(/<h3[^>]*>\s*([^<]{2,80})\s*<\/h3>/i);
    const genre = genreMatch ? stripTags(genreMatch[1]) : "";
    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([title, href, poster, genre]);
  }
  return out;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeGenreName(value) {
  return stripTags(value)
    .replace(/\s+/g, " ")
    .trim();
}

function parseGenreDirectory(html) {
  const out = [];
  const seen = new Set();
  const source = String(html || "");
  const re = /<a[^>]+href="([^"]*\/genre\/([^"\/?#]+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(source))) {
    const href = normalizeUrl(match[1] || "");
    const slug = String(match[2] || "").trim().toLowerCase();
    const label = normalizeGenreName(match[3] || "");
    if (!href || !slug || !label) continue;
    if (slug === "neu" || slug === "beliebt" || slug === "alle") continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label, url: `https://aniworld.to/genre/${slug}` });
  }
  return out;
}

function parseGenrePageCount(html, slug) {
  const source = String(html || "");
  const re = new RegExp(`/genre/${escapeRegex(slug)}(?:/(\\d+))?(?=["'#?\\/])`, "gi");
  let max = 1;
  let match;
  while ((match = re.exec(source))) {
    const n = Number(match[1] || 1);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function parseAnimeEntriesFromHtml(html) {
  const out = [];
  const seen = new Set();
  const source = String(html || "");
  const anchorRe = /<a\b([^>]*?)href="([^"]*\/anime\/stream\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(source))) {
    const beforeAttrs = String(match[1] || "");
    const href = normalizeUrl(match[2] || "");
    const afterAttrs = String(match[3] || "");
    const inner = String(match[4] || "");
    if (!href) continue;
    const title =
      stripTags(inner)
        .replace(/\s*alle folgen ansehen\s*$/i, "")
        .trim() ||
      stripTags((beforeAttrs + " " + afterAttrs).match(/\btitle="([^"]+)"/i)?.[1] || "");
    if (!title) continue;
    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const imgMatch = (beforeAttrs + " " + inner + " " + afterAttrs).match(/<img[^>]+src="([^"]+)"/i);
    out.push({
      title,
      href,
      poster: imgMatch ? normalizeUrl(imgMatch[1]) : ""
    });
  }
  return out;
}

let genreCatalogCache = null;
let genreCatalogPromise = null;

async function fetchAnimeCatalog() {
  if (genreCatalogCache) return genreCatalogCache;
  if (genreCatalogPromise) return genreCatalogPromise;

  genreCatalogPromise = (async () => {
    const homeUrl = "https://aniworld.to/";
    const { text: homeHtml } = await fetchText(homeUrl, { referer: homeUrl });
    const genres = parseGenreDirectory(homeHtml);
    const animeMap = new Map();
    const genreCounts = {};

    for (const genre of genres) {
      const firstPageUrl = genre.url;
      const { text: firstHtml, response } = await fetchText(firstPageUrl, { referer: homeUrl });
      const pageCount = parseGenrePageCount(firstHtml, genre.slug);
      const pages = [{ html: firstHtml, url: response && response.url ? response.url : firstPageUrl }];

      for (let page = 2; page <= pageCount; page++) {
        const pageUrl = `${genre.url}/${page}`;
        const { text: pageHtml, response: pageResponse } = await fetchText(pageUrl, { referer: genre.url });
        pages.push({ html: pageHtml, url: pageResponse && pageResponse.url ? pageResponse.url : pageUrl });
      }

      for (const page of pages) {
        const entries = parseAnimeEntriesFromHtml(page.html);
        for (const entry of entries) {
          const key = String(entry.href || "").toLowerCase();
          if (!key) continue;
          if (!animeMap.has(key)) {
            animeMap.set(key, {
              title: entry.title,
              href: entry.href,
              poster: entry.poster || "",
              genres: new Set()
            });
          }
          const item = animeMap.get(key);
          if (!item.poster && entry.poster) item.poster = entry.poster;
          item.genres.add(genre.label);
          genreCounts[genre.label] = (genreCounts[genre.label] || 0) + 1;
        }
      }
    }

    const items = Array.from(animeMap.values())
      .map((item) => [
        item.title,
        item.href,
        item.poster,
        Array.from(item.genres).sort((a, b) => a.localeCompare(b, "de")).join(", ")
      ])
      .sort((a, b) => String(a[0] || "").localeCompare(String(b[0] || ""), "de"));

    genreCatalogCache = {
      ok: items.length > 0,
      sourceUrl: homeUrl,
      count: items.length,
      genreCount: genres.length,
      genreCounts,
      items
    };
    return genreCatalogCache;
  })().finally(() => {
    genreCatalogPromise = null;
  });

  return genreCatalogPromise;
}

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeBasicEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseAniworldHostersFromHtml(html) {
  const out = [];
  const seen = new Set();
  const source = String(html || "");
  const re =
    /<li[^>]*data-lang-key="([^"]+)"[^>]*data-link-target="([^"]+)"[^>]*>[\s\S]*?<h4>([^<]+)</g;
  let match;
  while ((match = re.exec(source))) {
    const languageKey = String(match[1] || "").trim();
    let target = String(match[2] || "").trim();
    const name = stripTags(match[3] || "");
    if (!target || !name) continue;
    const idMatch =
      (source
        .slice(Math.max(0, match.index - 100), Math.min(source.length, match.index + 220))
        .match(/episodeLink([^"]+)/) || [])[1] || "";
    if (target.startsWith("/dl/2010") && idMatch) {
      target = target.replace("/dl/2010", "/redirect/" + idMatch);
    }
    const url = normalizeUrl(target);
    const key = `${url}|${name}|${languageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      languageKey,
      url
    });
  }
  return out;
}

async function resolveAniworldRedirect(url) {
  const requestUrl = normalizeUrl(url);
  const { response, text } = await fetchText(requestUrl, {
    redirect: "manual",
    referer: "https://aniworld.to/"
  });
  const location = response.headers.get("location");
  if (location) return normalizeUrl(location);
  const metaMatch = text.match(/(?:href|url)=["']?(https?:\/\/[^"'\s>]+)/i);
  return metaMatch ? normalizeUrl(metaMatch[1]) : "";
}

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

async function resolveVoe(url) {
  const { text } = await fetchText(url, { referer: url });

  let m = text.match(/"src"\s*:\s*"(https?:[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
  if (m) return m[1].replace(/\\\//g, "/");

  m = text.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)/i);
  if (m) {
    const scriptUrl = new URL(m[2], url).toString();
    const { text: helperJs } = await fetchText(scriptUrl, { referer: url });
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
  const initial = await fetchText(url, { referer: "https://aniworld.to/" });
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

async function resolveFilemoon(url) {
  const first = await resolveGeneric(url);
  if (first) return first;
  const embedUrl = String(url || "").replace(/\/d\//i, "/e/");
  if (embedUrl && embedUrl !== url) {
    const second = await resolveGeneric(embedUrl);
    if (second) return second;
  }
  return "";
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
  if (/voe\./i.test(url) || /voeun/i.test(url)) return await resolveVoe(url);
  if (/dood|playmogo|myvidplay/i.test(url)) return await resolveDoodstream(url);
  if (/filemoon|moon|bysezejataos/i.test(url)) return await resolveFilemoon(url);
  if (/streamtape|stape/i.test(url)) return await resolveStreamtape(url);
  return await resolveGeneric(url);
}

function languageLabel(languageKey) {
  const key = String(languageKey || "").trim();
  if (key === "1") return "Deutsch";
  if (key === "2") return "Japanisch + EN Untertitel";
  if (key === "3") return "Japanisch + DE Untertitel";
  return "Unbekannt";
}

async function getEpisodeHosters(episodeUrl) {
  const cleanEpisodeUrl = normalizeUrl(episodeUrl);
  if (!cleanEpisodeUrl) {
    return { ok: false, error: "episodeUrl missing", hosters: [] };
  }

  const { text: episodeHtml, response } = await fetchText(cleanEpisodeUrl, {
    referer: "https://aniworld.to/"
  });
  const finalPageUrl = response.url || cleanEpisodeUrl;
  const hosters = parseAniworldHostersFromHtml(episodeHtml).map((hoster, index) => ({
    index,
    name: hoster.name,
    languageKey: hoster.languageKey,
    languageLabel: languageLabel(hoster.languageKey),
    url: hoster.url,
    label: `${languageLabel(hoster.languageKey)} - ${hoster.name}`
  }));

  return {
    ok: hosters.length > 0,
    episodeUrl: finalPageUrl,
    count: hosters.length,
    hosters,
    error: hosters.length ? "" : "No hosters found"
  };
}

async function resolveSelectedHoster(episodeUrl, hosterUrl, hosterName) {
  const cleanEpisodeUrl = normalizeUrl(episodeUrl);
  let selectedUrl = normalizeUrl(hosterUrl);
  if (!cleanEpisodeUrl || !selectedUrl) {
    return { ok: false, error: "episodeUrl or hosterUrl missing" };
  }

  const redirectUrl = selectedUrl.includes("/redirect/")
    ? await resolveAniworldRedirect(selectedUrl)
    : selectedUrl;
  const playableUrl = await resolveHosterUrl(redirectUrl || selectedUrl);
  if (!playableUrl) {
    return {
      ok: false,
      error: "No playable stream found",
      episodeUrl: cleanEpisodeUrl,
      hoster: String(hosterName || ""),
      redirectUrl: redirectUrl || selectedUrl
    };
  }

  return {
    ok: true,
    episodeUrl: cleanEpisodeUrl,
    hoster: String(hosterName || ""),
    redirectUrl: redirectUrl || selectedUrl,
    playableUrl
  };
}

async function resolveEpisode(episodeUrl) {
  const cleanEpisodeUrl = normalizeUrl(episodeUrl);
  if (!cleanEpisodeUrl) {
    return { ok: false, error: "episodeUrl missing" };
  }

  const { text: episodeHtml, response } = await fetchText(cleanEpisodeUrl, {
    referer: "https://aniworld.to/"
  });

  const finalPageUrl = response.url || cleanEpisodeUrl;
  const hosters = parseAniworldHostersFromHtml(episodeHtml);
  if (!hosters.length) {
    return {
      ok: false,
      error: "No hosters found",
      episodeUrl: finalPageUrl
    };
  }

  for (const hoster of hosters) {
    try {
      const redirectUrl = hoster.url.includes("/redirect/")
        ? await resolveAniworldRedirect(hoster.url)
        : hoster.url;
      const playableUrl = await resolveHosterUrl(redirectUrl || hoster.url);
      if (playableUrl) {
        return {
          ok: true,
          episodeUrl: finalPageUrl,
          hoster: hoster.name,
          redirectUrl: redirectUrl || hoster.url,
          playableUrl
        };
      }
    } catch (error) {
      hoster.error = String(error && error.message ? error.message : error);
    }
  }

  return {
    ok: false,
    error: "No playable stream found",
    episodeUrl: finalPageUrl,
    hosters
  };
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

  if (url.pathname === "/resolve") {
    try {
      const result = await resolveEpisode(url.searchParams.get("episodeUrl"));
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

  if (url.pathname === "/hosters") {
    try {
      const result = await getEpisodeHosters(url.searchParams.get("episodeUrl"));
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

  if (url.pathname === "/resolveHoster") {
    try {
      const result = await resolveSelectedHoster(
        url.searchParams.get("episodeUrl"),
        url.searchParams.get("hosterUrl"),
        url.searchParams.get("hosterName")
      );
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

  if (url.pathname === "/catalog") {
    try {
      const result = await fetchAnimeCatalog();
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
  console.log(`AniWorld Kodi-style resolver listening on http://0.0.0.0:${PORT}`);
});
