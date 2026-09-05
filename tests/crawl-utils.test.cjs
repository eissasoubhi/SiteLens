const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, slugForUrl, shouldIgnore } = require('../crawl-utils.js');

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
