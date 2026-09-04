/* global require, process, console */
// VOE-Extractor – Headless-Browser-Dienst (Playwright) für die neuen
// VOE-Spiegel-Seiten: Die Video-URL steht nicht im HTML, sondern wird erst
// zur Laufzeit vom verschlüsselten Player-Skript erzeugt. Dieser Dienst
// liest die Quelle direkt aus der JW-Player-API aus, ohne Play-Klick.
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
const SUPPORTED_VIDEO_RE = /.(m3u8|mp4|webm)(?:[?#]|$)/i;
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
async function extractFromUrl(targetUrl) {
const browser = await chromium.launch({
args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"]
});
try {
const context = await browser.newContext({
userAgent: UA,
viewport: { width: 1280, height: 720 },
extraHTTPHeaders: { referer: "https://filmpalast.to/" }
});
const page = await context.newPage();
    // Netzwerk-Capture als Fallback: alle Media-Requests mitlesen.
    const mediaUrls = [];
    page.on("request", (req) => {
      const u = req.url();
      if (/\.(m3u8|mp4)(?:[?#]|$)/i.test(u)) mediaUrls.push(u);
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page
      .waitForSelector(".jwplayer, video", { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(3000);

    // JW-Player-API: Die Playlist enthält die direkte Quelle (meist HLS).
    const sources = await page.evaluate(() => {
      const out = [];
      try {
        if (window.jwplayer) {
          const el = document.querySelector(".jwplayer");
          if (el && el.id) {
            const player = window.jwplayer(el.id);
            const playlist = (player.getPlaylist && player.getPlaylist()) || [];
            for (const item of playlist) {
              if (item && item.file) out.push(item.file);
              for (const s of (item && item.sources) || []) {
                if (s && s.file) out.push(s.file);
              }
            }
            if (!out.length) {
              const current = player.getPlaylistItem && player.getPlaylistItem();
              if (current && current.file) out.push(current.file);
            }
          }
        }
        const video = document.querySelector("video");
        if (video && video.src) out.push(video.src);
        document.querySelectorAll("video source").forEach((s) => {
          if (s && s.src) out.push(s.src);
        });
      } catch (e) {
        // Spieler nicht initialisiert -> Netzwerk-Fallback unten.
      }
      return out;
    });

    // Falls die API nichts geliefert hat: Play drücken und die
    // Netzwerk-Requests mit dem m3u8/mp4 abfangen.
    if (!sources.length && !mediaUrls.length) {
      await page
        .click(".jw-display-icon-playback, .jw-icon-playback, video", { timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(6000);
    }

    const all = [...new Set([...sources, ...mediaUrls])]
      .filter((u) => SUPPORTED_VIDEO_RE.test(u) && !/^blob:/i.test(u));
    const best =
      all.find((u) => /\.m3u8/i.test(u)) || all.find((u) => /\.mp4/i.test(u)) || "";
    return { ok: !!best, videoUrl: best, sources: all.slice(0, 6) };
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
const url = new URL(req.url, `http://${req.headers.host}`);
if (url.pathname === "/health" || url.pathname === "/") {
sendJson(res, 200, { ok: true, service: "voe-extractor", port: PORT });
return;
}
if (url.pathname === "/resolve") {
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    sendJson(res, 400, { ok: false, error: "url missing" });
    return;
  }
try {
const result = await extractFromUrl(target);
sendJson(res, result.ok ? 200 : 404, result);
} catch (error) {
sendJson(res, 500, {
ok: false,
error: String((error && error.message) || error)
});
}
return;
}
sendJson(res, 404, { ok: false, error: "Not found" });
});
server.listen(PORT, "0.0.0.0", () => {
console.log(`VOE extractor listening on http://0.0.0.0:${PORT}`);
});
