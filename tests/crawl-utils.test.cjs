const test = require('node:test');
const assert = require('node:assert/strict');
const { isLikelyPageUrl, normalizeUrl, slugForUrl, shouldIgnore } = require('../crawl-utils.js');

test('normalizes same-origin links and removes tracking/query/hash by default', () => {
  const value = normalizeUrl('/jobs?page=2&utm_source=test#filters', {
    baseUrl: 'http://jobpilot.test/',
    allowedOrigin: 'http://jobpilot.test'
  });
  assert.equal(value, 'http://jobpilot.test/jobs');
});

test('preserves hash-router routes even when normal anchors are collapsed', () => {
  const value = normalizeUrl('/#/jobs', {
    baseUrl: 'http://jobpilot.test/',
    allowedOrigin: 'http://jobpilot.test',
    includeHash: false
  });
  assert.equal(value, 'http://jobpilot.test/#/jobs');
});

test('accepts the effective origin after redirect and rejects the stale one', () => {
  assert.equal(normalizeUrl('/dashboard', {
    baseUrl: 'https://jobpilot.test/',
    allowedOrigin: 'https://jobpilot.test'
  }), 'https://jobpilot.test/dashboard');
  assert.equal(normalizeUrl('http://jobpilot.test/dashboard', {
    baseUrl: 'https://jobpilot.test/',
    allowedOrigin: 'https://jobpilot.test'
  }), null);
});

test('supports optional query distinction and safe slugs', () => {
  const value = normalizeUrl('/jobs?page=2', {
    baseUrl: 'http://jobpilot.test/',
    allowedOrigin: 'http://jobpilot.test',
    includeQuery: true
  });
  assert.equal(value, 'http://jobpilot.test/jobs?page=2');
  assert.equal(slugForUrl(value, { includeQuery: true }), 'jobs-page-2');
});

test('ignore patterns are explicit and case-insensitive', () => {
  assert.equal(shouldIgnore('http://x.test/Logout', ['/logout']), true);
  assert.equal(shouldIgnore('http://x.test/jobs', ['/logout']), false);
});

test('auto-crawl rejects API, action, download and asset URLs', () => {
  const base = 'http://jobpilot.test/';
  const blocked = [
    '/api/cvs/1/download',
    '/api/integrations/gmail/start',
    '/logout',
    '/account/delete',
    '/reports/export',
    '/files/report.pdf',
    '/images/logo.png'
  ];
  for (const url of blocked) {
    assert.equal(isLikelyPageUrl(url, base), false, url);
    assert.equal(normalizeUrl(url, { baseUrl: base, allowedOrigin: 'http://jobpilot.test' }), null, url);
  }
});

test('auto-crawl still accepts normal UI routes containing harmless words', () => {
  const base = 'http://jobpilot.test/';
  for (const url of ['/login', '/api-docs', '/reports', '/parametres/integrations', '/cv']) {
    assert.equal(isLikelyPageUrl(url, base), true, url);
  }
});
