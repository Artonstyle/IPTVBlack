/* global require, process, Buffer, fetch */
// filmpalast.to Resolver – HTTP-Server im Stil des AniWorld-Resolvers.
// Endpunkte: /health, /catalog, /item?id=..., /importMeta?url=..., /resolve?streamUrl=...
//
// Starten:  node filmpalast-resolver.server.js   (PORT über process.env.PORT)
// Hinweis:  Serverseitig ausgeführt (kein CORS). Die Hoster-Auflösung
//           (VOE, Streamtape, Doodstream, generic) stammt vom AniWorld-Vorbild.

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
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

// Optionaler Cloudflare-Unblocker (gehostet, kein lokaler Laptop nötig).
// Env:
//   UNBLOCKER=scraperapi|custom   UNBLOCKER_KEY=...   UNBLOCKER_ENDPOINT=...
// scraperapi:  https://api.scraperapi.com?api_key=KEY&url=ENC&render=true&country_code=de
// custom:      UNBLOCKER_ENDPOINT mit Platzhaltern {url} und {key}
// Greift nur für filmpalast.to – Hoster (VOE/Streamtape/…) bleiben direkt.
function buildUpstreamUrl(targetUrl) {
  const mode = (process.env.UNBLOCKER || "").toLowerCase();
  const key = process.env.UNBLOCKER_KEY || "";
  const ep = process.env.UNBLOCKER_ENDPOINT || "";
  if (!mode) return "";
  const enc = encodeURIComponent(targetUrl);
  if (mode === "scraperapi")
    return `https://api.scraperapi.com?api_key=${encodeURIComponent(key)}&url=${enc}&render=true&country_code=de`;
  if (mode === "custom" && ep)
    return ep.replace("{url}", enc).replace("{key}", encodeURIComponent(key));
  return "";
}

// FlareSolverr-Fallback: Blockierte Seiten (Cloudflare-Challenge, 403/503)
// werden automatisch über einen selbst gehosteten Headless-Browser geholt.
// Env: FLARESOLVERR_URL=https://<flaresolverr-host>   (leer = deaktiviert)
function isProtectedPage(status, text) {
  if (status === 403 || status === 429 || status === 503) return true;
  return /just a moment|cf-challenge|cf-browser-verification|checking your browser|ddos protection|enable javascript and cookies/i.test(
    String(text || "").slice(0, 4000)
  );
}

async function fetchTextViaFlareSolverr(targetUrl) {
  const ep = String(process.env.FLARESOLVERR_URL || "").replace(/\/+$/, "");
  if (!ep) return null;

  try {
    const r = await fetch(ep + "/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "request.get",
        url: targetUrl,
        maxTimeout: 60000
      })
    });

    const data = await r.json();

    if (
      data &&
      data.status === "ok" &&
      data.solution &&
      data.solution.response
    ) {
      console.log(`[flaresolverr] Challenge gelöst für ${targetUrl}`);

      return {
        response: {
          status: 200,
          url: data.solution.url || targetUrl
        },
        text: data.solution.response
      };
    }

    console.warn(
      `[flaresolverr] keine Lösung für ${targetUrl}:`,
      data && data.message
    );
  } catch (error) {
    console.warn(
      `[flaresolverr] Fehler für ${targetUrl}:`,
      String(error && error.message)
    );
  }

  return null;
}

