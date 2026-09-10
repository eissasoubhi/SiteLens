async function auditOnePage(url, index, { navigate = true } = {}) {
  const pageId = `PAGE-${String(index).padStart(3,'0')}`;
  const folder = `pages/${String(index).padStart(3,'0')}__${slugForUrl(url)}`;
  const page = { pageId, url:safeUrl(url), finalUrl:null, title:'', screenshots:[], files:{}, error:null };
  report.pages.push(page);
  $('current').textContent = url;
  log('page', url);

  currentCapture = newCapture();
  const traceStarted = await startTrace();

  try {
    if (navigate) {
      await applyViewport(primaryViewport());
      await command('Page.navigate', { url });
      await waitForReady();
    } else {
      try { await evaluate(METRICS_SOURCE); } catch {}
      await sleep(config.settleMs);
    }
    if (stopped) throw new Error('Stopped by user');

    const info = await pageInfo();
    page.finalUrl = safeUrl(info.href || url);
    page.title = info.title || '';
    info.href = safeUrl(info.href || url);
    page.pageInfo = info;

    // The first completed navigation defines the effective crawl origin. Local dev
    // servers often redirect http->https, change host aliases, or move to another port.
    if (navigate && index === 1) {
      try {
        crawlBaseUrl = info.href || url;
        crawlOrigin = new URL(crawlBaseUrl).origin;
        report.origin = crawlOrigin;
        report.discovery.effectiveOrigin = crawlOrigin;
      } catch {}
    }

    // Discover before responsive screenshots can hide/unmount desktop navigation.
    const earlyDiscoveredLinks = navigate ? await discoverLinks() : [];

    if (index === 1) {
      const detected = await detectProjectInfo().catch(()=>null);
      if (detected) {
        report.project.appVersion = config.appVersion || detected.appVersion || null;
        report.project.gitCommit = config.gitCommit || detected.gitCommit || null;
        report.project.gitBranch = config.gitBranch || detected.gitBranch || null;
        report.project.generator = detected.generator || null;
      }
    }

    const dom = sanitizeDomResult(await domAudit());
    page.dom = dom;
    const perf = await performanceAudit();
    if (perf?.webVitalsObserved?.lcp?.url) perf.webVitalsObserved.lcp.url = safeUrl(perf.webVitalsObserved.lcp.url);
    for (const r of perf?.resources?.slowest || []) r.name = safeUrl(r.name || '');
    page.performance = perf;
    const a11y = await accessibilityAudit();
    page.accessibility = a11y;
    const design = await designSystemAudit();
    page.designSystem = design;
    const rawDom = await rawDomSnapshot();

    // A failed viewport must not cancel the other screenshots or the whole page audit.
    for (const profile of viewportProfiles()) {
      if (stopped) break;
      try {
        const shot = await captureScreenshot(profile, folder);
        page.screenshots.push(shot);
        log('capture', `${profile.label} — ${url}`, 'ok');
      } catch (error) {
        stats.errors += 1;
        const detail = redactText(error?.message || String(error));
        report.errors.push({ pageId, url:safeUrl(url), type:'screenshot-failed', profile:profile.id, message:detail });
        log('capture', `${profile.label} — ${url} — ${detail}`, 'fail');
      }
      updateUi(stats.queued);
    }

    const trace = await stopTrace(traceStarted);
    const network = Object.values(currentCapture.network).map((x) => ({ ...x, url:safeUrl(x.url||''), documentURL:safeUrl(x.documentURL||'') }));
    page.console = currentCapture.console;
    page.network = network;
    page.consoleSummary = consoleSummary(page.console);
    page.networkSummary = networkSummary(network);
    page.score = scorePage(page);

    page.files = {
      page: `${folder}/page.json`, console: `${folder}/console.json`, network: `${folder}/network.json`,
      performance: perf ? `${folder}/performance.json` : null,
      accessibility: a11y ? `${folder}/accessibility.json` : null,
      dom: dom ? `${folder}/dom.json` : null,
      designSystem: design ? `${folder}/design-system.json` : null,
      rawDomSnapshot: rawDom ? `${folder}/raw-dom-snapshot.json` : null,
      trace: trace ? `${folder}/trace.json` : null
    };

    zip.add(page.files.console, JSON.stringify({ summary:page.consoleSummary, entries:page.console }, null, 2));
    zip.add(page.files.network, JSON.stringify({ summary:page.networkSummary, requests:network }, null, 2));
    if (perf) zip.add(page.files.performance, JSON.stringify(perf, null, 2));
    if (a11y) zip.add(page.files.accessibility, JSON.stringify(a11y, null, 2));
    if (dom) zip.add(page.files.dom, JSON.stringify(dom, null, 2));
    if (design) zip.add(page.files.designSystem, JSON.stringify(design, null, 2));
    if (rawDom) zip.add(page.files.rawDomSnapshot, JSON.stringify(rawDom));
    if (trace) zip.add(page.files.trace, JSON.stringify(trace));

    const lateDiscoveredLinks = navigate ? await discoverLinks().catch(() => []) : [];
    const discoveredMap = new Map();
    for (const item of [...earlyDiscoveredLinks, ...lateDiscoveredLinks]) {
      if (item?.url && !discoveredMap.has(item.url)) discoveredMap.set(item.url, item);
    }
    page.discovery = { candidates: discoveredMap.size };

    const pageForFile = { ...page };
    delete pageForFile.console; delete pageForFile.network; delete pageForFile.dom;
    delete pageForFile.performance; delete pageForFile.accessibility; delete pageForFile.designSystem;
    zip.add(page.files.page, JSON.stringify(pageForFile, null, 2));

    log('audit', `${page.score.scores.overall ?? '—'}/100 — ${url} · ${discoveredMap.size} route(s) candidate(s)`, 'ok');
    return { page, discoveredLinks: [...discoveredMap.values()] };
  } catch (e) {
    const trace = await stopTrace(traceStarted).catch(()=>null);
    page.error = e?.message || String(e);
    stats.errors++;
    report.errors.push({ pageId, url:safeUrl(url), message:page.error });
    if (trace) zip.add(`${folder}/trace.partial.json`, JSON.stringify(trace));
    log('erreur', `${url} — ${page.error}`, 'fail');
    return { page, discoveredLinks: [] };
  } finally {
    currentCapture = null;
  }
}

