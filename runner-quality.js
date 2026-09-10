// Quality guards layered on top of the core collectors. Keep scoring focused on
// the diagnosed application and capture responsive failures explicitly.

function isBrowserExtensionUrl(value) {
  return /^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i.test(String(value || ''));
}

function consoleEntryUrls(entry) {
  const urls = [entry?.url, ...(entry?.stack || []).map((frame) => frame?.url)]
    .filter(Boolean)
    .map(String);
  const text = [entry?.text, ...(entry?.args || []).map((arg) => typeof arg === 'string' ? arg : '')].join(' ');
  const embedded = text.match(/(?:chrome-extension|moz-extension|safari-web-extension):\/\/[^\s)'\"]+/gi) || [];
  return [...urls, ...embedded];
}

function isBrowserExtensionConsoleEntry(entry) {
  const urls = consoleEntryUrls(entry);
  return urls.length > 0 && urls.every(isBrowserExtensionUrl);
}

function consoleSummary(items) {
  const observed = Array.isArray(items) ? items : [];
  const extensionItems = observed.filter(isBrowserExtensionConsoleEntry);
  const scored = observed.filter((item) => !isBrowserExtensionConsoleEntry(item));
  const errors = scored.filter((x) => x.level === 'error' || x.kind === 'exception').length;
  const warnings = scored.filter((x) => x.level === 'warning' || x.level === 'warn').length;
  return {
    total: scored.length,
    observedTotal: observed.length,
    browserExtensionEntries: extensionItems.length,
    errors,
    warnings
  };
}

function networkSummary(items) {
  const observed = Array.isArray(items) ? items : [];
  const extensionItems = observed.filter((x) => isBrowserExtensionUrl(x?.url));
  const scored = observed.filter((x) => !isBrowserExtensionUrl(x?.url));
  const failed = scored.filter((x) => x.failed).length;
  const status4xx = scored.filter((x) => x.status >= 400 && x.status < 500).length;
  const status5xx = scored.filter((x) => x.status >= 500).length;
  const totalBytes = scored.reduce((n, x) => n + (x.encodedDataLength || 0), 0);
  const slowest = [...scored]
    .filter((x) => Number.isFinite(x.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 20)
    .map((x) => ({ url: x.url, method: x.method, status: x.status, durationMs: x.durationMs, type: x.type }));
  return {
    total: scored.length,
    observedTotal: observed.length,
    browserExtensionRequests: extensionItems.length,
    failed,
    status4xx,
    status5xx,
    totalBytes,
    slowest
  };
}

async function responsiveAudit(profile) {
  const result = await evaluate(`(() => {
    const clip = (v, n=180) => String(v ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
    const selector = (el) => {
      try {
        if (!el) return null;
        if (el.id) return '#' + CSS.escape(el.id);
        const tid = el.getAttribute('data-testid');
        if (tid) return '[data-testid="' + CSS.escape(tid) + '"]';
        let s = el.localName || '*';
        const cls = [...(el.classList || [])].filter(x => /^[a-zA-Z_-][\\w-]*$/.test(x)).slice(0,2);
        if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
        return s;
      } catch { return el?.localName || null; }
    };
    const doc = document.documentElement;
    const body = document.body;
    const viewportWidth = innerWidth;
    const viewportHeight = innerHeight;
    const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
    const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);
    const offenders = [];
    for (const el of [...(body?.querySelectorAll('*') || [])]) {
      if (offenders.length >= 50) break;
      const r = el.getBoundingClientRect();
      const ownOverflow = el.scrollWidth > el.clientWidth + 2;
      const outsideViewport = r.width > 0 && (r.right > viewportWidth + 2 || r.left < -2);
      if (!ownOverflow && !outsideViewport) continue;
      offenders.push({
        selector: selector(el),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        text: clip(el.innerText || el.textContent || '')
      });
    }
    return {
      viewport: { width: viewportWidth, height: viewportHeight, devicePixelRatio },
      document: { scrollWidth, scrollHeight },
      horizontalOverflowPx: Math.max(0, scrollWidth - viewportWidth),
      hasHorizontalOverflow: scrollWidth > viewportWidth + 2,
      overflowElements: offenders
    };
  })()`);
  const expected = profile?.current ? null : { width: profile?.width ?? null, height: profile?.height ?? null };
  const actual = result?.viewport || {};
  const mismatch = expected ? {
    width: Number.isFinite(expected.width) && Math.abs((actual.width || 0) - expected.width) > 2,
    height: Number.isFinite(expected.height) && Math.abs((actual.height || 0) - expected.height) > 2
  } : { width: false, height: false };
  return { ...result, expectedViewport: expected, viewportMismatch: mismatch };
}

async function captureScreenshot(profile, folder) {
  await applyViewport(profile);
  await primeLazyContent();
  // Lazy-load priming and sticky elements can leave the document in a transient
  // scrolled state. Reset once more immediately before the audit/capture.
  try { await evaluate(`window.scrollTo(0, 0); true`); } catch {}
  await sleep(Math.min(500, Math.max(120, Math.round(config.settleMs / 3))));
  const info = await pageInfo();
  const responsive = await responsiveAudit(profile);

  let shot = null;
  let layout = null;
  let captureMethod = 'layout-metrics-viewport-width-clip';
  try {
    layout = await command('Page.getLayoutMetrics');
    const content = layout?.cssContentSize || layout?.contentSize;
    // A full-page image wider than the emulated viewport hides the fact that the
    // page overflows. Keep the PNG at viewport width and expose overflow in data.
    const width = Math.max(1, Math.ceil(info.viewport.width || profile.width || content?.width || info.document.width));
    const height = Math.max(1, Math.ceil(content?.height || info.document.height || info.viewport.height));
    shot = await command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      optimizeForSpeed: false,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });
  } catch (firstError) {
    captureMethod = 'capture-beyond-viewport-fallback';
    report.errors.push({ page:safeUrl(info.href || ''), type:'screenshot-retry', profile:profile.id, message:redactText(firstError?.message || String(firstError)) });
    await sleep(250);
    try { await evaluate(`window.scrollTo(0, 0); true`); } catch {}
    shot = await command('Page.captureScreenshot', { format:'png', fromSurface:true, captureBeyondViewport:true, optimizeForSpeed:false });
  }

  if (!shot?.data) throw new Error(`Chrome did not return screenshot data for ${profile.id}`);
  const bytes = base64ToBytes(shot.data);
  if (!isPng(bytes)) throw new Error(`Invalid PNG returned by Chrome for ${profile.id}`);

  const filename = `${folder}/screenshots/${profile.id}.png`;
  zip.add(filename, bytes);
  stats.captures += 1;
  return {
    file: filename,
    profile: profile.id,
    label: profile.label,
    byteLength: bytes.length,
    captureMethod,
    viewport: info.viewport,
    expectedViewport: responsive.expectedViewport,
    viewportMismatch: responsive.viewportMismatch,
    document: info.document,
    responsiveAudit: responsive,
    layoutContentSize: layout?.cssContentSize || layout?.contentSize || null
  };
}

