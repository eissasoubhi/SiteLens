async function designSystemAudit() {
  if (!config.collect?.designSystem) return null;
  return evaluate(`(() => {
    const top = (map, n=30) => [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([value,count])=>({value,count}));
    const add = (map, value) => { value=String(value||'').trim(); if (value) map.set(value,(map.get(value)||0)+1); };
    const colors=new Map(), backgrounds=new Map(), fonts=new Map(), sizes=new Map(), weights=new Map(), radii=new Map(), shadows=new Map(), spacings=new Map();
    const els=[...document.querySelectorAll('body *')].slice(0,6000);
    for (const el of els) {
      const s=getComputedStyle(el);
      add(colors,s.color); if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') add(backgrounds,s.backgroundColor);
      add(fonts,s.fontFamily); add(sizes,s.fontSize); add(weights,s.fontWeight); if (s.borderRadius !== '0px') add(radii,s.borderRadius); if (s.boxShadow !== 'none') add(shadows,s.boxShadow);
      for (const v of [s.marginTop,s.marginRight,s.marginBottom,s.marginLeft,s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft,s.gap]) if (v && v !== '0px' && v !== 'normal') add(spacings,v);
    }
    const root=getComputedStyle(document.documentElement); const cssVariables={};
    for (const name of root) if (name.startsWith('--')) cssVariables[name]=root.getPropertyValue(name).trim();
    const media=new Set();
    const walk=(rules) => { for (const r of [...rules || []]) { if (r.media?.mediaText) media.add(r.media.mediaText); try { if (r.cssRules) walk(r.cssRules); } catch {} } };
    for (const sheet of [...document.styleSheets]) { try { walk(sheet.cssRules); } catch {} }
    const buttons=[...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')].slice(0,80).map(el=>{const s=getComputedStyle(el);return {text:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,100),fontSize:s.fontSize,fontWeight:s.fontWeight,color:s.color,backgroundColor:s.backgroundColor,borderRadius:s.borderRadius,border:s.border,boxShadow:s.boxShadow,padding:s.padding};});
    return { cssVariables, mediaQueries:[...media].slice(0,120), top:{ colors:top(colors), backgrounds:top(backgrounds), fonts:top(fonts), fontSizes:top(sizes), fontWeights:top(weights), borderRadii:top(radii), boxShadows:top(shadows,20), spacings:top(spacings) }, buttonSamples:buttons };
  })()`);
}

