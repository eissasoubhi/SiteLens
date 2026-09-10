# SiteLens

SiteLens is a Chrome Manifest V3 extension that crawls a web application and exports a structured diagnostic archive for AI-assisted frontend review.

It is designed for local development apps such as JobPilot, but it can audit any HTTP/HTTPS site the user explicitly starts from. SiteLens stays on the effective origin of the crawl and collects enough browser context to correlate visual, UX and technical problems.

## What Full mode does

**Full is the default mode.** Starting from one URL, SiteLens builds a crawl queue and keeps visiting discovered same-origin routes until the queue is empty or the configured page cap is reached.

Route discovery currently combines:

- `<a href>` / `<area href>` links;
- common SPA route hints such as `data-route`, `data-href`, `data-url` and `to`;
- GET form actions;
- simple `location = ...` onclick navigation hints;
- `robots.txt` sitemap declarations;
- `/sitemap.xml` and `/sitemap_index.xml`;
- manually supplied additional routes.

Discovery happens before responsive viewport changes, so a mobile layout cannot accidentally hide the desktop navigation before routes are collected. The first completed navigation also establishes the **effective crawl origin**, which fixes local `http -> https`, hostname-alias and dev-port redirects.

## Per-page output

For every successfully audited route, SiteLens can collect:

- full-page PNG screenshots for Desktop `1440×900`, Tablet `768×1024` and Mobile `390×844` in Full mode;
- browser console errors, exceptions and warnings;
- network metadata (status, duration, resource type, transfer size and failures);
- Performance API/CDP metrics, observed LCP/CLS, FCP, TTFB and long tasks;
- accessibility findings and a Chrome accessibility-tree summary;
- semantic DOM information: headings, landmarks, links, buttons, forms (without values), images and overflow signals;
- design-system signals such as colors, typography, spacing, radii, shadows, CSS variables and media queries.

Screenshots are captured with Chrome DevTools Protocol using `Page.getLayoutMetrics` + `Page.captureScreenshot` and an explicit full-content clip. A fallback capture is retried if the first method fails. Each image is validated as PNG before it is added to the archive.

The archive contains `global/screenshots.json`, which lists every expected image with its page, viewport, file path and byte size. Missing screenshots therefore cannot disappear silently.

## Diagnostic archive

Typical structure:

```text
<site>-diagnostic_<DIAGNOSTIC_ID>.zip
├── manifest.json
├── summary.json
├── AI_INSTRUCTIONS.md
├── README.md
├── ux-annotations.json
├── report/
│   └── index.html
├── global/
│   ├── routes.json
│   ├── discovery.json
│   ├── screenshots.json
│   ├── page-scores.json
│   ├── console-summary.json
│   ├── network-summary.json
│   ├── accessibility-summary.json
│   ├── performance-summary.json
│   ├── design-system-summary.json
│   └── ui-summary.json
└── pages/
    └── 001__home/
        ├── page.json
        ├── console.json
        ├── network.json
        ├── performance.json
        ├── accessibility.json
        ├── dom.json
        ├── design-system.json
        └── screenshots/
            ├── desktop-1440x900.png
            ├── tablet-768x1024.png
            └── mobile-390x844.png
```

## Install locally

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository directory.
6. Open the site you want to audit.
7. Open SiteLens from the Chrome toolbar.
8. Keep **Full** selected and click **Crawl and diagnose**.

The Side Panel shows pages visited, routes waiting, screenshots produced and errors. The ZIP is downloaded only after the crawl finishes (or when the user explicitly stops it).

## Modes

- **Quick**: lighter crawl for fast feedback.
- **Full**: default; responsive screenshots + console + network + performance + accessibility + DOM + design-system context.
- **Deep**: Full plus more expensive browser diagnostics such as tracing/accessibility-tree details.

Full uses a default cap of 100 pages and the UI allows up to 500. Settings are saved to `chrome.storage.local` as soon as they are edited and restored on the next opening.

## Privacy and safety

By default SiteLens does **not** export:

- cookies;
- `Authorization` headers;
- raw HTTP headers;
- request or response bodies;
- form field values.

Sensitive-looking query parameters such as tokens, passwords, auth/session IDs, JWTs, API keys, signatures and codes are redacted in exported URLs.

Screenshots and accessibility text can still contain whatever is visibly rendered in the app, so diagnostics should be reviewed before sharing when the application contains sensitive data.

Automatic crawl discovery is passive: it does not click arbitrary buttons. Destructive paths such as logout/delete/remove are ignored by default.

## Diagnostic IDs

Each run gets an ID such as:

```text
JOBPILOT-20260905-204500-A31F
```

Exports also retain `parentDiagnosticId`, collector version, optional Git branch/commit metadata and app version when available. This makes two runs directly comparable.

## UX annotations and current-state capture

**Capture current state** diagnoses the exact state currently visible in the active tab, useful for modals, validation errors, open filters or other UI states that do not have their own route.

**Mark UX issue** lets the user select a rendered element and attach a note plus a cropped screenshot. These annotations are added to the next diagnostic for the same origin.

## Development

No runtime npm dependency is required.

```bash
npm run check
npm test
```

CI runs both commands on pull requests and pushes to `main`.

## Current reliability fixes

The initial prototype could finish after the first page and sometimes produce diagnostics without visible PNGs. The first repository version includes fixes for both failure modes:

1. crawl routes are discovered on the primary viewport before responsive rendering;
2. the effective post-redirect origin is used for same-origin filtering;
3. final redirected URLs are deduplicated;
4. screenshot capture uses explicit layout metrics, PNG validation and retry;
5. every generated image is indexed in `global/screenshots.json`;
6. discovery rejection reasons are retained in `global/discovery.json` for troubleshooting.
