function scorePage(page) {
  const reasons = { ui:[], performance:[], accessibility:[], console:[], network:[] };
  const scores = { ui:100, performance:100, accessibility:100, console:100, network:100 };

  for (const issue of page.dom?.uiIssues || []) {
    const penalty = issue.severity === 'serious' ? 15 : issue.severity === 'moderate' ? 8 : 3;
    scores.ui -= penalty;
    reasons.ui.push({ penalty, reason: issue.type, detail: issue.detail });
  }
  if ((page.dom?.overflowElements || []).length && !(page.dom?.uiIssues || []).some(x=>x.type==='horizontal-overflow')) {
    scores.ui -= 8; reasons.ui.push({penalty:8,reason:'overflow-elements',detail:`${page.dom.overflowElements.length} element(s) overflow viewport`});
  }

  const perf = page.performance;
  if (!perf) { scores.performance = null; }
  else {
    const lcp = perf.webVitalsObserved?.lcp?.value;
    const cls = perf.webVitalsObserved?.cls;
    const fcp = perf.paints?.['first-contentful-paint'];
    const ttfb = perf.navigation ? perf.navigation.responseStart - perf.navigation.startTime : null;
    const long = perf.longTasks?.total || 0;
    if (lcp > 4000) { scores.performance -= 25; reasons.performance.push({penalty:25,reason:'LCP poor',detail:`${Math.round(lcp)} ms`}); }
    else if (lcp > 2500) { scores.performance -= 12; reasons.performance.push({penalty:12,reason:'LCP needs improvement',detail:`${Math.round(lcp)} ms`}); }
    if (cls > .25) { scores.performance -= 20; reasons.performance.push({penalty:20,reason:'CLS poor',detail:cls.toFixed(3)}); }
    else if (cls > .1) { scores.performance -= 10; reasons.performance.push({penalty:10,reason:'CLS needs improvement',detail:cls.toFixed(3)}); }
    if (fcp > 3000) { scores.performance -= 10; reasons.performance.push({penalty:10,reason:'FCP slow',detail:`${Math.round(fcp)} ms`}); }
    else if (fcp > 1800) { scores.performance -= 5; reasons.performance.push({penalty:5,reason:'FCP needs improvement',detail:`${Math.round(fcp)} ms`}); }
    if (ttfb > 1800) { scores.performance -= 10; reasons.performance.push({penalty:10,reason:'TTFB slow',detail:`${Math.round(ttfb)} ms`}); }
    else if (ttfb > 800) { scores.performance -= 5; reasons.performance.push({penalty:5,reason:'TTFB needs improvement',detail:`${Math.round(ttfb)} ms`}); }
    if (long > 1000) { scores.performance -= 10; reasons.performance.push({penalty:10,reason:'Long tasks',detail:`${Math.round(long)} ms total`}); }
    else if (long > 300) { scores.performance -= 5; reasons.performance.push({penalty:5,reason:'Long tasks',detail:`${Math.round(long)} ms total`}); }
  }

  const a11y = page.accessibility;
  if (!a11y) scores.accessibility = null;
  else {
    const penalties = { critical:10, serious:7, moderate:3, minor:1 };
    for (const [severity,count] of Object.entries(a11y.summary?.bySeverity || {})) {
      const penalty = Math.min(45, (penalties[severity] || 2) * count);
      scores.accessibility -= penalty;
      reasons.accessibility.push({penalty,reason:`${severity} accessibility issues`,detail:String(count)});
    }
  }

  const cs = page.consoleSummary || {errors:0,warnings:0};
  const cPenalty = Math.min(70, cs.errors * 15) + Math.min(20, cs.warnings * 3);
  scores.console -= cPenalty;
  if (cs.errors) reasons.console.push({penalty:Math.min(70,cs.errors*15),reason:'JavaScript errors',detail:String(cs.errors)});
  if (cs.warnings) reasons.console.push({penalty:Math.min(20,cs.warnings*3),reason:'Console warnings',detail:String(cs.warnings)});

  const ns = page.networkSummary || {failed:0,status4xx:0,status5xx:0};
  const nPenalty = Math.min(40,ns.failed*8) + Math.min(30,ns.status5xx*8) + Math.min(25,ns.status4xx*4);
  scores.network -= nPenalty;
  if (ns.failed) reasons.network.push({penalty:Math.min(40,ns.failed*8),reason:'Failed requests',detail:String(ns.failed)});
  if (ns.status5xx) reasons.network.push({penalty:Math.min(30,ns.status5xx*8),reason:'HTTP 5xx',detail:String(ns.status5xx)});
  if (ns.status4xx) reasons.network.push({penalty:Math.min(25,ns.status4xx*4),reason:'HTTP 4xx',detail:String(ns.status4xx)});

  for (const key of Object.keys(scores)) if (scores[key] != null) scores[key] = clamp(Math.round(scores[key]),0,100);
  const available = Object.values(scores).filter((x)=>x!=null);
  scores.overall = available.length ? Math.round(available.reduce((a,b)=>a+b,0)/available.length) : null;
  return { scores, reasons };
}