async function crawl() {
  const ignore = parseLines(config.ignorePatterns);
  const queue = [];
  const queued = new Set();
  const visited = new Set();
  let sitewideSeeded = false;
  let extraRoutesSeeded = false;

  const reject = (raw, source, reason) => {
    report.discovery.duplicateOrFiltered += 1;
    if (report.discovery.rejected.length < 500) report.discovery.rejected.push({ raw:redactText(raw || ''), source, reason });
  };

  const enqueue = (candidate, source = 'unknown') => {
    const raw = typeof candidate === 'string' ? candidate : candidate?.url;
    const src = typeof candidate === 'string' ? source : (candidate?.source || source);
    report.discovery.candidatesFound += 1;
    report.discovery.bySource[src] = (report.discovery.bySource[src] || 0) + 1;
    if (!raw) return reject('', src, 'empty');
    const normalized = normalizeUrl(raw, crawlBaseUrl || config.startUrl);
    if (!normalized) return reject(raw, src, 'outside-effective-origin-or-invalid');
    if (queued.has(normalized)) return reject(raw, src, 'already-queued');
    if (visited.has(normalized)) return reject(raw, src, 'already-visited');
    if (shouldIgnore(normalized, ignore)) return reject(raw, src, 'ignore-pattern');
    queued.add(normalized);
    queue.push(normalized);
    report.discovery.enqueued += 1;
  };

  // Only seed the start URL before navigation. Relative manual routes are normalized
  // after the effective origin has been established from the first loaded page.
  enqueue(config.startUrl, 'start-url');
  updateUi(queue.length);

  while (queue.length && report.pages.length < config.maxPages && !stopped && !detachedUnexpectedly) {
    const url = queue.shift();
    queued.delete(url);
    visited.add(url);
    stats.visited = report.pages.length + 1;
    updateUi(queue.length);

    const { page, discoveredLinks } = await auditOnePage(url, report.pages.length + 1, { navigate:true });

    if (page?.finalUrl) {
      const finalNormalized = normalizeUrl(page.finalUrl, crawlBaseUrl || config.startUrl);
      if (finalNormalized) visited.add(finalNormalized);
    }

    if (!extraRoutesSeeded) {
      extraRoutesSeeded = true;
      for (const extra of parseLines(config.extraRoutes)) enqueue(extra, 'extra-route');
    }

    for (const link of discoveredLinks) enqueue(link, 'page');

    if (!sitewideSeeded) {
      sitewideSeeded = true;
      const sitewide = await discoverSitewideLinks();
      for (const link of sitewide) enqueue(link, 'sitemap');
      if (sitewide.length) log('discovery', `${sitewide.length} route(s) trouvée(s) via sitemap/robots`, 'ok');
    }

    updateUi(queue.length);
  }

  report.discovery.maxPagesReached = queue.length > 0 && report.pages.length >= config.maxPages;
  stats.visited = report.pages.length;
  return { remaining:[...queue], visited:[...visited] };
}

