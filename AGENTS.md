# SiteLens development rules

- Keep the extension Manifest V3 compatible and local-first by default.
- A Full diagnostic must crawl same-origin routes until the queue is empty or `maxPages` is reached; never silently downgrade to a single-page audit.
- Every successfully audited page must attempt every selected screenshot profile and record the PNG in `global/screenshots.json`.
- Never export cookies, Authorization headers, request/response bodies, or form values by default.
- Treat redirects carefully: crawl against the effective origin reached by the first navigation.
- Keep crawl URL normalization deterministic and covered by tests.
- Do not click destructive or unknown controls during automatic exploration. Route discovery should be passive unless a future scenario explicitly opts in to an interaction.
- UI copy must be reviewed as a Content Designer / UX Writer: short, clear, non-technical when possible, and consistent across the side panel and reports.
- Keep Full as the default mode. User-edited settings must persist across side-panel reopenings.
- Run `npm run check` and `npm test` before merging.