function severityWeight(s) { return ({critical:4,serious:3,moderate:2,minor:1}[s] || 0); }

function buildTopIssues(pages) {
  const out = [];
  for (const p of pages) {
    if (p.consoleSummary?.errors) out.push({severity:'serious',type:'console',title:`${p.consoleSummary.errors} erreur(s) JavaScript`,page:p.url,detail:'Voir console.json'});
    if (p.networkSummary?.failed || p.networkSummary?.status5xx) out.push({severity:'serious',type:'network',title:'Requêtes réseau en échec',page:p.url,detail:`failed=${p.networkSummary.failed}, 5xx=${p.networkSummary.status5xx}`});
    for (const issue of (p.accessibility?.violations || []).slice(0,8)) out.push({severity:issue.severity,type:'accessibility',title:issue.rule,page:p.url,detail:issue.detail});
    for (const issue of (p.dom?.uiIssues || []).slice(0,8)) out.push({severity:issue.severity,type:'ui',title:issue.type,page:p.url,detail:issue.detail});
    for (const r of (p.score?.reasons?.performance || []).slice(0,5)) out.push({severity:r.penalty >= 15 ? 'serious' : 'moderate',type:'performance',title:r.reason,page:p.url,detail:r.detail});
  }
  return out.sort((a,b)=>severityWeight(b.severity)-severityWeight(a.severity)).slice(0,60);
}

function aggregateScores(pages) {
  const keys = ['ui','performance','accessibility','console','network'];
  const scores = {};
  for (const key of keys) {
    const vals = pages.map(p=>p.score?.scores?.[key]).filter(v=>v!=null);
    scores[key] = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : null;
  }
  const available = Object.values(scores).filter(v=>v!=null);
  scores.overall = available.length ? Math.round(available.reduce((a,b)=>a+b,0)/available.length) : null;
  return scores;
}

function aggregateDesignSystem(pages) {
  const categories = ['colors','backgrounds','fonts','fontSizes','fontWeights','borderRadii','boxShadows','spacings'];
  const out = { categories:{}, cssVariables:{}, mediaQueries:{}, drift:[] };
  for (const cat of categories) {
    const counts = new Map();
    for (const page of pages) for (const item of page.designSystem?.top?.[cat] || []) counts.set(item.value,(counts.get(item.value)||0)+item.count);
    out.categories[cat] = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,60).map(([value,count])=>({value,count}));
  }
  const varMap = new Map();
  const mediaMap = new Map();
  for (const page of pages) {
    for (const [name,value] of Object.entries(page.designSystem?.cssVariables || {})) {
      if (!varMap.has(name)) varMap.set(name,new Map());
      const values=varMap.get(name);
      if (!values.has(value)) values.set(value,[]);
      values.get(value).push(page.pageId);
    }
    for (const q of page.designSystem?.mediaQueries || []) {
      if (!mediaMap.has(q)) mediaMap.set(q,[]);
      mediaMap.get(q).push(page.pageId);
    }
  }
  for (const [name,values] of varMap) {
    out.cssVariables[name] = [...values.entries()].map(([value,pageIds])=>({value,pageIds}));
    if (values.size > 1) out.drift.push({type:'css-variable-drift',name,values:out.cssVariables[name]});
  }
  out.mediaQueries = Object.fromEntries([...mediaMap.entries()].map(([q,pageIds])=>[q,pageIds]));
  return out;
}

function aggregateUi(pages) {
  const issues=[];
  for (const p of pages) {
    for (const issue of p.dom?.uiIssues || []) issues.push({pageId:p.pageId,url:p.url,...issue});
  }
  const byType=issues.reduce((a,x)=>(a[x.type]=(a[x.type]||0)+1,a),{});
  return { total:issues.length, byType, issues };
}

function aggregateSummary(pages) {
  return {
    pagesVisited: pages.length,
    captures: pages.reduce((n,p)=>n+(p.screenshots?.length||0),0),
    pageErrors: pages.filter(p=>p.error).length,
    consoleErrors: pages.reduce((n,p)=>n+(p.consoleSummary?.errors||0),0),
    consoleWarnings: pages.reduce((n,p)=>n+(p.consoleSummary?.warnings||0),0),
    networkRequests: pages.reduce((n,p)=>n+(p.networkSummary?.total||0),0),
    failedRequests: pages.reduce((n,p)=>n+(p.networkSummary?.failed||0)+(p.networkSummary?.status5xx||0),0),
    accessibilityViolations: pages.reduce((n,p)=>n+(p.accessibility?.summary?.total||0),0),
    annotations: report.annotations.length
  };
}