async function captureCurrentState() {
  stats.visited = 1;
  updateUi(0);
  const info = await pageInfo();
  const url = info?.href || config.startUrl;
  await auditOnePage(url, 1, { navigate:false });
  return { remaining:[], visited:[url] };
}

function escaped(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function buildZipDashboard() {
  const cards = report.pages.map((p) => {
    const shot = p.screenshots?.find(s=>s.profile==='desktop-1440x900') || p.screenshots?.[0];
    const issues = [
      ...(p.dom?.uiIssues || []).slice(0,3).map(x=>x.type),
      ...(p.accessibility?.violations || []).slice(0,3).map(x=>x.rule)
    ];
    return `<article class="page-card">
      ${shot ? `<a href="../${escaped(shot.file)}"><img loading="lazy" src="../${escaped(shot.file)}" alt="${escaped(p.title || p.url)}"></a>` : '<div class="no-shot">No screenshot</div>'}
      <div class="copy"><div class="row"><strong>${escaped(p.title || '(sans titre)')}</strong><b>${p.score?.scores?.overall ?? '—'}</b></div><a href="${escaped(p.url)}">${escaped(p.url)}</a><p>${escaped(issues.join(' · ') || 'No priority issue detected')}</p></div>
    </article>`;
  }).join('\n');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(report.diagnosticId)}</title><style>
  body{font:14px system-ui;margin:0;background:#f5f6f8;color:#17191d}main{max-width:1500px;margin:auto;padding:24px}h1{margin:0}.meta{color:#667085}.scores{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.score{background:white;border:1px solid #ddd;border-radius:10px;padding:10px 14px}.score b{font-size:22px;display:block}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.page-card{background:white;border:1px solid #ddd;border-radius:12px;overflow:hidden}.page-card img{width:100%;height:auto;display:block;background:#eee}.copy{padding:12px}.row{display:flex;justify-content:space-between;gap:8px}.row b{font-size:20px}.copy a{display:block;color:#175cd3;word-break:break-all;margin-top:5px}.copy p{color:#667085;font-size:12px}.no-shot{height:180px;display:grid;place-items:center;background:#eee;color:#777}</style></head><body><main>
  <h1>${escaped(report.project.name || 'Site')} — ${escaped(report.diagnosticId)}</h1><p class="meta">${escaped(report.mode.toUpperCase())} · ${escaped(report.startedAt)} · ${escaped(report.origin)}</p>
  <div class="scores">${['overall','ui','performance','accessibility','console','network'].map(k=>`<div class="score"><span>${k}</span><b>${report.scores[k] ?? '—'}</b></div>`).join('')}</div>
  <p><strong>${report.summary.pagesVisited}</strong> pages · <strong>${report.summary.captures}</strong> screenshots · <strong>${report.summary.consoleErrors}</strong> JS errors · <strong>${report.summary.failedRequests}</strong> failed requests · <strong>${report.summary.accessibilityViolations}</strong> accessibility findings</p>
  <div class="grid">${cards}</div></main></body></html>`;
}

function buildAiInstructions() {
  return `# AI review instructions\n\nThis archive is diagnostic **${report.diagnosticId}** for **${report.project.name || report.origin}**.\n\nAnalyze the archive as a frontend/product review. Correlate screenshots with structured per-page data. Prioritize:\n\n1. UI consistency and design-system drift\n2. UX/navigation clarity and confusing states\n3. Responsive problems and horizontal overflow\n4. Accessibility findings\n5. JavaScript console errors and warnings\n6. Network failures and slow requests\n7. Performance / observed Web Vitals and long tasks\n8. Broken assets, headings, forms, semantic structure and UI microcopy/content clarity\n9. User-provided UX annotations in ux-annotations.json\n10. Concrete improvements ranked by severity and impact\n\nImportant interpretation notes:\n- Performance is a local/lab observation, not field data.\n- INP can be absent when the crawler did not perform real interactions.\n- Network request/response bodies, cookies and Authorization headers are intentionally not collected.\n- Raw DOM snapshots are ${config.rawDomSnapshot ? 'included because the user explicitly enabled them' : 'not included by default for privacy'}.\n- If summary.maxPagesReached is true, inspect global/discovery.json for unvisited routes.\n- The health score is deterministic and diagnostic, not a substitute for human product judgment.\n\nWhen comparing with another archive, use diagnosticId and parentDiagnosticId to identify sequence and report regressions/improvements.\n`;
}

async function includeAnnotations() {
  const { uxAnnotations = [] } = await chrome.storage.local.get('uxAnnotations');
  const relevant = uxAnnotations.filter(x=>x.origin===report.origin);
  report.annotations = relevant.map(({screenshotDataUrl, ...rest})=>({ ...rest, url:safeUrl(rest.url || '') }));
  const exportList = [];
  for (const a of relevant) {
    let screenshotFile = null;
    if (a.screenshotDataUrl) {
      screenshotFile = `annotations/${a.id}.png`;
      zip.add(screenshotFile, dataUrlToBytes(a.screenshotDataUrl));
    }
    exportList.push({ ...a, url:safeUrl(a.url || ''), screenshotDataUrl: undefined, screenshotFile });
  }
  zip.add('ux-annotations.json', JSON.stringify(exportList, null, 2));
}

function closeRunnerAfterDownload(downloadId, blobUrl) {
  const cleanup = async () => {
    try { URL.revokeObjectURL(blobUrl); } catch {}
    try { chrome.downloads.onChanged.removeListener(listener); } catch {}
    try { const tab=await chrome.tabs.getCurrent(); if (tab?.id) await chrome.tabs.remove(tab.id); } catch {}
  };
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.error?.current) cleanup();
  };
  chrome.downloads.onChanged.addListener(listener);
  setTimeout(cleanup, 600000);
}