async function fetchText(url, opts = {}) {
  const upstream = /filmpalast\.to/i.test(url)
    ? buildUpstreamUrl(url)
    : "";

  const finalUrl = upstream || url;

  try {
    const response = await fetch(finalUrl, {
      redirect: opts.redirect || "follow",
      headers: upstream
        ? {
            "user-agent": UA,
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "de-DE,de;q=0.9,en;q=0.8"
          }
        : {
            "user-agent": UA,
            "accept-language": "de-DE,de;q=0.9,en;q=0.8",
            referer: opts.referer || BASE_URL + "/"
          }
    });

    const text = await response.text();

    if (isProtectedPage(response.status, text)) {
      const solved = await fetchTextViaFlareSolverr(url);
      if (solved) return solved;
    }

    return { response, text };
  } catch (error) {
    const err = new Error(
      `fetch failed for ${finalUrl}: ${String(
        error && error.message ? error.message : error
      )}`
    );

    err.cause = error;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

function extractSlugFromStreamUrl(url) {
  const m = String(url || "").match(/\/stream\/([^?#]+)/i);
  return m ? m[1] : "";
}

function findCoverInChunk(chunk) {
  const imageRe =
    /(?:src|data-src|data-original|data-lazy-src|poster)\s*=\s*"([^"]+\.(?:jpe?g|png|webp|gif)[^"]*)"/gi;

  let match;

  while ((match = imageRe.exec(String(chunk || "")))) {
    const imageUrl = normalizeUrl(match[1]);

    if (
      !/(?:star_(?:on|off)|rating|icon|sprite|logo)\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(
        imageUrl
      )
    ) {
      return imageUrl;
    }
  }

  return "";
}

function findTitleInChunk(chunk, fallback) {
  let t = (
    String(chunk || "").match(
      /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i
    ) || []
  )[1];

  if (t) return stripTags(t);

  t = (
    String(chunk || "").match(
      /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    ) || []
  )[1];

  if (t) return stripTags(t);

  t = (
    String(chunk || "").match(/<img[^>]*\balt="([^"]+)"/i) || []
  )[1];

  if (t && t.trim().length > 1) return stripTags(t);

  t = (
    String(chunk || "").match(/\btitle="([^"]+)"/i) || []
  )[1];

  if (t && t.trim().length > 1) return stripTags(t);

  return stripTags(fallback || "");
}

function detectBlockedOrNonCatalogPage(text) {
  const t = String(text || "");

  if (!t.trim()) return "Leere Antwort";

  if (t.length < 500) {
    return "Antwort zu kurz für eine Katalogseite";
  }

  const decoded = t
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

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
    if (lower.includes(mk)) {
      return `Blockseite/Fehler erkannt: "${mk}"`;
    }
  }

  return null;
}

function parseFilmpalastCatalogFromHtml(html) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();

  const tested = [
    "slider-li",
    "generic /stream/ links",
    "container (article/div/li)"
  ];

  const add = (item) => {
    const key = String(item.slug || "").toLowerCase();

    if (!key || seen.has(key)) return;

    seen.add(key);
    out.push(item);
  };

  const sliderRe =
    /<li[^>]*class="[^"]*slider-li[^"]*"[^>]*>([\s\S]*?)<\/li>/g;

  let sm;

  while ((sm = sliderRe.exec(source)) && out.length < 200) {
    const block = sm[1];

    const linkMatch =
      block.match(
        /href="((?:https?:)?\/\/filmpalast\.to\/stream\/[^"#?]+)"[^>]*class="[^"]*moviSliderPlay"/i
      ) ||
      block.match(
        /href="((?:https?:)?\/\/filmpalast\.to\/stream\/[^"#?]+)"/i
      );

    const url = normalizeUrl(linkMatch ? linkMatch[1] : "");
    const slug = extractSlugFromStreamUrl(url);

    if (!slug) continue;

    const title =
      stripTags(
        (
          block.match(
            /<span class="title rb">([\s\S]*?)<\/span>/i
          ) || []
        )[1] || ""
      ) || slug;

    const cover = posterFromSlug(slug);

    const yearMatch = block.match(
      /class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})<\/b>/i
    );

    const year = yearMatch ? Number(yearMatch[1]) : null;

    const descMatch = block.match(
      /<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i
    );

    const description = descMatch
      ? decodeBasicEntities(descMatch[1])
      : "";

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

  const linkRe =
    /<a\b[^>]*href="([^"]*filmpalast\.to\/stream\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let lm;

  while ((lm = linkRe.exec(source)) && out.length < 200) {
    const url = normalizeUrl(lm[1]);
    const slug = extractSlugFromStreamUrl(url);

    if (!slug) continue;

    const inner = lm[2];
    const cover = posterFromSlug(slug);

    const title =
      findTitleInChunk(inner, stripTags(inner)) || slug;

    add({
      title,
      slug,
      url,
      cover,
      year: null,
      description: ""
    });
  }

  if (out.length) return out;

  const containerRe =
    /<(?:article|div|li)[^>]*class="[^"]*(?:movie|item|card|poster)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|li)>/gi;

  let cm;

  while ((cm = containerRe.exec(source)) && out.length < 200) {
    const block = cm[1];

    const linkMatch = block.match(
      /href="([^"]*filmpalast\.to\/stream\/[^"#?]+)"/i
    );

    if (!linkMatch) continue;

    const url = normalizeUrl(linkMatch[1]);
    const slug = extractSlugFromStreamUrl(url);

    if (!slug) continue;

    const cover = posterFromSlug(slug);
    const title = findTitleInChunk(block, slug) || slug;

    add({
      title,
      slug,
      url,
      cover,
      year: null,
      description: ""
    });
  }

  if (!out.length) {
    console.warn(
      "[filmpalast-catalog] 0 Treffer. Getestete Muster:",
      tested.join(", ")
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Katalog-URLs
// ---------------------------------------------------------------------------

function posterFromSlug(slug) {
  return `${BASE_URL}/files/movies/240/${encodeURIComponent(
    slug
  )}.jpg`;
}

function buildCatalogUrl(params) {
  const type = String(params.type || "movie").toLowerCase();
  const source = String(params.source || "new").toLowerCase();
  const page = Math.max(parseInt(params.page, 10) || 1, 1);

  const letter = encodeURIComponent(
    String(params.letter || "A")
  );

  const genre = encodeURIComponent(
    String(params.genre || "")
  );

  const query = encodeURIComponent(
    String(params.query || "")
  );

  const paged = page > 1 ? `/page/${page}` : "";
  const alphaPaged = page > 1 ? `/${page}` : "";

  if (type === "series") {
    return `${BASE_URL}/search/serien/alpha/${letter}`;
  }

  if (source === "top") {
    return `${BASE_URL}/movies/top${paged}`;
  }

  if (source === "alpha") {
    return `${BASE_URL}/search/alpha/${letter}${alphaPaged}`;
  }

  if (source === "genre") {
    return `${BASE_URL}/search/genre/${genre}`;
  }

  if (source === "search") {
    return `${BASE_URL}/search?search=${query}`;
  }

  return `${BASE_URL}/movies/new${paged}`;
}

function parseArticleItems(html) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();

  const artRe =
    /<article[^>]*class="[^"]*liste[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;

  let am;

  while ((am = artRe.exec(source))) {
    const block = am[1];

    const aM =
      block.match(
        /<a[^>]*href="([^"]*\/stream\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      block.match(
        /<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"/i
      );

    if (!aM) continue;

    const url = normalizeUrl(aM[1]);
    const slug = extractSlugFromStreamUrl(url);

    if (!slug || seen.has(slug)) continue;

    seen.add(slug);

    const title =
      stripTags(aM[2]) ||
      (
        block.match(/title="([^"]+)"/i) || []
      )[1] ||
      slug;

    const yearM = title.match(/\((\d{4})\)/);

    out.push({
      title,
      slug,
      url: url || `${BASE_URL}/stream/${slug}`,
      cover: posterFromSlug(slug),
      year: yearM ? Number(yearM[1]) : null,
      description: ""
    });
  }

  return out;
}

