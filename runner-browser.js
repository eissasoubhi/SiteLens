function newCapture() {
  return { console: [], network: {}, activeRequests: 0, lastNetworkEventAt: Date.now() };
}

async function waitForReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !stopped) {
    try {
      const state = await evaluate(`({ ready: document.readyState, href: location.href })`);
      if (state?.ready === 'complete') break;
    } catch {}
    await sleep(150);
  }
  const idleDeadline = Date.now() + 5000;
  while (Date.now() < idleDeadline && !stopped) {
    if (!currentCapture || (currentCapture.activeRequests <= 0 && Date.now() - currentCapture.lastNetworkEventAt > 450)) break;
    await sleep(120);
  }
  try { await evaluate(`document.fonts?.ready?.then(() => true)`, true); } catch {}
  await sleep(config.settleMs);
}

async function startTrace() {
  if (!config.collect?.tracing) return false;
  traceBuffer = [];
  traceBytes = 0;
  traceTruncated = false;
  try {
    await command('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,loading',
      options: 'sampling-frequency=10000',
      transferMode: 'ReportEvents'
    });
    return true;
  } catch (e) {
    traceBuffer = null;
    report.errors.push({ message: `Tracing unavailable: ${e.message}` });
    return false;
  }
}

async function stopTrace(started) {
  if (!started || !traceBuffer) return null;
  const done = new Promise((resolve) => { traceResolve = resolve; });
  try { await command('Tracing.end'); } catch {}
  await Promise.race([done, sleep(5000)]);
  const result = { traceEvents: traceBuffer, truncated: traceTruncated, approxBytes: traceBytes };
  traceBuffer = null;
  traceResolve = null;
  return result;
}

function viewportProfiles() {
  const items = [];
  if (config.viewportCurrent) items.push({ id: 'current', label: 'Current viewport', current: true });
  if (config.viewportDesktop) items.push({ id: 'desktop-1440x900', label: 'Desktop 1440×900', width: 1440, height: 900, mobile: false });
  if (config.viewportTablet) items.push({ id: 'tablet-768x1024', label: 'Tablet 768×1024', width: 768, height: 1024, mobile: false });
  if (config.viewportMobile) items.push({ id: 'mobile-390x844', label: 'Mobile 390×844', width: 390, height: 844, mobile: true });
  return items;
}

function primaryViewport() {
  return viewportProfiles().find((x) => x.id === 'desktop-1440x900') || viewportProfiles()[0] || { current: true, id: 'current' };
}

async function applyViewport(profile) {
  if (profile.current) {
    await command('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await command('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    return;
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: 1,
    mobile: Boolean(profile.mobile)
  });
  await command('Emulation.setTouchEmulationEnabled', { enabled: Boolean(profile.mobile), maxTouchPoints: profile.mobile ? 5 : 1 }).catch(() => {});
  await sleep(220);
}

