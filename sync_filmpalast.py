"""
Filmpalast-Scraper für GitHub Actions (kostenlos, geplant).
Nutzt cloudscraper, um die Cloudflare-JS-Challenge ohne Proxy zu bestehen,
und schreibt Katalog + Hoster in Supabase.

Env:
  SUPABASE_URL, SUPABASE_KEY   (service_role key)
  MOVIE_PAGES=20               wie viele /movies/new Seiten
  SERIES_LETTERS=ABCDEFGHIJKLMNOPQRSTUVWXYZ
  SCRAPE_HOSTERS=true          pro Film die Stream-Seite + Hoster holen
  DELAY=1                      Sekunden Pause zwischen Requests
"""
import os, re, sys, time
import cloudscraper
import requests

BASE = "https://filmpalast.to"
SB = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_KEY"]
PAGES = int(os.environ.get("MOVIE_PAGES", "20"))
SERIES_LETTERS = os.environ.get("SERIES_LETTERS", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
SCRAPE_HOSTERS = os.environ.get("SCRAPE_HOSTERS", "true").lower() == "true"
DELAY = float(os.environ.get("DELAY", "1"))

scr = cloudscraper.create_scraper(
    browser={"browser": "chrome", "platform": "windows", "mobile": False}
)
sess = requests.Session()
sess.headers.update({"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}",
                     "Content-Type": "application/json", "Accept": "application/json"})


def norm(u):
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("/"):
        return BASE + u
    return u


def slug(u):
    m = re.search(r"/stream/([^?#]+)", u or "")
    return m.group(1) if m else ""


def strip(v):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", v or "")).strip()


def parse_slider(html):
    out = []
    for m in re.finditer(r'<li[^>]*class="[^"]*slider-li[^"]*"[^>]*>([\s\S]*?)</li>', html):
        b = m.group(1)
        lm = re.search(r'href="([^"]*filmpalast\.to/stream/[^"#?]+)"', b)
        if not lm:
            continue
        u = norm(lm.group(1))
        s = slug(u)
        if not s:
            continue
        tm = re.search(r'<span class="title rb">([\s\S]*?)</span>', b)
        title = strip(tm.group(1)) if tm else s
        cm = re.search(r'<img[^>]*src="([^"]+\.(?:jpe?g|png|webp)[^"]*)"', b)
        cover = norm(cm.group(1)) if cm else f"{BASE}/files/movies/240/{s}.jpg"
        ym = re.search(r'class="releasedate"[^>]*>Jahr:\s*<b>(\d{4})</b>', b)
        dm = re.search(r'<div class="moviedescription">\s*<b>Beschreibung:</b>\s*([\s\S]*?)</div>', b)
        out.append({"id": s, "title": title, "type": "movie", "year": ym.group(1) if ym else "",
                    "poster": cover, "description": strip(dm.group(1)) if dm else "",
                    "url": u, "source": "new"})
    return out


def parse_articles(html, mtype):
    out, seen = [], set()
    for m in re.finditer(r'<article[^>]*class="[^"]*liste[^"]*"[^>]*>([\s\S]*?)</article>', html):
        b = m.group(1)
        am = re.search(r'<a[^>]*href="([^"]*/stream/[^"#?]+)"[^>]*>([\s\S]*?)</a>', b)
        if not am:
            continue
        u = norm(am.group(1))
        s = slug(u)
        if not s or s in seen:
            continue
        seen.add(s)
        title = strip(am.group(2)) or s
        ym = re.search(r"\((\d{4})\)", title)
        out.append({"id": s, "title": title, "type": mtype,
                    "year": ym.group(1) if ym else "",
                    "poster": f"{BASE}/files/movies/240/{s}.jpg",
                    "description": "", "url": u, "source": "alpha"})
    return out


def parse_hosters(html):
    out, seen = [], set()
    html = re.sub(r"<!--[\s\S]*?-->", "", html)
    for bm in re.finditer(r'<ul class="currentStreamLinks">([\s\S]*?)</ul>', html):
        b = bm.group(1)
        nm = re.search(r'<p class="hostName">([\s\S]*?)</p>', b)
        name = strip(nm.group(1)) if nm else ""
        name = re.sub(r"\s+(HD|SD|4K)$", "", name)
        dp = re.search(r'data-player-url="([^"]+)"', b)
        am = re.search(r'<a[^>]*href="(https?://[^"]+)"', b)
        raw = dp.group(1) if dp else (am.group(1) if am else "")
        u = norm(raw)
        if not u:
            continue
        k = f"{u}|{name}"
        if k in seen:
            continue
        seen.add(k)
        out.append({"name": name, "url": u})
    return out


def upsert_movies(rows):
    if not rows:
        return
    r = sess.post(f"{SB}/rest/v1/movies", json=rows,
                  headers={"Prefer": "resolution=merge-duplicates"})
    r.raise_for_status()


def set_hosters(s, hosters):
    sess.delete(f"{SB}/rest/v1/hosters?movie_slug=eq.{s}")
    if hosters:
        rows = [{"movie_slug": s, "name": h["name"], "url": h["url"]} for h in hosters]
        sess.post(f"{SB}/rest/v1/hosters", json=rows)


def fetch_hosters(movie):
    if not SCRAPE_HOSTERS:
        return
    try:
        r = scr.get(movie["url"], timeout=30)
        set_hosters(movie["id"], parse_hosters(r.text))
    except Exception as e:
        print("hosters", movie["id"], e, file=sys.stderr)


def main():
    movies = {}
    for p in range(1, PAGES + 1):
        url = f"{BASE}/movies/new" + (f"/page/{p}" if p > 1 else "")
        try:
            for m in parse_slider(scr.get(url, timeout=30).text):
                movies[m["id"]] = m
        except Exception as e:
            print("page", p, e, file=sys.stderr)
        time.sleep(DELAY)
    for L in SERIES_LETTERS:
        try:
            for m in parse_articles(scr.get(f"{BASE}/search/serien/alpha/{L}", timeout=30).text, "series"):
                movies[m["id"]] = m
        except Exception as e:
            print("series", L, e, file=sys.stderr)
        time.sleep(DELAY)
    rows = list(movies.values())
    upsert_movies(rows)
    print(f"upserted {len(rows)} movies")
    for m in rows:
        fetch_hosters(m)
        time.sleep(0.5)
    print("done")


if __name__ == "__main__":
    main()