const baseScorePage = scorePage;
scorePage = function scorePageWithResponsiveFindings(page) {
  const result = baseScorePage(page);
  const shots = page.screenshots || [];
  const overflowShots = shots.filter((shot) => shot.responsiveAudit?.hasHorizontalOverflow);
  const mismatches = shots.filter((shot) => shot.viewportMismatch?.width || shot.viewportMismatch?.height);

  if (overflowShots.length) {
    const penalty = Math.min(20, 8 + (overflowShots.length - 1) * 4);
    result.scores.ui = clamp((result.scores.ui ?? 100) - penalty, 0, 100);
    result.reasons.ui.push({
      penalty,
      reason: 'responsive-horizontal-overflow',
      detail: overflowShots.map((shot) => `${shot.profile}: +${shot.responsiveAudit.horizontalOverflowPx}px`).join(', ')
    });
  }
  if (mismatches.length) {
    const penalty = Math.min(12, mismatches.length * 4);
    result.scores.ui = clamp((result.scores.ui ?? 100) - penalty, 0, 100);
    result.reasons.ui.push({
      penalty,
      reason: 'viewport-mismatch',
      detail: mismatches.map((shot) => `${shot.profile}: expected ${shot.expectedViewport?.width}x${shot.expectedViewport?.height}, got ${shot.viewport?.width}x${shot.viewport?.height}`).join(', ')
    });
  }
  const available = Object.entries(result.scores)
    .filter(([key, value]) => key !== 'overall' && value != null)
    .map(([, value]) => value);
  result.scores.overall = available.length ? Math.round(available.reduce((a,b) => a+b, 0) / available.length) : null;
  return result;
};

const baseBuildTopIssues = buildTopIssues;
buildTopIssues = function buildTopIssuesWithResponsiveFindings(pages) {
  const base = baseBuildTopIssues(pages);
  const responsive = [];
  for (const page of pages) {
    for (const shot of page.screenshots || []) {
      if (shot.responsiveAudit?.hasHorizontalOverflow) {
        responsive.push({ severity:'serious', type:'responsive', title:'Horizontal overflow', page:page.url, detail:`${shot.profile}: document exceeds viewport by ${shot.responsiveAudit.horizontalOverflowPx}px` });
      }
      if (shot.viewportMismatch?.width || shot.viewportMismatch?.height) {
        responsive.push({ severity:'moderate', type:'capture', title:'Viewport mismatch', page:page.url, detail:`${shot.profile}: expected ${shot.expectedViewport?.width}x${shot.expectedViewport?.height}, got ${shot.viewport?.width}x${shot.viewport?.height}` });
      }
    }
  }
  return [...responsive, ...base].sort((a,b) => severityWeight(b.severity) - severityWeight(a.severity)).slice(0, 60);
};