async function finalize(crawlState = {}) {
  if (finalized) return;
  finalized = true;
  report.finishedAt = new Date().toISOString();
  report.stoppedByUser = stopped;
  report.remainingQueue = crawlState.remaining || [];
  await includeAnnotations();
  report.summary = aggregateSummary(report.pages);
  report.summary.routesDiscovered = report.discovery.enqueued;
  report.summary.routesRemaining = report.remainingQueue.length;
  report.summary.maxPagesReached = report.discovery.maxPagesReached;
  report.scores = aggregateScores(report.pages);
  report.topIssues = buildTopIssues(report.pages);

  const routes = report.pages.map((p)=>({pageId:p.pageId,url:p.url,finalUrl:p.finalUrl,title:p.title,score:p.score?.scores?.overall ?? null,screenshots:p.screenshots?.length||0,error:p.error}));
  const screenshotsGlobal = report.pages.flatMap(p => (p.screenshots || []).map(s => ({ pageId:p.pageId, url:p.url, title:p.title, ...s })));
  const consoleGlobal = { errors:report.summary.consoleErrors,warnings:report.summary.consoleWarnings,pages:report.pages.map(p=>({pageId:p.pageId,url:p.url,...p.consoleSummary})) };
  const networkGlobal = { requests:report.summary.networkRequests,failed:report.summary.failedRequests,pages:report.pages.map(p=>({pageId:p.pageId,url:p.url,...p.networkSummary})) };
  const a11yGlobal = { violations:report.summary.accessibilityViolations,pages:report.pages.map(p=>({pageId:p.pageId,url:p.url,summary:p.accessibility?.summary||null})) };
  const perfGlobal = { pages:report.pages.map(p=>({pageId:p.pageId,url:p.url,lcp:p.performance?.webVitalsObserved?.lcp?.value??null,cls:p.performance?.webVitalsObserved?.cls??null,inp:p.performance?.webVitalsObserved?.inp?.value??null,fcp:p.performance?.paints?.['first-contentful-paint']??null,score:p.score?.scores?.performance??null})) };
  const designGlobal = aggregateDesignSystem(report.pages);
  const uiGlobal = aggregateUi(report.pages);
  const pageScores = report.pages.map(p=>({pageId:p.pageId,url:p.url,title:p.title,scores:p.score?.scores||null,reasons:p.score?.reasons||null}));

  zip.add('manifest.json', JSON.stringify({ diagnosticId:report.diagnosticId,parentDiagnosticId:report.parentDiagnosticId,createdAt:report.startedAt,finishedAt:report.finishedAt,timezone:report.timezone,collector:report.collector,application:report.project,origin:report.origin,startUrl:safeUrl(report.startUrl),mode:report.mode }, null, 2));
  zip.add('summary.json', JSON.stringify({ diagnosticId:report.diagnosticId,parentDiagnosticId:report.parentDiagnosticId,summary:report.summary,scores:report.scores,topIssues:report.topIssues,errors:report.errors }, null, 2));
  zip.add('global/routes.json', JSON.stringify(routes, null, 2));
  zip.add('global/discovery.json', JSON.stringify({ ...report.discovery, remainingQueue:report.remainingQueue }, null, 2));
  zip.add('global/screenshots.json', JSON.stringify({ total:screenshotsGlobal.length, screenshots:screenshotsGlobal }, null, 2));
  zip.add('global/console-summary.json', JSON.stringify(consoleGlobal, null, 2));
  zip.add('global/network-summary.json', JSON.stringify(networkGlobal, null, 2));
  zip.add('global/accessibility-summary.json', JSON.stringify(a11yGlobal, null, 2));
  zip.add('global/performance-summary.json', JSON.stringify(perfGlobal, null, 2));
  zip.add('global/design-system-summary.json', JSON.stringify(designGlobal, null, 2));
  zip.add('global/ui-summary.json', JSON.stringify(uiGlobal, null, 2));
  zip.add('global/page-scores.json', JSON.stringify(pageScores, null, 2));
  zip.add('AI_INSTRUCTIONS.md', buildAiInstructions());
  zip.add('report/index.html', buildZipDashboard());
  zip.add('README.md', `# SiteLens\n\nDiagnostic: **${report.diagnosticId}**\n\n- Project: ${report.project.name || ''}\n- Origin: ${report.origin}\n- Mode: ${report.mode}\n- Collector: ${report.collector.version}\n- Pages: ${report.summary.pagesVisited}\n- Routes discovered/enqueued: ${report.summary.routesDiscovered}\n- Routes remaining after cap/stop: ${report.summary.routesRemaining}\n- Screenshots: ${report.summary.captures}\n- Overall diagnostic score: ${report.scores.overall ?? 'n/a'}/100\n\nOpen \`report/index.html\` for a visual overview. Start an AI review with \`AI_INSTRUCTIONS.md\`, \`summary.json\` and then drill into \`pages/\`.\n\nPrivacy: request/response bodies, cookies, Authorization headers and form values are not collected. Raw DOM snapshot is ${config.rawDomSnapshot ? 'ENABLED' : 'disabled'}.\n`);

  try { await command('Emulation.clearDeviceMetricsOverride'); } catch {}
  try { await chrome.debugger.detach(debuggee); } catch {}
  if (!config.useExistingTab && targetTabId) { try { await chrome.tabs.remove(targetTabId); } catch {} }

  const blob = zip.blob();
  const blobUrl = URL.createObjectURL(blob);
  const host = (()=>{try{return new URL(config.startUrl).hostname.replace(/[^a-z0-9.-]/gi,'-')}catch{return 'site'}})();
  const filename = `${host}-diagnostic_${report.diagnosticId}.zip`;
  const downloadId = await chrome.downloads.download({ url:blobUrl, filename, saveAs:true });
  closeRunnerAfterDownload(downloadId, blobUrl);

  const { diagnosticHistory = [] } = await chrome.storage.local.get('diagnosticHistory');
  const historyItem = { diagnosticId:report.diagnosticId,parentDiagnosticId:report.parentDiagnosticId,projectName:report.project.name,host,origin:report.origin,mode:report.mode,startedAt:report.startedAt,finishedAt:report.finishedAt,collectorVersion:report.collector.version,project:report.project,summary:report.summary,scores:report.scores,topIssues:report.topIssues.slice(0,25),filename };
  const next = [historyItem, ...diagnosticHistory.filter(x=>x.diagnosticId!==historyItem.diagnosticId)].slice(0,30);
  await chrome.storage.local.set({ diagnosticHistory:next, captureStatus:{state:'done',diagnosticId:report.diagnosticId,mode:report.mode,visited:stats.visited,captures:stats.captures,errors:stats.errors,queued:0,progress:100,currentPage:'Terminé',filename} });

  $('title').textContent = stopped ? 'Diagnostic arrêté — ZIP exporté' : 'Diagnostic terminé — ZIP exporté';
  $('current').textContent = filename;
  $('summary').textContent = `${report.summary.pagesVisited} page(s), ${report.summary.captures} capture(s), score ${report.scores.overall ?? '—'}/100. Diagnostic ID: ${report.diagnosticId}`;
  $('progress').style.width = '100%';
  $('stop').textContent = 'Terminé';
  $('stop').disabled = true;
}

