// Export hardening: redact common secrets, make diagnostics reproducible and
// expose every responsive screenshot in the generated report.

const baseRedactTextForExport = redactText;
redactText = function redactDiagnosticText(value) {
  return baseRedactTextForExport(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\bmpc_ext_[A-Za-z0-9_-]{8,}(?:…)?\b/g, '[REDACTED_MPC_API_KEY]');
};

const baseSafeUrlForExport = safeUrl;
safeUrl = function safeDiagnosticUrl(raw) {
  return redactText(baseSafeUrlForExport(raw));
};

function exportableConfig() {
  return {
    mode: config?.mode || 'full',
    maxPages: config?.maxPages ?? null,
    settleMs: config?.settleMs ?? null,
    includeQuery: Boolean(config?.includeQuery),
    includeHash: Boolean(config?.includeHash),
    lazyScroll: Boolean(config?.lazyScroll),
    rawDomSnapshot: Boolean(config?.rawDomSnapshot),
    viewports: viewportProfiles().map((profile) => ({
      id: profile.id,
      label: profile.label,
      current: Boolean(profile.current),
      width: profile.width ?? null,
      height: profile.height ?? null,
      mobile: Boolean(profile.mobile)
    })),
    extraRoutes: parseLines(config?.extraRoutes).map((route) => safeUrl(route)),
    ignorePatterns: parseLines(config?.ignorePatterns).map((pattern) => redactText(pattern))
  };
}

function sanitizeDiscoveryUrl(raw) {
  if (!raw) return raw;
  try {
    const value = String(raw);
    const url = new URL(value, report?.origin || undefined);
    const appOrigin = report?.origin ? new URL(report.origin).origin : null;
    if (appOrigin && url.origin !== appOrigin) {
      return `${url.origin}/[REDACTED_EXTERNAL_PATH]`;
    }
    return safeUrl(url.href);
  } catch {
    return redactText(String(raw));
  }
}

function sanitizeDiscoveryForExport(discovery) {
  if (!discovery || typeof discovery !== 'object') return discovery;

  const sanitizeItem = (item) => {
    if (typeof item === 'string') return sanitizeDiscoveryUrl(item);
    if (!item || typeof item !== 'object') return item;
    const next = { ...item };
    for (const key of ['url', 'href', 'candidate', 'value']) {
      if (typeof next[key] === 'string') next[key] = sanitizeDiscoveryUrl(next[key]);
    }
    return next;
  };

  const next = { ...discovery };
  for (const key of ['rejected', 'candidates', 'remainingQueue', 'queued', 'discovered']) {
    if (Array.isArray(next[key])) next[key] = next[key].map(sanitizeItem);
  }
  return next;
}

function markdownForPage(page) {
  const lines = [
    `# ${redactText(page.title || page.pageId || 'Page')}`,
    '',
    `- URL: ${safeUrl(page.url || page.finalUrl || '')}`,
    `- Score: ${page.score?.scores?.overall ?? 'n/a'}/100`,
    `- Screenshots: ${(page.screenshots || []).length}`,
    `- JavaScript errors: ${page.consoleSummary?.errors || 0}`,
    `- Browser-extension console entries excluded from score: ${page.consoleSummary?.browserExtensionEntries || 0}`,
    `- Network requests scored: ${page.networkSummary?.total || 0}`,
    `- Browser-extension requests excluded from score: ${page.networkSummary?.browserExtensionRequests || 0}`,
    `- Accessibility findings: ${page.accessibility?.summary?.total || 0}`,
    ''
  ];

  const responsive = (page.screenshots || []).map((shot) => ({
    profile: shot.profile,
    overflow: shot.responsiveAudit?.horizontalOverflowPx || 0,
    mismatch: Boolean(shot.viewportMismatch?.width || shot.viewportMismatch?.height)
  }));
  if (responsive.length) {
    lines.push('## Responsive', '');
    for (const shot of responsive) {
      lines.push(`- ${shot.profile}: horizontal overflow ${shot.overflow}px${shot.mismatch ? ' · viewport mismatch' : ''}`);
    }
    lines.push('');
  }

  const reasons = Object.entries(page.score?.reasons || {})
    .flatMap(([category, items]) => (items || []).map((item) => ({ category, ...item })))
    .sort((a, b) => (b.penalty || 0) - (a.penalty || 0))
    .slice(0, 12);
  if (reasons.length) {
    lines.push('## Main findings', '');
    for (const item of reasons) lines.push(`- **${item.category}** — ${redactText(item.reason || '')}: ${redactText(item.detail || '')}`);
    lines.push('');
  }

  return lines.join('\n');
}

function exportHtmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function enhancedZipDashboard() {
  const cards = report.pages.map((page) => {
    const shots = (page.screenshots || []).map((shot) => `
      <figure class="shot">
        <a href="../${exportHtmlEscape(shot.file)}"><img loading="lazy" src="../${exportHtmlEscape(shot.file)}" alt="${exportHtmlEscape((page.title || page.url) + ' · ' + shot.label)}"></a>
        <figcaption>${exportHtmlEscape(shot.label || shot.profile)}${shot.responsiveAudit?.horizontalOverflowPx ? ` · overflow +${shot.responsiveAudit.horizontalOverflowPx}px` : ''}</figcaption>
      </figure>`).join('');
    const reasons = Object.entries(page.score?.reasons || {})
      .flatMap(([category, items]) => (items || []).map((item) => `${category}: ${item.reason}${item.detail ? ` — ${item.detail}` : ''}`))
      .slice(0, 4);
    const a11y = (page.accessibility?.violations || []).slice(0, 2).map((issue) => `a11y: ${issue.rule} — ${issue.detail}`);
    const findings = [...reasons, ...a11y].slice(0, 5);
    return `<article class="page-card">
      <div class="copy"><div class="row"><strong>${exportHtmlEscape(page.title || '(sans titre)')}</strong><b>${page.score?.scores?.overall ?? '—'}</b></div><a href="${exportHtmlEscape(page.url)}">${exportHtmlEscape(page.url)}</a><p>${exportHtmlEscape(findings.join(' · ') || 'No scored issue detected')}</p></div>
      <div class="shots">${shots || '<div class="no-shot">No screenshot</div>'}</div>
    </article>`;
  }).join('\n');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${exportHtmlEscape(report.diagnosticId)}</title><style>
  body{font:14px system-ui;margin:0;background:#f5f6f8;color:#17191d}main{max-width:1600px;margin:auto;padding:24px}h1{margin:0}.meta{color:#667085}.scores{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.score{background:white;border:1px solid #ddd;border-radius:10px;padding:10px 14px}.score b{font-size:22px;display:block}.grid{display:grid;gap:18px}.page-card{background:white;border:1px solid #ddd;border-radius:12px;overflow:hidden}.copy{padding:14px}.row{display:flex;justify-content:space-between;gap:8px}.row b{font-size:20px}.copy a{display:block;color:#175cd3;word-break:break-all;margin-top:5px}.copy p{color:#667085;font-size:12px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1px;background:#ddd}.shot{margin:0;background:#fff;min-width:0}.shot img{width:100%;height:auto;display:block;background:#eee}.shot figcaption{padding:8px 10px;color:#475467;font-size:12px}.no-shot{height:180px;display:grid;place-items:center;background:#eee;color:#777}.privacy{padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;color:#9a3412}</style></head><body><main>
  <h1>${exportHtmlEscape(report.project.name || 'Site')} — ${exportHtmlEscape(report.diagnosticId)}</h1><p class="meta">${exportHtmlEscape(report.mode.toUpperCase())} · ${exportHtmlEscape(report.startedAt)} · ${exportHtmlEscape(report.origin)}</p>
  <p class="privacy"><strong>Privacy:</strong> textual metadata redacts common e-mail/API-key patterns and external discovery paths. Screenshots can still contain visible sensitive information and must be reviewed before sharing.</p>
  <div class="scores">${['overall','ui','performance','accessibility','console','network'].map((key) => `<div class="score"><span>${key}</span><b>${report.scores[key] ?? '—'}</b></div>`).join('')}</div>
  <p><strong>${report.summary.pagesVisited}</strong> pages · <strong>${report.summary.captures}</strong> screenshots · <strong>${report.summary.consoleErrors}</strong> scored JS errors · <strong>${report.summary.failedRequests}</strong> failed requests · <strong>${report.summary.accessibilityViolations}</strong> accessibility findings</p>
  <div class="grid">${cards}</div></main></body></html>`;
}

const rawZipAdd = zip.add.bind(zip);
zip.add = function hardenedZipAdd(path, data) {
  let nextData = data;

  if (path === 'manifest.json' && typeof data === 'string') {
    try {
      const manifest = JSON.parse(data);
      nextData = JSON.stringify({
        ...manifest,
        config: exportableConfig(),
        privacy: {
          requestBodies: false,
          responseBodies: false,
          cookies: false,
          authorizationHeaders: false,
          formValues: false,
          textualEmailRedaction: true,
          textualApiKeyRedaction: true,
          externalDiscoveryPathsRedacted: true,
          screenshotsMayContainSensitivePixels: true
        }
      }, null, 2);
    } catch {}
  }

  if (path === 'global/discovery.json' && typeof data === 'string') {
    try {
      nextData = JSON.stringify(sanitizeDiscoveryForExport(JSON.parse(data)), null, 2);
    } catch {}
  }

  if (/^pages\/.+\/page\.json$/.test(path) && typeof data === 'string') {
    try {
      const page = JSON.parse(data);
      rawZipAdd(path.replace(/page\.json$/, 'page.md'), markdownForPage(page));
    } catch {}
  }

  if (path === 'report/index.html') nextData = enhancedZipDashboard();

  if (path === 'README.md' && typeof nextData === 'string') {
    nextData += '\n\n## Sharing safety\n\nTextual metadata redacts common e-mail and MPC API-key patterns. External URLs rejected during discovery keep their origin but not their path/query/fragment. Screenshots are visual evidence and can still show private information; review them before sharing an archive.\n';
  }

  return rawZipAdd(path, nextData);
};