async function primeLazyContent() {
  if (!config.lazyScroll) return;
  try {
    await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.scrollTo(0,0); await sleep(60);
      let stable = 0, prev = 0;
      for (let i=0; i<20; i++) {
        const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const maxY = Math.max(0, h - innerHeight);
        window.scrollTo(0, Math.min(maxY, (i+1) * Math.round(innerHeight * .82)));
        await sleep(100);
        if (h === prev && scrollY >= maxY) stable++; else stable = 0;
        prev = h;
        if (stable >= 2) break;
      }
      window.scrollTo(0,0); await sleep(140); return true;
    })()`, true);
  } catch {}
}

async function pageInfo() {
  return evaluate(`(() => ({
    title: document.title || '',
    description: document.querySelector('meta[name="description"]')?.content || '',
    lang: document.documentElement.lang || '',
    href: location.href,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    document: {
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      nodes: document.getElementsByTagName('*').length
    }
  }))()`);
}

async function detectProjectInfo() {
  return evaluate(`(() => {
    const meta = (names) => {
      for (const n of names) {
        const el = document.querySelector('meta[name="'+n+'"],meta[property="'+n+'"]');
        if (el?.content) return el.content;
      }
      return null;
    };
    let runtimeVersion = null;
    try {
      runtimeVersion = typeof window.__APP_VERSION__ === 'string' ? window.__APP_VERSION__ : (typeof window.APP_VERSION === 'string' ? window.APP_VERSION : null);
    } catch {}
    return {
      appVersion: runtimeVersion || meta(['app-version','version','build-version']),
      gitCommit: meta(['git-commit','commit','build-commit']),
      gitBranch: meta(['git-branch','branch']),
      generator: document.querySelector('meta[name="generator"]')?.content || null
    };
  })()`);
}

async function discoverLinks() {
  const result = await evaluate(`(() => {
    const found = [];
    const add = (value, source) => {
      if (!value || typeof value !== 'string') return;
      const v = value.trim();
      if (!v || /^(javascript:|mailto:|tel:|data:)/i.test(v)) return;
      try { found.push({ url: new URL(v, location.href).href, source }); } catch {}
    };
    for (const a of document.querySelectorAll('a[href],area[href]')) add(a.href || a.getAttribute('href'), 'anchor');
    for (const el of document.querySelectorAll('[data-href],[data-url],[data-route],[to]')) {
      add(el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-route') || el.getAttribute('to'), 'spa-hint');
    }
    for (const form of document.querySelectorAll('form[action]')) {
      if ((form.method || 'get').toLowerCase() === 'get') add(form.action || form.getAttribute('action'), 'get-form');
    }
    for (const el of document.querySelectorAll('[onclick]')) {
      const code = el.getAttribute('onclick') || '';
      const m = code.match(/(?:location(?:\.href)?|window\.location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/i);
      if (m) add(m[1], 'onclick-location');
    }
    return found.slice(0, 10000);
  })()`);
  return Array.isArray(result) ? result : [];
}

async function discoverSitewideLinks() {
  try {
    const result = await evaluate(`(async () => {
      const urls = [];
      const seen = new Set();
      const add = (u, source) => { try { const x = new URL(u, location.origin).href; if (!seen.has(x)) { seen.add(x); urls.push({url:x, source}); } } catch {} };
      const fetchText = async (path) => {
        try { const r = await fetch(path, { credentials:'same-origin', cache:'no-store' }); return r.ok ? await r.text() : ''; } catch { return ''; }
      };
      const robots = await fetchText('/robots.txt');
      const sitemapPaths = ['/sitemap.xml', '/sitemap_index.xml'];
      for (const line of robots.split(/\r?\n/)) {
        const m = line.match(/^\s*Sitemap\s*:\s*(.+)\s*$/i);
        if (m) sitemapPaths.push(m[1]);
      }
      const parseSitemap = async (path, depth=0) => {
        if (depth > 2) return;
        const text = await fetchText(path);
        if (!text || text.length > 5_000_000) return;
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const locs = [...doc.querySelectorAll('loc')].map(x => x.textContent?.trim()).filter(Boolean).slice(0,5000);
        for (const loc of locs) {
          if (/\.xml(?:$|\?)/i.test(loc)) await parseSitemap(loc, depth+1);
          else add(loc, 'sitemap');
        }
      };
      for (const p of [...new Set(sitemapPaths)]) await parseSitemap(p);
      return urls.slice(0,10000);
    })()`, true);
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

async function domAudit() {
  if (!config.collect?.dom) return null;
  return evaluate(`(() => {
    const clip = (v,n=240) => String(v ?? '').replace(/\\s+/g,' ').trim().slice(0,n);
    const selector = (el) => {
      try {
        if (!el) return null;
        if (el.id) return '#' + CSS.escape(el.id);
        const tid = el.getAttribute('data-testid');
        if (tid) return '[data-testid="'+CSS.escape(tid)+'"]';
        let s = el.localName || '*';
        const cls = [...(el.classList || [])].filter(x => /^[a-zA-Z_-][\\w-]*$/.test(x)).slice(0,2);
        if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
        return s;
      } catch { return el?.localName || null; }
    };
    const accessible = (el) => clip(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '', 160);
    const labelFor = (el) => {
      const id = el.id;
      const explicit = id ? document.querySelector('label[for="'+CSS.escape(id)+'"]') : null;
      return clip(explicit?.innerText || el.closest('label')?.innerText || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '', 160);
    };
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0,250).map(h => ({ level:Number(h.localName[1]), text:clip(h.innerText), selector:selector(h) }));
    const forms = [...document.forms].slice(0,80).map((f) => ({
      selector: selector(f), action: f.action || '', method: f.method || 'get',
      controls: [...f.elements].slice(0,120).map(el => ({ tag:el.localName, type:el.type || null, name:el.name || null, label:labelFor(el), required:Boolean(el.required), disabled:Boolean(el.disabled), placeholder:clip(el.placeholder || '',120) }))
    }));
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')].slice(0,300).map(el => ({ selector:selector(el), text:accessible(el), disabled:Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), type:el.type || null }));
    const links = [...document.querySelectorAll('a[href]')].slice(0,500).map(a => ({ text:accessible(a), href:a.href, selector:selector(a), target:a.target || null }));
    const images = [...document.images].slice(0,400).map(img => ({ src:img.currentSrc || img.src, alt:img.alt || '', width:img.width, height:img.height, naturalWidth:img.naturalWidth, naturalHeight:img.naturalHeight, complete:img.complete, broken:Boolean(img.complete && img.naturalWidth === 0), selector:selector(img) }));
    const landmarks = [...document.querySelectorAll('header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"]')].slice(0,120).map(el => ({ tag:el.localName, role:el.getAttribute('role') || null, label:el.getAttribute('aria-label') || null, selector:selector(el) }));
    const overflow = [];
    for (const el of [...document.body?.querySelectorAll('*') || []]) {
      if (overflow.length >= 40) break;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 2 || r.left < -2)) overflow.push({ selector:selector(el), left:Math.round(r.left), right:Math.round(r.right), width:Math.round(r.width) });
    }
    const fixed = [...document.querySelectorAll('body *')].filter(el => ['fixed','sticky'].includes(getComputedStyle(el).position)).slice(0,60).map(el => ({ selector:selector(el), position:getComputedStyle(el).position, zIndex:getComputedStyle(el).zIndex, text:accessible(el).slice(0,100) }));
    const uiIssues = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) uiIssues.push({ type:'horizontal-overflow', severity:'serious', detail:'Document width exceeds viewport width' });
    for (const img of images.filter(x => x.broken).slice(0,10)) uiIssues.push({ type:'broken-image', severity:'serious', detail:img.src, selector:img.selector });
    const h1 = headings.filter(h => h.level === 1);
    if (h1.length === 0) uiIssues.push({ type:'missing-h1', severity:'moderate', detail:'No H1 found' });
    if (h1.length > 1) uiIssues.push({ type:'multiple-h1', severity:'minor', detail:h1.length + ' H1 elements' });
    if (!document.title.trim()) uiIssues.push({ type:'missing-title', severity:'serious', detail:'Document title is empty' });
    if (!document.documentElement.lang) uiIssues.push({ type:'missing-lang', severity:'moderate', detail:'html[lang] is missing' });
    if (!document.querySelector('meta[name="viewport"]')) uiIssues.push({ type:'missing-viewport', severity:'moderate', detail:'Viewport meta tag is missing' });
    return {
      title: document.title || '',
      metaDescription: document.querySelector('meta[name="description"]')?.content || '',
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.content || null,
      headings, forms, buttons, links, images, landmarks, overflowElements:overflow, fixedElements:fixed, uiIssues,
      counts: { nodes:document.getElementsByTagName('*').length, headings:headings.length, forms:forms.length, buttons:buttons.length, links:document.links.length, images:document.images.length }
    };
  })()`);
}

function sanitizeDomResult(dom) {
  if (!dom) return dom;
  dom.canonical = dom.canonical ? safeUrl(dom.canonical) : null;
  for (const f of dom.forms || []) f.action = f.action ? safeUrl(f.action) : '';
  for (const l of dom.links || []) l.href = safeUrl(l.href || '');
  for (const i of dom.images || []) i.src = safeUrl(i.src || '');
  for (const issue of dom.uiIssues || []) if (issue.type === 'broken-image' && issue.detail) issue.detail = safeUrl(issue.detail);
  return dom;
}