async function fetchCatalog(params) {
  const targetUrl = buildCatalogUrl(params);

  const { response, text } = await fetchText(targetUrl, {
    referer: BASE_URL + "/"
  });

  const status = (response && response.status) || 0;

  const htmlLen = String(text || "").length;

  console.log(
    `[filmpalast-catalog] ${targetUrl} -> HTTP ${status} | ${htmlLen} Bytes`
  );

  const blockReason = detectBlockedOrNonCatalogPage(text);

  if (blockReason) {
    return {
      ok: false,
      error: "Quelle blockiert oder keine Katalogseite",
      reason: blockReason,
      debug: {
        targetUrl,
        status,
        htmlLen,
        snippet: String(text || "").slice(0, 300)
      }
    };
  }

  const bySlug = new Map();

  for (const m of parseFilmpalastCatalogFromHtml(text)) {
    bySlug.set(m.slug, m);
  }

  for (const m of parseArticleItems(text)) {
    if (
      !bySlug.has(m.slug) ||
      !bySlug.get(m.slug).cover
    ) {
      bySlug.set(m.slug, m);
    }
  }

  const type = String(
    params.type || "movie"
  ).toLowerCase();

  const source = String(
    params.source || "new"
  ).toLowerCase();

  const isSeries = type === "series";

  const items = [...bySlug.values()].map((m) => ({
    id: m.slug,
    slug: m.slug,
    title: m.title,
    type: isSeries ? "series" : "movie",
    category: isSeries ? "Serie" : "Film",
    year: m.year ? String(m.year) : "",
    poster: m.cover || posterFromSlug(m.slug),
    description: m.description || "",
    url: m.url || `${BASE_URL}/stream/${m.slug}`
  }));

  if (!items.length) {
    const hasStreamLinks =
      /\/stream\//i.test(text || "");

    return {
      ok: false,
      error: "Keine Titel auf dieser Seite gefunden",
      debug: {
        targetUrl,
        status,
        htmlLen,
        hasStreamLinks,
        snippet: String(text || "").slice(0, 500)
      }
    };
  }

  const paginable =
    !isSeries &&
    (
      source === "new" ||
      source === "top" ||
      source === "alpha"
    );

  return {
    ok: true,
    count: items.length,
    page: parseInt(params.page, 10) || 1,
    type,
    source,
    hasMore:
      paginable &&
      items.length >= 30,
    items
  };
}

// ---------------------------------------------------------------------------
// Stream-Seite
// ---------------------------------------------------------------------------

function parseStreamPageDetails(html, finalUrl) {
  const source = String(html || "");

  const slug = finalUrl
    ? (
        finalUrl.match(
          /\/stream\/([^?#]+)/
        ) || []
      )[1] || ""
    : "";

  let title = stripTags(
    (
      source.match(
        /<span[^>]*class="[^\"]*value-title[^\"]*"[^>]*title="([^"]+)"/i
      ) || []
    )[1] || ""
  );

  if (!title) {
    title = stripTags(
      (
        source.match(
          /<span class="title rb">([\s\S]*?)<\/span>/i
        ) || []
      )[1] || ""
    );
  }

  if (!title) {
    title = stripTags(
      (
        source.match(
          /<h1[^>]*>([\s\S]*?)<\/h1>/i
        ) || []
      )[1] || ""
    );
  }

  if (!title) {
    const t =
      (
        source.match(
          /<title>([\s\S]*?)<\/title>/i
        ) || []
      )[1] || "";

    title = stripTags(t)
      .replace(
        /\s*[-|]\s*Filmpalast.*$/i,
        ""
      )
      .replace(
        /\s*Stream.*$/i,
        ""
      )
      .trim();
  }

  title = title || slug;

  const detailDescMatch = source.match(
    /<span[^>]*class="[^\"]*\bhidden\b[^\"]*"[^>]*>([\s\S]*?)<\/span>/i
  );

  const descMatch = source.match(
    /<div class="moviedescription">\s*<b>Beschreibung:<\/b>\s*([\s\S]*?)<\/div>/i
  );

  const description = detailDescMatch
    ? stripTags(detailDescMatch[1])
    : descMatch
      ? decodeBasicEntities(descMatch[1])
      : "";

  const ogImg = source.match(
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i
  );

  const coverMatch = source.match(
    /<img[^>]*src="((?:https?:\/\/filmpalast\.to)?\/files\/movies\/[^"]+)"/i
  );

  const poster = ogImg
    ? ogImg[1]
    : coverMatch
      ? normalizeUrl(coverMatch[1])
      : "";

  const yearMatch = source.match(
    /class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})<\/b>/i
  );

  const year = yearMatch
    ? yearMatch[1]
    : "";

  const genreBlock = source.match(
    /<li[^>]*>\s*<p>\s*Kategorien,\s*Genre\s*<\/p>\s*<span>([\s\S]*?)<\/span>/i
  );

  const genres = [];

  if (genreBlock) {
    const genreRe =
      /<a[^>]*>([\s\S]*?)<\/a>/gi;

    let genreMatch;

    while (
      (
        genreMatch =
          genreRe.exec(genreBlock[1])
      )
    ) {
      const genre =
        stripTags(genreMatch[1]);

      if (
        genre &&
        !genres.includes(genre)
      ) {
        genres.push(genre);
      }
    }
  }

  const hosters =
    parseFilmpalastHostersFromHtml(source);

  return {
    id: slug,
    slug,
    title,
    type: "movie",
    category: "Film",
    year,
    genre: genres.join(", "),
    poster,
    description,
    hosters,
    url: finalUrl
  };
}