async function main() {
  const stored = await chrome.storage.local.get(['captureJob','diagnosticHistory']);
  const job = stored.captureJob;
  if (!job?.config || !job?.targetTabId) {
    $('title').textContent = 'Aucun diagnostic à exécuter';
    $('summary').textContent = 'Lance un diagnostic depuis le Side Panel.';
    $('stop').disabled = true;
    return;
  }

  config = { ...job.config, useExistingTab:Boolean(job.useExistingTab) };
  targetTabId = job.targetTabId;
  debuggee = { tabId:targetTabId };
  report.origin = new URL(config.startUrl).origin;
  report.startUrl = config.startUrl;
  report.mode = config.mode || 'full';
  report.project = { name:config.projectName || new URL(config.startUrl).hostname, gitBranch:config.gitBranch || null, gitCommit:config.gitCommit || null, appVersion:null };
  report.config = { ...config, extraRoutes:parseLines(config.extraRoutes), ignorePatterns:parseLines(config.ignorePatterns) };
  const parent = (stored.diagnosticHistory || []).find(x=>x.origin===report.origin);
  report.parentDiagnosticId = parent?.diagnosticId || null;
  report.diagnosticId = `${projectCode(config.projectName, report.origin)}-${localStamp()}-${randomHex()}`;
  $('title').textContent = `${report.project.name} — ${report.diagnosticId}`;
  await chrome.storage.local.set({ captureStatus:{state:'running',diagnosticId:report.diagnosticId,mode:report.mode,visited:0,captures:0,errors:0,queued:0,progress:0,currentPage:config.startUrl} });

  try {
    await chrome.debugger.attach(debuggee, '0.1');
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    await command('Log.enable');
    await command('Performance.enable');
    await command('Accessibility.enable').catch(()=>{});
    await command('Page.addScriptToEvaluateOnNewDocument', { source:METRICS_SOURCE });
    if (job.singlePage) { try { await evaluate(METRICS_SOURCE); } catch {} }
    const state = job.singlePage ? await captureCurrentState() : await crawl();
    await finalize(state);
  } catch (e) {
    stats.errors++;
    report.errors.push({ fatal:true, url:safeUrl(config.startUrl), message:e?.message || String(e) });
    log('fatal', e?.message || String(e), 'fail');
    try { await finalize({remaining:[]}); }
    catch (finalError) {
      await chrome.storage.local.set({ captureStatus:{state:'failed',diagnosticId:report.diagnosticId,mode:report.mode,visited:stats.visited,captures:stats.captures,errors:stats.errors,progress:100,currentPage:finalError?.message || String(finalError)} });
    }
  } finally {
    await chrome.storage.local.remove('captureJob');
  }
}

main();