async function accessibilityAudit() {
  if (!config.collect?.accessibility) return null;
  const custom = await evaluate(`(() => {
    const clip=(v,n=220)=>String(v??'').replace(/\\s+/g,' ').trim().slice(0,n);
    const selector=(el)=>{try{if(el.id)return '#'+CSS.escape(el.id);const tid=el.getAttribute('data-testid');if(tid)return '[data-testid="'+CSS.escape(tid)+'"]';return el.localName+(el.classList?.length?'.'+[...el.classList].slice(0,2).map(CSS.escape).join('.'):'');}catch{return el?.localName||null;}};
    const name=(el)=>clip(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.textContent||el.value||'');
    const issues=[]; const add=(rule,severity,el,detail)=>issues.push({rule,severity,selector:el?selector(el):null,detail:clip(detail,300)});
    if (!document.documentElement.lang) add('html-lang','moderate',document.documentElement,'html element has no lang attribute');
    if (!document.title.trim()) add('document-title','serious',document.documentElement,'Document has no title');
    for (const img of [...document.images]) if (!img.hasAttribute('alt')) add('image-alt','serious',img,'Image is missing alt attribute');
    for (const el of [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')]) if (!name(el)) add('button-name','serious',el,'Interactive button has no accessible name');
    for (const a of [...document.querySelectorAll('a[href]')]) if (!name(a) && !a.querySelector('img[alt]')) add('link-name','serious',a,'Link has no accessible name');
    for (const el of [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')]) {
      const id=el.id; const labelled=id && document.querySelector('label[for="'+CSS.escape(id)+'"]');
      if (!labelled && !el.closest('label') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) add('form-label','serious',el,'Form control has no programmatic label');
    }
    const ids=new Map();
    for (const el of [...document.querySelectorAll('[id]')]) { const n=ids.get(el.id)||0; ids.set(el.id,n+1); }
    for (const [id,count] of ids) if (id && count>1) issues.push({rule:'duplicate-id',severity:'moderate',selector:'#'+id,detail:count+' elements share this id'});
    for (const el of [...document.querySelectorAll('[tabindex]')]) if (Number(el.getAttribute('tabindex'))>0) add('positive-tabindex','minor',el,'Positive tabindex can create confusing focus order');
    const hs=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h=>Number(h.localName[1]));
    for(let i=1;i<hs.length;i++) if(hs[i]>hs[i-1]+1) { issues.push({rule:'heading-order',severity:'minor',selector:null,detail:'Heading level jumps from H'+hs[i-1]+' to H'+hs[i]}); break; }
    const vp=document.querySelector('meta[name="viewport"]')?.content||'';
    if (/user-scalable\\s*=\\s*no/i.test(vp) || /maximum-scale\\s*=\\s*1(?:\\.0+)?(?:,|$)/i.test(vp)) issues.push({rule:'viewport-zoom',severity:'serious',selector:'meta[name="viewport"]',detail:'Viewport may prevent user zoom'});
    const bySeverity=issues.reduce((a,x)=>(a[x.severity]=(a[x.severity]||0)+1,a),{});
    const byRule=issues.reduce((a,x)=>(a[x.rule]=(a[x.rule]||0)+1,a),{});
    return { engine:'built-in heuristic + Chrome accessibility tree', violations:issues.slice(0,800), summary:{total:issues.length,bySeverity,byRule} };
  })()`);

  try {
    const ax = await command('Accessibility.getFullAXTree');
    const roles = {};
    let ignored = 0;
    for (const n of ax.nodes || []) {
      if (n.ignored) ignored++;
      const role = n.role?.value;
      if (role) roles[role] = (roles[role] || 0) + 1;
    }
    custom.axSummary = { nodes: ax.nodes?.length || 0, ignored, roles };
    if (config.collect.axTree) {
      custom.axTree = (ax.nodes || []).slice(0, 20000).map((n) => ({
        nodeId: n.nodeId,
        ignored: n.ignored,
        role: n.role?.value ?? null,
        name: redactText(n.name?.value ?? '').slice(0,500),
        description: redactText(n.description?.value ?? '').slice(0,500),
        value: redactText(n.value?.value ?? '').slice(0,500),
        childIds: n.childIds || [],
        properties: (n.properties || []).slice(0,30).map((p) => ({ name:p.name, value:p.value?.value ?? null }))
      }));
    }
  } catch (e) {
    custom.axError = e.message;
  }
  return custom;
}

