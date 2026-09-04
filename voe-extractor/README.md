# VOE-Extractor (Headless-Browser für die neuen VOE-Spiegel)

Die neuen VOE-Spiegel-Seiten (z. B. tracylocalschool.com) liefern nur noch
ein verschlüsseltes Laufzeit-Skript – die Video-URL entsteht erst im Browser.
FlareSolverr reicht nicht, weil es nicht klicken und keine Player-API auslesen
kann. Dieser Dienst nutzt Playwright und liest die Quelle direkt aus der
JW-Player-API, ohne den Film abzuspielen.

## Deploy auf Render.com (Docker)
1. Render Dashboard → **New → Web Service** → dieses Verzeichnis (oder ein
   Repo mit `src/voe-extractor/` als Root) → Runtime: **Docker**.
2. Port: `8192`.
3. Nach dem Deploy testen:
   `https://<service>.onrender.com/health`
   und
   `https://<service>.onrender.com/resolve?url=https://voe.sx/8p6chql55lp5`

## Dann am Filmpalast-Resolver eintragen
Umgebungsvariable setzen und neu deployen:

```
VOE_EXTRACTOR_URL=https://<service>.onrender.com
```

Der Resolver ruft den Extractor automatisch auf, wenn die statische
VOE-Auflösung scheitert, und schickt die gefundene m3u8 anschließend über
`/proxy?u=...` an den TV.

## Wichtig
- Die IP des Extractors muss für VOE die "gleiche" sein wie die des
  Streaming-Proxys – am einfachsten beides auf Render betreiben (gleiche
  Region) oder den `/proxy`-Endpunkt des Resolvers für die Wiedergabe nutzen.