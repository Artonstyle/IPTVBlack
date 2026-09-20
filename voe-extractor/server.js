/* global require, process, console, Buffer */
// VOE-Extractor: dekodiert strukturierte Player-Daten zuerst.
// Playwright/JW-Player und Netzwerkanfragen bleiben als Fallback erhalten.
//
// Endpunkte:  GET /health
//             GET /resolve?url=<mirror-url>  ->  { ok, videoUrl, sources }
//
// Starten:    node server.js   (PORT über process.env.PORT, Default 8192)

const http = require("http");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8192);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const SUPPORTED_VIDEO_RE = /\.(m3u8|mp4|webm)(?:[?#]|$)/i;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(body);
}

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
            "\\async function extractFromUrl(targetUrl) {"
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

function isPlayableUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) &&
    SUPPORTED_VIDEO_RE.test(value);
}

function buildResult(values) {
  const all = [...new Set(values.filter(isPlayableUrl))];
  const best = all.find(u => /\.m3u8(?:[?#]|$)/i.test(u)) ||
    all.find(u => /\.mp4(?:[?#]|$)/i.test(u)) || all[0] || "";
  return { ok: !!best, videoUrl: best, sources: all.slice(0, 6) };
}

// Nur strukturierte Player-Daten lesen; keine beliebigen Video-Links
// aus dem HTML übernehmen (dort können Test- oder Werbevideos stehen).
function extractEncodedSources(html) {
  const sources = [];
  const scripts = html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    try {
      const payload = JSON.parse(match[1]);
      if (!Array.isArray(payload) || typeof payload[0] !== "string") continue;
      const decoded = voeDecode(payload[0]);
      for (const key of ["file", "source", "direct_access_url"]) {
        if (isPlayableUrl(decoded[key])) sources.push(decoded[key]);
      }
    } catch {
      // Andere JSON-Blöcke oder unbekannte Kodierung: Browser-Fallback.
    }
  }
  return sources;
}

async function resolveEncodedPage(context, targetUrl) {
  let current = targetUrl;
  const visited = new Set();
  for (let hop = 0; hop < 5 && !visited.has(current); hop++) {
    visited.add(current);
    const response = await context.request.get(current, { timeout: 20000 });
    try {
      if (response.status() === 429) throw new Error("VOE HTTP 429: Bitte später erneut versuchen.");
      if (!response.ok()) return { url: current, sources: [] };
      current = response.url();
      const html = await response.text();
      const sources = extractEncodedSources(html);
      if (sources.length) return { url: current, sources };
      const redirect = html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i);
      if (!redirect) break;
      const next = new URL(redirect[1], current);
      if (!/^https?:$/.test(next.protocol)) break;
      current = next.href;
    } finally {
      await response.dispose();
    }
  }
  return { url: current, sources: [] };
}

async function extractFromUrl(targetUrl) {
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--mute-audio"
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: {
        width: 1280,
        height: 720
      },
      extraHTTPHeaders: {
        referer: "https://filmpalast.to/"
      }
    });

    // HTTP-Auslese und Browser verwenden denselben Kontext und Server.
    let resolved;
    try {
      resolved = await resolveEncodedPage(context, targetUrl);
    } catch (error) {
      if (String(error.message).includes("HTTP 429")) throw error;
      console.warn("[voe-extractor] HTTP-Auslese fehlgeschlagen:", error.message);
      resolved = { url: targetUrl, sources: [] };
    }
    if (resolved.sources.length) return buildResult(resolved.sources);
    targetUrl = resolved.url;
    const page = await context.newPage();

    // Netzwerk-Capture als Fallback:
    // alle Media-Requests mitlesen.
    const mediaUrls = [];

    page.on("request", (req) => {
      const u = req.url();

      if (/\.(m3u8|mp4|webm)(?:[?#]|$)/i.test(u)) {
        mediaUrls.push(u);
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page
      .waitForSelector(".jwplayer, video", {
        timeout: 20000
      })
      .catch(() => {});

    await page.waitForTimeout(3000);

    const decodedSources = extractEncodedSources(await page.content());
    if (decodedSources.length) return buildResult(decodedSources);

    // JW-Player-API:
    // Die Playlist enthält die direkte Quelle.
    const sources = await page.evaluate(() => {
      const out = [];

      try {
        if (window.jwplayer) {
          const el = document.querySelector(".jwplayer");

          if (el && el.id) {
            const player = window.jwplayer(el.id);

            const playlist =
              (player.getPlaylist && player.getPlaylist()) || [];

            for (const item of playlist) {
              if (item && item.file) {
                out.push(item.file);
              }

              for (const s of (item && item.sources) || []) {
                if (s && s.file) {
                  out.push(s.file);
                }
              }
            }

            if (!out.length) {
              const current =
                player.getPlaylistItem &&
                player.getPlaylistItem();

              if (current && current.file) {
                out.push(current.file);
              }
            }
          }
        }

        const video = document.querySelector("video");

        if (video && video.src) {
          out.push(video.src);
        }

        document
          .querySelectorAll("video source")
          .forEach((s) => {
            if (s && s.src) {
              out.push(s.src);
            }
          });

      } catch (e) {
        // Spieler nicht initialisiert.
        // Netzwerk-Fallback wird unten verwendet.
      }

      return out;
    });

    // Falls die API nichts geliefert hat:
    // Play drücken und Netzwerk-Requests abfangen.
    if (!buildResult([...sources, ...mediaUrls]).ok) {
      await page
        .click(
          ".jw-display-icon-playback, .jw-icon-playback, video",
          { timeout: 5000 }
        )
        .catch(() => {});

      await page.waitForTimeout(6000);
    }

    return buildResult([
      ...extractEncodedSources(await page.content()),
      ...sources,
      ...mediaUrls
    ]);

  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    res.end();
    return;
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (
    url.pathname === "/health" ||
    url.pathname === "/"
  ) {
    sendJson(res, 200, {
      ok: true,
      service: "voe-extractor",
      port: PORT
    });

    return;
  }

  if (url.pathname === "/resolve") {
    const target = url.searchParams.get("url");

    if (
      !target ||
      !/^https?:\/\//i.test(target)
    ) {
      sendJson(res, 400, {
        ok: false,
        error: "url missing"
      });

      return;
    }

    try {
      const result = await extractFromUrl(target);

      sendJson(
        res,
        result.ok ? 200 : 404,
        result
      );

    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(
          (error && error.message) || error
        )
      });
    }

    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `VOE extractor listening on http://0.0.0.0:${PORT}`
    );
  }
);
