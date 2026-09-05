(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SiteLensCrawl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseLines(text) {
    return String(text || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  }

  function canonicalOrigin(raw) {
    try { return new URL(raw).origin; } catch { return null; }
  }

  function isLikelyPageUrl(raw, baseUrl) {
    try {
      const u = new URL(raw, baseUrl);
      const path = decodeURIComponent(u.pathname || '/').toLowerCase();

      // SiteLens is a UI crawler. API/action endpoints can mutate state, trigger OAuth,
      // download files, or return non-HTML payloads, so never auto-crawl them.
      if (/^\/api(?:\/|$)/.test(path)) return false;
      if (/(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|download|export|unsubscribe)(?:\/|$)/.test(path)) return false;
      if (/\.(?:7z|avif|bmp|csv|docx?|eot|gif|gz|ico|jpe?g|json|mp3|mp4|ogg|pdf|png|pptx?|rar|svg|tar|tgz|tiff?|txt|vcf|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(path)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function normalizeUrl(raw, { baseUrl, allowedOrigin, includeQuery = false, includeHash = false } = {}) {
    try {
      const u = new URL(raw, baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      if (allowedOrigin && u.origin !== allowedOrigin) return null;
      if (!isLikelyPageUrl(u.href, baseUrl)) return null;
      for (const key of [...u.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$|msclkid$|mc_[ce]id$)/i.test(key)) u.searchParams.delete(key);
      }
      if (!includeQuery) u.search = '';
      const looksLikeHashRouter = /^#(?:!\/|\/)/.test(u.hash);
      if (!includeHash && !looksLikeHashRouter) u.hash = '';
      return u.href;
    } catch {
      return null;
    }
  }

  function shouldIgnore(url, patterns) {
    const lower = String(url || '').toLowerCase();
    return (patterns || []).some((p) => lower.includes(String(p).toLowerCase()));
  }

  function slugForUrl(url, { includeQuery = false, includeHash = false } = {}) {
    try {
      const u = new URL(url);
      let s = u.pathname === '/' ? 'home' : u.pathname.replace(/^\/+|\/+$/g, '');
      if (includeQuery && u.search) s += '-' + u.search.slice(1);
      if (includeHash && u.hash) s += '-' + u.hash.slice(1);
      return (s || 'home').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'page';
    } catch {
      return 'page';
    }
  }

  return { parseLines, canonicalOrigin, isLikelyPageUrl, normalizeUrl, shouldIgnore, slugForUrl };
});