async function performanceAudit() {
  if (!config.collect?.performance) return null;
  const page = await evaluate(`(() => {
    const n=performance.getEntriesByType('navigation')[0];
    const nav=n?{
      type:n.type,startTime:n.startTime,duration:n.duration,redirectCount:n.redirectCount,
      domainLookupStart:n.domainLookupStart,domainLookupEnd:n.domainLookupEnd,connectStart:n.connectStart,connectEnd:n.connectEnd,
      secureConnectionStart:n.secureConnectionStart,requestStart:n.requestStart,responseStart:n.responseStart,responseEnd:n.responseEnd,
      domInteractive:n.domInteractive,domContentLoadedEventStart:n.domContentLoadedEventStart,domContentLoadedEventEnd:n.domContentLoadedEventEnd,
      domComplete:n.domComplete,loadEventStart:n.loadEventStart,loadEventEnd:n.loadEventEnd,transferSize:n.transferSize,encodedBodySize:n.encodedBodySize,decodedBodySize:n.decodedBodySize
    }:null;
    const paints=Object.fromEntries(performance.getEntriesByType('paint').map(e=>[e.name,e.startTime]));
    const resources=performance.getEntriesByType('resource').map(r=>({name:r.name,initiatorType:r.initiatorType,duration:r.duration,transferSize:r.transferSize||0,encodedBodySize:r.encodedBodySize||0,decodedBodySize:r.decodedBodySize||0}));
    const byType={}; let transfer=0,encoded=0,decoded=0;
    for(const r of resources){const k=r.initiatorType||'other'; const x=byType[k]||(byType[k]={count:0,transferSize:0,encodedBodySize:0,decodedBodySize:0});x.count++;x.transferSize+=r.transferSize;x.encodedBodySize+=r.encodedBodySize;x.decodedBodySize+=r.decodedBodySize;transfer+=r.transferSize;encoded+=r.encodedBodySize;decoded+=r.decodedBodySize;}
    const slowest=resources.sort((a,b)=>b.duration-a.duration).slice(0,20);
    const m=window.__AIFDC_METRICS || {};
    const memory=performance.memory?{jsHeapSizeLimit:performance.memory.jsHeapSizeLimit,totalJSHeapSize:performance.memory.totalJSHeapSize,usedJSHeapSize:performance.memory.usedJSHeapSize}:null;
    return { navigation:nav, paints, webVitalsObserved:{lcp:m.lcp||null,cls:typeof m.cls==='number'?m.cls:null,clsLargest:m.clsLargest||null,inp:m.inp||null,labApproximation:true,observerErrors:m.errors||[]}, longTasks:m.longTasks||null, resources:{count:resources.length,transferSize:transfer,encodedBodySize:encoded,decodedBodySize:decoded,byType,slowest}, memory };
  })()`);
  try {
    const cdp = await command('Performance.getMetrics');
    page.cdpMetrics = Object.fromEntries((cdp.metrics || []).map((x) => [x.name, x.value]));
  } catch (e) { page.cdpMetricsError = e.message; }
  return page;
}

async function rawDomSnapshot() {
  if (!config.rawDomSnapshot) return null;
  return command('DOMSnapshot.captureSnapshot', { computedStyles: ['display','visibility','color','background-color','font-size','font-family','font-weight','position','z-index'] });
}

function isPng(bytes) {
  return bytes?.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function captureScreenshot(profile, folder) {
  await applyViewport(profile);
  await primeLazyContent();
  await sleep(Math.min(500, Math.max(120, Math.round(config.settleMs / 3))));
  const info = await pageInfo();

  let shot = null;
  let layout = null;
  let captureMethod = 'layout-metrics-clip';
  try {
    layout = await command('Page.getLayoutMetrics');
    const content = layout?.cssContentSize || layout?.contentSize;
    const width = Math.max(1, Math.ceil(content?.width || info.document.width || info.viewport.width));
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
    document: info.document,
    layoutContentSize: layout?.cssContentSize || layout?.contentSize || null
  };
}

function consoleSummary(items) {
  const errors = items.filter((x) => x.level === 'error' || x.kind === 'exception').length;
  const warnings = items.filter((x) => x.level === 'warning' || x.level === 'warn').length;
  return { total: items.length, errors, warnings };
}

function networkSummary(items) {
  const failed = items.filter((x) => x.failed).length;
  const status4xx = items.filter((x) => x.status >= 400 && x.status < 500).length;
  const status5xx = items.filter((x) => x.status >= 500).length;
  const totalBytes = items.reduce((n,x)=>n+(x.encodedDataLength||0),0);
  const slowest = [...items].filter(x=>Number.isFinite(x.durationMs)).sort((a,b)=>b.durationMs-a.durationMs).slice(0,20).map(x=>({url:x.url,method:x.method,status:x.status,durationMs:x.durationMs,type:x.type}));
  return { total: items.length, failed, status4xx, status5xx, totalBytes, slowest };
}
