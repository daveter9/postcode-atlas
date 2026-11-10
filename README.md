# Postcode Atlas (Nederland)

Typ een postcode: elk cijfer en elke letter zoomt verder in, van de negen regio's tot één
6-positie postcode met buurt, wijk en CBS-cijfers. Klikken op de kaart gaat een niveau dieper,
Backspace zoomt uit en Esc gaat terug naar heel Nederland. De postcode staat in de URL (`?pc=3512AB`).

Angular 22 (zoneless, signals), volledig statisch: er is geen backend.

## Ontwerp

- **Renderer in een Web Worker** (OffscreenCanvas), met een fallback op de main thread.
- **Overgangen in drie fasen**: selecteren → zoomen (van Wijk & Nuij) → subgebieden tonen. Teruggaan
  is dezelfde beweging omgekeerd.
- **Snel uitzoomen**: level-of-detail per zoomniveau, alleen de grenzen van het niveau eronder,
  en samengevoegde vlakken per groep ("dissolve").
- **Data op aanvraag**:
  | bestand | inhoud | grootte (brotli) | wanneer geladen |
  |---|---|---|---|
  | `data/pc4.<hash>.bin` | 4070 PC4-vlakken + namen | 375 kB | altijd (preload) |
  | `data/pc6-<hash>/<pc4>.bin` | PC6-vlakken, CBS-cijfers, buurt/wijk | ~6 kB per PC4 | bij 4 cijfers |
  | `data/adr-<hash>/<pc4>.bin` | alle BAG-adressen (straat, huisnummer, positie) | ~7 kB per PC4 | **nog niet gebruikt in de UI** |
- Alle bestanden hebben een hash in hun naam of map en mogen dus voor altijd gecachet worden.

## Gebruik

```bash
npm install
npm start                 # ontwikkelserver
npm run build             # productiebuild + .br/.gz (voor nginx)
node scripts/serve.mjs    # preview van de build, zelfde headers als nginx (poort 4300)
npm run perf:frames       # frametijden van de overgangen, desktop + mobiel (vereist een build)
```

### Data opnieuw genereren

Brondata komt in `data-raw/` (niet in git).

```bash
npm run data:fetch   # CBS PC4 (PDOK) + GeoNames
npm run data:build   # -> public/data/pc4.<hash>.bin
# handmatig in data-raw/ zetten:
#   cbs_pc6_2024_v2.gpkg  uit https://download.cbs.nl/postcode/2026-cbs_pc6_2024_v2.zip
#   gwb/*.csv             uit https://download.cbs.nl/postcode/pc6hnr20260801_gwb.zip
#   bag-light.gpkg        van https://service.pdok.nl/kadaster/bag/atom/downloads/bag-light.gpkg (7,8 GB)
npm run data:pc6     # -> public/data/pc6-<hash>/
npm run data:adr     # -> public/data/adr-<hash>/
```

## Deploy

### Cloudflare Pages (gratis)

`public/_headers` regelt de cache-headers (immutable voor JS, CSS en data), de CSP en het
content-type van de data. Upload **geen** `.br`/`.gz` (Cloudflare comprimeert zelf, en het gratis
plan staat maximaal 20.000 bestanden toe). Gebruik dus `build:pages`, niet `build`.

```bash
npx wrangler@4 login                       # eenmalig
npm run deploy:pages                       # ng build + wrangler pages deploy
```

Web Analytics: Pages-project → *Metrics* → *Web Analytics* → *Enable*. De CSP in `_headers` staat
het beacon-script van Cloudflare toe.

### nginx

`npm run build`, kopieer `dist/postcode-atlas/browser/` naar de server en gebruik `deploy/nginx.conf`.

## Nog te doen

- **Adressen tonen**: de data is gebouwd en de decoder (`decodeAdr`, `addressSummary` in
  `src/app/atlas/atlas-data.ts`) staat klaar. Nog nodig: in de renderer laden bij ≥5 tekens,
  puntjes met huisnummers en straatnamen tekenen in een PC6, en de straten en nummerreeksen in de
  infokaart tonen.
- **Tests**: `tests/frames.mjs` bestaat al. Nog toe te voegen: Lighthouse (scores en budgets),
  laadtijd en bytes bij eerste en herhaald bezoek (`performance.mark('map-ready')` staat er al),
  en een functionele e2e-test.
- **Mobiele frametijden**: desktop haalt bijna overal 60 fps. Mobiel (4× tragere CPU) zit bij de
  overgangen op landniveau nog op 40–75 ms per frame. Volgende stappen: lagere resolutie tijdens
  animaties en minder labelwerk per frame.

## Bronnen

- [CBS, statistische gegevens per postcode](https://www.cbs.nl/nl-nl/dossier/nederland-regionaal/geografische-data/gegevens-per-postcode) (PC4 via [PDOK](https://api.pdok.nl/cbs/postcode4/ogc/v1), PC6), CC BY 4.0
- [CBS, buurt, wijk en gemeente voor postcode-huisnummer](https://www.cbs.nl/nl-nl/maatwerk/2026/38/buurt-wijk-en-gemeente-2026-voor-postcode-huisnummer), CC BY 4.0
- [BAG via PDOK](https://service.pdok.nl/kadaster/bag/atom/bag.xml), CC0
- [GeoNames](https://www.geonames.org/) postal codes, CC BY 4.0
- Idee: [ZIP Code Atlas](https://www.rickwills.com/lab/zip) van Rick Wills
