const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const zip = new LocalZip();
const COLLECTOR_VERSION = chrome.runtime.getManifest().version;

let stopped = false;
let finalized = false;
let config = null;
let targetTabId = null;
let debuggee = null;
let currentCapture = null;
let traceBuffer = null;
let traceBytes = 0;
let traceTruncated = false;
let traceResolve = null;
let detachedUnexpectedly = false;
let crawlOrigin = null;
let crawlBaseUrl = null;

const stats = { visited: 0, captures: 0, errors: 0, queued: 0 };
const report = {
  schemaVersion: 2,
  collector: { name: 'SiteLens', version: COLLECTOR_VERSION },
  diagnosticId: null,
  parentDiagnosticId: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  origin: null,
  startUrl: null,
  project: {},
  mode: null,
  config: null,
  pages: [],
  annotations: [],
  errors: [],
  summary: {},
  scores: {},
  topIssues: [],
  discovery: { candidatesFound: 0, enqueued: 0, duplicateOrFiltered: 0, bySource: {}, maxPagesReached: false, effectiveOrigin: null, rejected: [] }
};

const METRICS_SOURCE = String.raw`
(() => {
  if (window.__AIFDC_METRICS) return;
  const state = window.__AIFDC_METRICS = {
    lcp: null,
    cls: 0,
    clsLargest: null,
    inp: null,
    longTasks: { count: 0, total: 0, max: 0 },
    errors: []
  };
  const selector = (el) => {
    try {
      if (!el || !el.localName) return null;
      if (el.id) return '#' + CSS.escape(el.id);
      const tid = el.getAttribute && el.getAttribute('data-testid');
      if (tid) return '[data-testid="' + CSS.escape(tid) + '"]';
      let s = el.localName;
      const cls = el.classList ? [...el.classList].filter(x => /^[a-zA-Z_-][\w-]*$/.test(x)).slice(0,2) : [];
      if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
      return s;
    } catch { return null; }
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.lcp = {
          value: e.renderTime || e.loadTime || e.startTime || 0,
          startTime: e.startTime || 0,
          size: e.size || 0,
          url: e.url || null,
          element: selector(e.element)
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { state.errors.push('LCP observer: ' + e.message); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        state.cls += e.value || 0;
        if (!state.clsLargest || e.value > state.clsLargest.value) {
          state.clsLargest = {
            value: e.value || 0,
            sources: (e.sources || []).slice(0,5).map(s => selector(s.node)).filter(Boolean)
          };
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { state.errors.push('CLS observer: ' + e.message); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        if (!state.inp || e.duration > state.inp.value) {
          state.inp = { value: e.duration, name: e.name, startTime: e.startTime, target: selector(e.target) };
        }
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
  } catch (e) { state.errors.push('INP observer: ' + e.message); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.longTasks.count += 1;
        state.longTasks.total += e.duration || 0;
        state.longTasks.max = Math.max(state.longTasks.max, e.duration || 0);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { state.errors.push('Long task observer: ' + e.message); }
})();`;

$('stop').addEventListener('click', () => {
  stopped = true;
  $('stop').disabled = true;
  $('stop').textContent = 'Export en cours…';
});