async function fetchItemById(id) {
  if (!id) {
    return {
      ok: false,
      error: "id missing"
    };
  }

  const streamUrl =
    /^https?:\/\//i.test(id)
      ? id
      : `${BASE_URL}/stream/${id}`;

  const { text, response } =
    await fetchText(streamUrl, {
      referer: BASE_URL + "/"
    });

  const finalUrl =
    response.url || streamUrl;

  const d =
    parseStreamPageDetails(
      text,
      finalUrl
    );

  const item = {
    id: d.id,
    title: d.title,
    type: "movie",
    category: d.category,
    year: d.year,
    genre: d.genre,
    poster: d.poster,
    description: d.description,
    seasons: [
      {
        key: "s1",
        label: "Film",
        number: 1,
        episodes: [
          {
            id: "e1",
            title: d.title,
            episode_num: 1,
            url: finalUrl
          }
        ]
      }
    ]
  };

  return {
    ok: true,
    item,
    hosters: d.hosters,
    sources: d.hosters
  };
}

// ---------------------------------------------------------------------------
// Hoster
// ---------------------------------------------------------------------------

function parseFilmpalastHostersFromHtml(html) {
  const out = [];
  const seen = new Set();

  const source =
    String(html || "").replace(
      /<!--[\s\S]*?-->/g,
      ""
    );

  const blockRe =
    /<ul class="currentStreamLinks">([\s\S]*?)<\/ul>/g;

  let blockMatch;

  while (
    (
      blockMatch =
        blockRe.exec(source)
    )
  ) {
    const block =
      blockMatch[1];

    const nameMatch =
      block.match(
        /<p class="hostName">([\s\S]*?)<\/p>/i
      );

    const name = nameMatch
      ? stripTags(nameMatch[1]).replace(
          /\s+(HD|SD|4K)$/i,
          ""
        )
      : "";

    const dpMatch =
      block.match(
        /data-player-url="([^"]+)"/i
      );

    const aMatch =
      block.match(
        /<a[^>]*href="(https?:\/\/[^"]+)"/i
      );

    const raw = dpMatch
      ? dpMatch[1]
      : aMatch
        ? aMatch[1]
        : "";

    if (!raw) continue;

    const url =
      normalizeUrl(raw);

    if (!url) continue;

    const key =
      `${url}|${name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    out.push({
      name,
      url
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Hoster-Auflösung
// ---------------------------------------------------------------------------

function pickBestUrl(urls) {
  const items = (urls || [])
    .map((u) =>
      String(u || "")
        .replace(/\\\//g, "/")
        .trim()
    )
    .filter(Boolean);

  if (!items.length) {
    return "";
  }

  items.sort(
    (a, b) =>
      scoreUrl(b) -
      scoreUrl(a)
  );

  return items[0];
}

function scoreUrl(url) {
  const m =
    String(url).match(
      /(\d{3,4})p?/i
    );

  return m
    ? Number(m[1])
    : 360;
}

// ---------------------------------------------------------------------------
// VOE Redirect
// ---------------------------------------------------------------------------

async function followJsRedirect(
  text,
  baseUrl
) {
  const m = text.match(
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i
  );

  if (m && m[1]) {
    try {
      return new URL(
        m[1],
        baseUrl
      ).toString();
    } catch {
      return baseUrl;
    }
  }

  return baseUrl;
}

// ---------------------------------------------------------------------------
// VOE Resolver
// ---------------------------------------------------------------------------

async function resolveVoe(url) {
  let current = url;

  let { text } =
    await fetchText(current, {
      referer:
        "https://filmpalast.to/"
    });

  const next =
    await followJsRedirect(
      text,
      current
    );

  if (
    next &&
    next !== current
  ) {
    current = next;

    ({ text } =
      await fetchText(current, {
        referer: url
      }));
  }

  let m = text.match(
    /"src"\s*:\s*"(https?:[^"]+\.(?:mp4|m3u8)[^"]*)"/i
  );

  if (m) {
    return m[1].replace(
      /\\\//g,
      "/"
    );
  }

  const payloadMatch =
    text.match(
      /<script[^>]*type=["']application\/json["'][^>]*>\s*(\[[\s\S]*?\])\s*<\/script>/i
    );

  if (payloadMatch) {
    try {
      const payload =
        JSON.parse(
          payloadMatch[1]
        );

      const cipherText =
        Array.isArray(payload)
          ? payload[0]
          : "";

      if (
        typeof cipherText ===
          "string" &&
        cipherText
      ) {
        const decoded =
          voeDecode(
            cipherText
          );

        const sources = [];

        [
          "file",
          "source",
          "direct_access_url"
        ].forEach((key) => {
          if (decoded[key]) {
            sources.push(
              decoded[key]
            );
          }
        });

        const best =
          pickBestUrl(
            sources
          );

        if (best) {
          return best;
        }
      }
    } catch {
      // weiter
    }
  }

  const mediaMatches =
    text.match(
      /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/gi
    ) || [];

  const directMatch =
    pickBestUrl(
      mediaMatches
    );

  if (directMatch) {
    return directMatch;
  }

  // FlareSolverr Fallback
  if (
    process.env
      .FLARESOLVERR_URL
  ) {
    const rendered =
      await fetchTextViaFlareSolverr(
        current
      );

    if (rendered) {
      const dom =
        String(
          rendered.text || ""
        );

      const videoTag =
        dom.match(
          /<video[^>]+src="(https?:\/\/[^"]+)"/i
        );

      if (
        videoTag &&
        isValidPlayableUrl(
          videoTag[1]
        )
      ) {
        return videoTag[1];
      }

      const sourceTag =
        dom.match(
          /<source[^>]+src="(https?:\/\/[^"]+)"/i
        );

      if (
        sourceTag &&
        isValidPlayableUrl(
          sourceTag[1]
        )
      ) {
        return sourceTag[1];
      }

      const domUrls =
        dom.match(
          /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/gi
        ) || [];

      const viaDom =
        pickBestUrl(
          domUrls
        );

      if (viaDom) {
        return viaDom;
      }
    }
  }

  // -------------------------------------------------------
  // Playwright VOE Extractor
  // -------------------------------------------------------

  const extractorBase =
    String(
      process.env
        .VOE_EXTRACTOR_URL ||
        ""
    ).replace(
      /\/+$/,
      ""
    );

  if (extractorBase) {
    try {
      const extractorUrl =
        extractorBase +
        "/resolve?url=" +
        encodeURIComponent(
          current
        );

      console.log(
        `[voe-extractor] Anfrage: ${extractorUrl}`
      );

      const response =
        await fetch(
          extractorUrl,
          {
            headers: {
              "user-agent": UA,
              accept:
                "application/json"
            }
          }
        );

      if (response.ok) {
        const data =
          await response.json();

        const videoUrl =
          data &&
          data.videoUrl;

        if (
          videoUrl &&
          isValidPlayableUrl(
            videoUrl
          )
        ) {
          console.log(
            `[voe-extractor] Stream gefunden: ${videoUrl}`
          );

          return videoUrl;
        }

        console.warn(
          "[voe-extractor] Keine gültige Video-URL:",
          data
        );
      } else {
        console.warn(
          `[voe-extractor] HTTP ${response.status}`
        );
      }
    } catch (error) {
      console.warn(
        "[voe-extractor] Fehler:",
        String(
          error &&
          error.message
            ? error.message
            : error
        )
      );
    }
  } else {
    console.warn(
      "[voe-extractor] VOE_EXTRACTOR_URL ist nicht gesetzt"
    );
  }

  return "";
}

// ---------------------------------------------------------------------------
// VOE Decode
// ---------------------------------------------------------------------------

function voeDecode(
  cipherText,
  lutText
) {
  const lut = lutText
    ? lutText
        .slice(2, -2)
        .split("','")
        .map((item) =>
          item.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )
        )
    : [
        "\\*~",
        "!!",
        "#&",
        "@\\$",
        "%\\?",
        "\\^\\^",
        "~@"
      ];

  let text = "";

  for (const ch of cipherText) {
    let code =
      ch.charCodeAt(0);

    if (
      code > 64 &&
      code < 91
    ) {
      code =
        ((code - 52) % 26) +
        65;
    } else if (
      code > 96 &&
      code < 123
    ) {
      code =
        ((code - 84) % 26) +
        97;
    }

    text +=
      String.fromCharCode(
        code
      );
  }

  for (const item of lut) {
    text = text.replace(
      new RegExp(
        item,
        "g"
      ),
      ""
    );
  }

  const step1 =
    Buffer.from(
      text,
      "base64"
    ).toString(
      "utf8"
    );

  const step2 =
    step1
      .split("")
      .map((ch) =>
        String.fromCharCode(
          ch.charCodeAt(0) -
            3
        )
      )
      .join("");

  const step3 =
    Buffer.from(
      step2
        .split("")
        .reverse()
        .join(""),
      "base64"
    ).toString(
      "utf8"
    );

  return JSON.parse(
    step3
  );
}

// ---------------------------------------------------------------------------
// Doodstream
// ---------------------------------------------------------------------------

async function resolveDoodstream(url) {
  const initial =
    await fetchText(url, {
      referer:
        "https://filmpalast.to/"
    });

  let finalUrl =
    initial.response.url ||
    url;

  let html =
    initial.text;

  const iframeMatch =
    html.match(
      /<iframe\s*src="([^"]+)/i
    );

  if (iframeMatch) {
    finalUrl =
      new URL(
        iframeMatch[1],
        finalUrl
      ).toString();

    const embedded =
      await fetchText(
        finalUrl,
        {
          referer:
            finalUrl
        }
      );

    html =
      embedded.text;
  } else {
    const altUrl =
      finalUrl.replace(
        "/d/",
        "/e/"
      );

    const embedded =
      await fetchText(
        altUrl,
        {
          referer:
            finalUrl
        }
      );

    html =
      embedded.text;

    finalUrl =
      altUrl;
  }

  const match =
    html.match(
      /dsplayer\.hotkeys[^']+'([^']+).+?function\s*makePlay.+?return[^?]+([^"]+)/is
    );

  if (!match) {
    return await resolveGeneric(
      finalUrl,
      html
    );
  }

  const token =
    match[2];

  const passUrl =
    new URL(
      match[1],
      finalUrl
    ).toString();

  const {
    text: passResult
  } =
    await fetchText(
      passUrl,
      {
        referer:
          finalUrl
      }
    );

  if (
    passResult.includes(
      "cloudflarestorage."
    )
  ) {
    return passResult.trim();
  }

  return (
    doodDecode(passResult) +
    token +
    String(Date.now())
  );
}

function doodDecode(data) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  let suffix = "";

  for (
    let i = 0;
    i < 10;
    i++
  ) {
    suffix +=
      chars[
        Math.floor(
          Math.random() *
            chars.length
        )
      ];
  }

  return (
    String(data || "") +
    suffix
  );
}

// ---------------------------------------------------------------------------
// Streamtape
// ---------------------------------------------------------------------------

async function resolveStreamtape(url) {
  const { text } =
    await fetchText(url, {
      referer: url
    });

  const direct =
    text.match(
      /(https?:\/\/[a-z0-9.-]*streamtape[a-z.]*\/get_video[^"'\s]+)/i
    );

  if (direct) {
    return direct[1];
  }

  return await resolveGeneric(
    url,
    text
  );
}

// ---------------------------------------------------------------------------
// Generic Resolver
// ---------------------------------------------------------------------------

async function resolveGeneric(
  url,
  existingHtml = ""
) {
  const text =
    existingHtml ||
    (
      await fetchText(
        url,
        {
          referer: url
        }
      )
    ).text;

  const matches =
    text.match(
      /https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi
    ) || [];

  const best =
    pickBestUrl(
      matches
    );

  if (best) {
    return best;
  }

  const iframe =
    text.match(
      /<iframe[^>]+src="(https?:\/\/[^"]+)"/i
    );

  if (iframe) {
    return await resolveGeneric(
      iframe[1]
    );
  }

  if (
    /\/api\/stream/.test(
      text
    )
  ) {
    const viaApi =
      await resolveVidaraApi(
        url
      );

    if (viaApi) {
      return viaApi;
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Vidara
// ---------------------------------------------------------------------------

async function resolveVidaraApi(
  hosterUrl
) {
  try {
    const u =
      new URL(
        normalizeUrl(
          hosterUrl
        )
      );

    const filecode =
      u.pathname
        .split("/")
        .filter(Boolean)
        .pop();

    if (!filecode) {
      return "";
    }

    const r =
      await fetch(
        u.origin +
          "/api/stream",
        {
          method: "POST",
          headers: {
            "user-agent": UA,
            "content-type":
              "application/json",
            accept:
              "application/json",
            origin:
              u.origin,
            referer:
              u.toString()
          },
          body:
            JSON.stringify({
              filecode,
              device: "web"
            })
        }
      );

    const data =
      await r.json();

    const su =
      data &&
      data.streaming_url;

    if (
      isValidPlayableUrl(
        su
      )
    ) {
      return su;
    }

    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Hoster Typ erkennen
// ---------------------------------------------------------------------------

async function resolveHosterUrl(
  hosterUrl
) {
  const url =
    normalizeUrl(
      hosterUrl
    );

  if (!url) {
    return "";
  }

  if (/vidara/i.test(url)) {
    const viaApi =
      await resolveVidaraApi(
        url
      );

    if (viaApi) {
      return viaApi;
    }
  }

  if (
    /voe|voeun|vidaraa|vidsonic|vixeo|filelion|lula|tracy|playmate/i.test(
      url
    )
  ) {
    return await resolveVoe(
      url
    );
  }

  if (
    /dood|playmogo|myvidplay/i.test(
      url
    )
  ) {
    return await resolveDoodstream(
      url
    );
  }

  if (
    /streamtape|stape/i.test(
      url
    )
  ) {
    return await resolveStreamtape(
      url
    );
  }

  return await resolveGeneric(
    url
  );
}

// ---------------------------------------------------------------------------
// Video Validierung
// ---------------------------------------------------------------------------

const SOURCE_UNAVAILABLE_MSG =
  "Diese Videoquelle ist derzeit nicht verfügbar. Bitte wähle eine andere Quelle.";

const SUPPORTED_VIDEO_RE =
  /\.(m3u8|mp4|webm|ogg|ogv|mkv|mov|avi|ts)(?:[?#]|$)/i;

function isValidPlayableUrl(u) {
  const s =
    String(u || "").trim();

  if (!s) {
    return false;
  }

  if (
    !/^https?:\/\//i.test(
      s
    )
  ) {
    return false;
  }

  return SUPPORTED_VIDEO_RE.test(
    s
  );
}

// ---------------------------------------------------------------------------
// Einzelnen Hoster lösen
// ---------------------------------------------------------------------------

async function resolveSingleHoster(
  hosterUrl,
  sourceName
) {
  const url =
    normalizeUrl(
      hosterUrl
    );

  const name =
    String(
      sourceName || ""
    ).trim();

  if (!url) {
    return {
      ok: false,
      sourceName: name,
      error:
        SOURCE_UNAVAILABLE_MSG,
      reason:
        "url missing"
    };
  }

  try {
    const playableUrl =
      await resolveHosterUrl(
        url
      );

    if (
      !isValidPlayableUrl(
        playableUrl
      )
    ) {
      return {
        ok: false,
        sourceName: name,
        hosterUrl: url,
        error:
          SOURCE_UNAVAILABLE_MSG,
        reason:
          !playableUrl
            ? "no direct url"
            : "unsupported format"
      };
    }

    return {
      ok: true,
      sourceName: name,
      hosterUrl: url,
      playableUrl
    };
  } catch (error) {
    return {
      ok: false,
      sourceName: name,
      hosterUrl: url,
      error:
        SOURCE_UNAVAILABLE_MSG,
      reason:
        String(
          error &&
          error.message
            ? error.message
            : error
        )
    };
  }
}

// ---------------------------------------------------------------------------
// Resolve Movie
// ---------------------------------------------------------------------------

async function resolveMovie(params) {
  if (
    typeof params ===
    "string"
  ) {
    params = {
      streamUrl: params
    };
  }

  const streamUrl =
    params &&
    params.streamUrl;

  const hosterUrl =
    params &&
    params.hosterUrl;

  const sourceName =
    (
      params &&
      params.sourceName
    ) || "";

  if (hosterUrl) {
    return await resolveSingleHoster(
      hosterUrl,
      sourceName
    );
  }

  let cleanUrl =
    normalizeUrl(
      streamUrl
    );

  if (!cleanUrl) {
    return {
      ok: false,
      error:
        "streamUrl missing"
    };
  }

  if (
    /^https?:\/\//i.test(
      cleanUrl
    ) &&
    !/filmpalast\.to\/stream\//i.test(
      cleanUrl
    )
  ) {
    return await resolveSingleHoster(
      cleanUrl,
      sourceName
    );
  }

  if (
    !/^https?:\/\//i.test(
      cleanUrl
    )
  ) {
    cleanUrl =
      `${BASE_URL}/stream/${cleanUrl}`;
  }

  const {
    text: pageHtml,
    response
  } =
    await fetchText(
      cleanUrl,
      {
        referer:
          BASE_URL + "/"
      }
    );

  const finalPageUrl =
    response.url ||
    cleanUrl;

  const details =
    parseStreamPageDetails(
      pageHtml,
      finalPageUrl
    );

  const sources =
    (
      details.hosters ||
      []
    ).map((h) => ({
      name: h.name,
      url: h.url
    }));

  if (!sources.length) {
    return {
      ok: false,
      error:
        SOURCE_UNAVAILABLE_MSG,
      reason:
        "no sources",
      streamUrl:
        finalPageUrl
    };
  }

  return {
    ok: true,
    needsSelection: true,
    streamUrl:
      finalPageUrl,
    item: {
      id:
        details.id,
      title:
        details.title,
      year:
        details.year,
      genre:
        details.genre,
      poster:
        details.poster,
      description:
        details.description
    },
    sources
  };
}

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

function errorToObject(error) {
  if (!error) {
    return {
      message:
        "unknown error"
    };
  }

  const cause =
    error.cause ||
    null;

  return {
    message:
      String(
        error.message ||
        error
      ),
    stack:
      error.stack ||
      "",
    cause:
      cause
        ? {
            message:
              String(
                cause.message ||
                cause
              ),
            stack:
              cause.stack ||
              "",
            code:
              cause.code ||
              "",
            errno:
              cause.errno ||
              "",
            syscall:
              cause.syscall ||
              ""
          }
        : null
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      if (
        req.method ===
        "OPTIONS"
      ) {
        res.writeHead(
          204,
          {
            "Access-Control-Allow-Origin":
              "*",
            "Access-Control-Allow-Methods":
              "GET, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type"
          }
        );

        res.end();
        return;
      }

      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      if (
        url.pathname ===
          "/health" ||
        url.pathname ===
          "/" ||
        url.pathname ===
          "/index.html"
      ) {
        sendJson(
          res,
          200,
          {
            ok: true,
            service:
              "filmpalast-resolver",
            port: PORT
          }
        );

        return;
      }

      // ---------------------------------------------------
      // Catalog
      // ---------------------------------------------------

      if (
        url.pathname ===
        "/catalog"
      ) {
        try {
          const result =
            await fetchCatalog({
              type:
                url.searchParams.get(
                  "type"
                ),
              source:
                url.searchParams.get(
                  "source"
                ),
              letter:
                url.searchParams.get(
                  "letter"
                ),
              genre:
                url.searchParams.get(
                  "genre"
                ),
              query:
                url.searchParams.get(
                  "query"
                ),
              page:
                url.searchParams.get(
                  "page"
                )
            });

          sendJson(
            res,
            result.ok
              ? 200
              : 502,
            result
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              ok: false,
              error:
                String(
                  error &&
                  error.message
                    ? error.message
                    : error
                ),
              details:
                errorToObject(
                  error
                )
            }
          );
        }

        return;
      }

      // ---------------------------------------------------
      // Item
      // ---------------------------------------------------

      if (
        url.pathname ===
        "/item"
      ) {
        try {
          const result =
            await fetchItemById(
              url.searchParams.get(
                "id"
              )
            );

          sendJson(
            res,
            result.ok
              ? 200
              : 400,
            result
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              ok: false,
              error:
                String(
                  error &&
                  error.message
                    ? error.message
                    : error
                ),
              details:
                errorToObject(
                  error
                )
            }
          );
        }

        return;
      }

      // ---------------------------------------------------
      // Import Meta
      // ---------------------------------------------------

      if (
        url.pathname ===
        "/importMeta"
      ) {
        try {
          const result =
            await fetchItemById(
              url.searchParams.get(
                "url"
              )
            );

          sendJson(
            res,
            result.ok
              ? 200
              : 502,
            result
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              ok: false,
              error:
                String(
                  error &&
                  error.message
                    ? error.message
                    : error
                ),
              details:
                errorToObject(
                  error
                )
            }
          );
        }

        return;
      }

      // ---------------------------------------------------
      // Resolve
      // ---------------------------------------------------

      if (
        url.pathname ===
        "/resolve"
      ) {
        try {
          const result =
            await resolveMovie({
              streamUrl:
                url.searchParams.get(
                  "streamUrl"
                ),
              hosterUrl:
                url.searchParams.get(
                  "hosterUrl"
                ),
              sourceName:
                url.searchParams.get(
                  "sourceName"
                )
            });

          sendJson(
            res,
            result.ok
              ? 200
              : 502,
            result
          );
        } catch (error) {
          sendJson(
            res,
            500,
            {
              ok: false,
              error:
                String(
                  error &&
                  error.message
                    ? error.message
                    : error
                ),
              details:
                errorToObject(
                  error
                )
            }
          );
        }

        return;
      }

      // ---------------------------------------------------
      // Proxy
      // ---------------------------------------------------

      if (
        url.pathname ===
        "/proxy"
      ) {
        try {
          const target =
            url.searchParams.get(
              "u"
            );

          if (
            !target ||
            !/^https?:\/\//i.test(
              target
            )
          ) {
            sendJson(
              res,
              400,
              {
                ok: false,
                error:
                  "u missing"
              }
            );

            return;
          }

          const targetUrl =
            new URL(
              target
            );

          const upstreamHeaders = {
            "user-agent":
              UA,
            accept:
              "*/*",
            referer:
              targetUrl.origin +
              "/"
          };

          if (
            req.headers.range
          ) {
            upstreamHeaders.range =
              req.headers.range;
          }

          const upstream =
            await fetch(
              target,
              {
                headers:
                  upstreamHeaders
              }
            );

          const ct =
            upstream.headers.get(
              "content-type"
            ) || "";

          const isManifest =
            /mpegurl/i.test(
              ct
            ) ||
            /\.m3u8/i.test(
              target
            );

          if (isManifest) {
            const manifest =
              await upstream.text();

            const base =
              `${
                req.headers[
                  "x-forwarded-proto"
                ] || "http"
              }://${req.headers.host}`;

            const rewritten =
              manifest
                .split("\n")
                .map((line) => {
                  const t =
                    line.trim();

                  if (
                    !t ||
                    t.startsWith(
                      "#"
                    )
                  ) {
                    return line;
                  }

                  try {
                    const abs =
                      new URL(
                        t,
                        targetUrl
                      ).toString();

                    return (
                      `${base}/proxy?u=` +
                      encodeURIComponent(
                        abs
                      )
                    );
                  } catch {
                    return line;
                  }
                })
                .join("\n");

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/vnd.apple.mpegurl",
                "Access-Control-Allow-Origin":
                  "*"
              }
            );

            res.end(
              rewritten
            );

            return;
          }

          const headers = {
            "Content-Type":
              ct ||
              "application/octet-stream",
            "Access-Control-Allow-Origin":
              "*"
          };

          for (
            const h of [
              "content-length",
              "content-range",
              "accept-ranges"
            ]
          ) {
            const v =
              upstream.headers.get(
                h
              );

            if (v) {
              headers[
                h.replace(
                  /(^\w)/,
                  (c) =>
                    c.toUpperCase()
                )
              ] = v;
            }
          }

          res.writeHead(
            upstream.status,
            headers
          );

          res.end(
            Buffer.from(
              await upstream.arrayBuffer()
            )
          );

          return;
        } catch (error) {
          sendJson(
            res,
            502,
            {
              ok: false,
              error:
                String(
                  error &&
                  error.message
                    ? error.message
                    : error
                )
            }
          );

          return;
        }
      }

      sendJson(
        res,
        404,
        {
          ok: false,
          error:
            "Not found"
        }
      );
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Filmpalast resolver listening on http://0.0.0.0:${PORT}`
    );
  }
);