function parseLines(text) {
  return String(text || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function redactText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 4000);
}
function safeUrl(raw) {
  try {
    const u = new URL(raw); u.username=''; u.password='';
    const sensitive = /token|password|passwd|secret|auth|session|jwt|api.?key|signature|code/i;
    for (const key of [...u.searchParams.keys()]) if (sensitive.test(key)) u.searchParams.set(key, '[REDACTED]');
    return u.href;
  } catch { return redactText(raw).slice(0, 2000); }
}
function normalizeUrl(raw, base = crawlBaseUrl || config.startUrl) {
  return SiteLensCrawl.normalizeUrl(raw, { baseUrl:base, allowedOrigin:crawlOrigin || new URL(config.startUrl).origin, includeQuery:Boolean(config.includeQuery), includeHash:Boolean(config.includeHash) });
}
function shouldIgnore(url, patterns) { return SiteLensCrawl.shouldIgnore(url, patterns); }
function slugForUrl(url) { return SiteLensCrawl.slugForUrl(url, { includeQuery:Boolean(config.includeQuery), includeHash:Boolean(config.includeHash) }); }
function base64ToBytes(base64) { const raw=atob(base64); const out=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out; }
function dataUrlToBytes(dataUrl) { const comma=String(dataUrl||'').indexOf(','); return comma<0?new Uint8Array():base64ToBytes(dataUrl.slice(comma+1)); }
function localStamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;}
function projectCode(name,origin){let raw=name;if(!raw){try{raw=new URL(origin).hostname.split('.')[0];}catch{raw='SITE';}}const code=String(raw).replace(/[^a-z0-9]+/gi,'').toUpperCase().slice(0,8);return code||'SITE';}
function randomHex(){const bytes=new Uint8Array(2);crypto.getRandomValues(bytes);return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();}
async function command(method, params={}) { return chrome.debugger.sendCommand(debuggee, method, params); }
async function evaluate(expression, awaitPromise=false){const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});if(result?.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Runtime.evaluate failed');return result?.result?.value;}
function log(kind,text,status=''){const li=document.createElement('li');li.innerHTML='<span class="kind"></span><span class="url"></span><span></span>';li.children[0].textContent=kind;li.children[1].textContent=text;li.children[1].title=text;li.children[2].className=status==='ok'?'ok':status==='fail'?'fail':'';li.children[2].textContent=status==='ok'?'✓':status==='fail'?'Erreur':'';$('log').prepend(li);}
async function publishStatus(extra={}){const denominator=Math.max(1,Math.min(config?.maxPages||1,stats.visited+stats.queued));const progress=finalized?100:Math.min(99,Math.round((stats.visited/denominator)*100));await chrome.storage.local.set({captureStatus:{state:finalized?'done':'running',diagnosticId:report.diagnosticId,mode:config?.mode||'full',visited:stats.visited,captures:stats.captures,errors:stats.errors,queued:stats.queued,progress,currentPage:$('current').textContent,...extra}});}
function updateUi(queueLength=stats.queued){stats.queued=queueLength;$('visited').textContent=String(stats.visited);$('captured').textContent=String(stats.captures);$('queued').textContent=String(queueLength);$('errors').textContent=String(stats.errors);const denominator=Math.max(1,Math.min(config?.maxPages||1,stats.visited+queueLength));$('progress').style.width=`${Math.min(100,Math.round((stats.visited/denominator)*100))}%`;publishStatus().catch(()=>{});}
function serializeCallFrames(stackTrace){return (stackTrace?.callFrames||[]).slice(0,10).map(f=>({functionName:f.functionName||'',url:safeUrl(f.url||''),lineNumber:f.lineNumber,columnNumber:f.columnNumber}));}
function sanitizeValue(value,depth=0){if(depth>5)return'[TRUNCATED]';if(typeof value==='string')return redactText(value);if(value==null||typeof value==='number'||typeof value==='boolean')return value;if(Array.isArray(value))return value.slice(0,100).map(x=>sanitizeValue(x,depth+1));if(typeof value==='object'){const out={};for(const [key,val] of Object.entries(value).slice(0,100))out[key]=/token|password|passwd|secret|auth|session|jwt|api.?key|signature/i.test(key)?'[REDACTED]':sanitizeValue(val,depth+1);return out;}return redactText(String(value));}
function serializeArg(arg){if(!arg)return null;if('value'in arg)return sanitizeValue(arg.value);return redactText(arg.description||arg.type||'');}

chrome.debugger.onEvent.addListener((source,method,params)=>{
  if(source.tabId!==targetTabId)return;
  if(method==='Tracing.dataCollected'&&traceBuffer){for(const event of params.value||[]){if(traceTruncated)break;const approx=JSON.stringify(event).length;if(traceBytes+approx>12_000_000){traceTruncated=true;break;}traceBytes+=approx;traceBuffer.push(event);}return;}
  if(method==='Tracing.tracingComplete'){if(traceResolve)traceResolve();traceResolve=null;return;}
  if(!currentCapture)return;const cap=currentCapture,now=Date.now();
  if(method==='Runtime.consoleAPICalled'){if(cap.console.length<1000)cap.console.push({kind:'console',level:params.type||'log',timestamp:params.timestamp||now,args:(params.args||[]).slice(0,12).map(serializeArg),stack:serializeCallFrames(params.stackTrace)});}
  else if(method==='Runtime.exceptionThrown'){const d=params.exceptionDetails||{};if(cap.console.length<1000)cap.console.push({kind:'exception',level:'error',timestamp:params.timestamp||now,text:redactText(d.exception?.description||d.text||'Uncaught exception'),url:safeUrl(d.url||''),lineNumber:d.lineNumber,columnNumber:d.columnNumber,stack:serializeCallFrames(d.stackTrace)});}
  else if(method==='Log.entryAdded'){const e=params.entry||{};if(cap.console.length<1000)cap.console.push({kind:'browser-log',level:e.level||'info',source:e.source||'',text:redactText(e.text||''),url:safeUrl(e.url||''),timestamp:e.timestamp||now});}
  else if(method==='Network.requestWillBeSent'){if(Object.keys(cap.network).length>=2000)return;cap.activeRequests+=1;cap.lastNetworkEventAt=now;const r=params.request||{};cap.network[params.requestId]={requestId:params.requestId,url:safeUrl(r.url||''),method:r.method||'GET',type:params.type||'',documentURL:safeUrl(params.documentURL||''),startTimestamp:params.timestamp||0,wallTime:params.wallTime||null,initiator:{type:params.initiator?.type||null,url:safeUrl(params.initiator?.url||''),stack:serializeCallFrames(params.initiator?.stack)}};}
  else if(method==='Network.responseReceived'){cap.lastNetworkEventAt=now;const item=cap.network[params.requestId]||(cap.network[params.requestId]={requestId:params.requestId,url:safeUrl(params.response?.url||'')});const r=params.response||{};Object.assign(item,{status:r.status,statusText:r.statusText||'',mimeType:r.mimeType||'',protocol:r.protocol||'',fromDiskCache:Boolean(r.fromDiskCache),fromServiceWorker:Boolean(r.fromServiceWorker),remoteIPAddress:r.remoteIPAddress||null,responseTimestamp:params.timestamp||0});if(r.timing)item.timing={dnsStart:r.timing.dnsStart,dnsEnd:r.timing.dnsEnd,connectStart:r.timing.connectStart,connectEnd:r.timing.connectEnd,sslStart:r.timing.sslStart,sslEnd:r.timing.sslEnd,sendStart:r.timing.sendStart,sendEnd:r.timing.sendEnd,receiveHeadersStart:r.timing.receiveHeadersStart,receiveHeadersEnd:r.timing.receiveHeadersEnd};}
  else if(method==='Network.loadingFinished'){cap.activeRequests=Math.max(0,cap.activeRequests-1);cap.lastNetworkEventAt=now;const item=cap.network[params.requestId];if(item){item.encodedDataLength=params.encodedDataLength||0;item.endTimestamp=params.timestamp||0;if(item.startTimestamp&&item.endTimestamp)item.durationMs=Math.round((item.endTimestamp-item.startTimestamp)*1000);}}
  else if(method==='Network.loadingFailed'){cap.activeRequests=Math.max(0,cap.activeRequests-1);cap.lastNetworkEventAt=now;const item=cap.network[params.requestId]||(cap.network[params.requestId]={requestId:params.requestId});item.failed=true;item.errorText=redactText(params.errorText||'Network failure');item.canceled=Boolean(params.canceled);item.blockedReason=params.blockedReason||null;item.endTimestamp=params.timestamp||0;if(item.startTimestamp&&item.endTimestamp)item.durationMs=Math.round((item.endTimestamp-item.startTimestamp)*1000);}
});
chrome.debugger.onDetach.addListener((source,reason)=>{if(source.tabId===targetTabId&&!finalized){detachedUnexpectedly=true;report.errors.push({fatal:true,message:`Debugger detached: ${reason}`});stopped=true;}});
