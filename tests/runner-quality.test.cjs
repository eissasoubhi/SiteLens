const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.resolve(__dirname, '../runner-quality.js'), 'utf8')

function loadQuality() {
  const context = {
    console,
    scorePage: () => ({ scores: { ui: 100, performance: 100, accessibility: 100, console: 100, network: 100, overall: 100 }, reasons: { ui: [], performance: [], accessibility: [], console: [], network: [] } }),
    buildTopIssues: () => [],
    severityWeight: severity => ({ critical: 4, serious: 3, moderate: 2, minor: 1 }[severity] || 0),
    clamp: (n, min, max) => Math.max(min, Math.min(max, n))
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return context
}

test('browser extension console noise does not affect scored errors', () => {
  const quality = loadQuality()
  const summary = quality.consoleSummary([
    { kind: 'exception', level: 'error', url: 'chrome-extension://abc/content.js' },
    { kind: 'console', level: 'error', stack: [{ url: 'https://app.test/main.js' }] },
    { kind: 'console', level: 'warn', stack: [{ url: 'moz-extension://abc/content.js' }] }
  ])

  assert.equal(summary.observedTotal, 3)
  assert.equal(summary.browserExtensionEntries, 2)
  assert.equal(summary.total, 1)
  assert.equal(summary.errors, 1)
  assert.equal(summary.warnings, 0)
})

test('browser extension requests stay observable but are excluded from network score', () => {
  const quality = loadQuality()
  const summary = quality.networkSummary([
    { url: 'chrome-extension://abc/content.js', failed: true, durationMs: 40 },
    { url: 'https://app.test/api/items', status: 200, durationMs: 120, encodedDataLength: 12 },
    { url: 'https://app.test/api/fail', status: 500, failed: true, durationMs: 180, encodedDataLength: 8 }
  ])

  assert.equal(summary.observedTotal, 3)
  assert.equal(summary.browserExtensionRequests, 1)
  assert.equal(summary.total, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.status5xx, 1)
  assert.equal(summary.totalBytes, 20)
})

test('responsive findings lower UI score and become top issues', () => {
  const quality = loadQuality()
  const page = {
    url: 'https://app.test/duplicates',
    screenshots: [{
      profile: 'mobile-390x844',
      viewport: { width: 390, height: 844 },
      expectedViewport: { width: 390, height: 844 },
      viewportMismatch: { width: false, height: false },
      responsiveAudit: { hasHorizontalOverflow: true, horizontalOverflowPx: 115 }
    }]
  }

  const score = quality.scorePage(page)
  const issues = quality.buildTopIssues([page])

  assert.equal(score.scores.ui, 92)
  assert.match(score.reasons.ui[0].reason, /responsive-horizontal-overflow/)
  assert.equal(issues[0].type, 'responsive')
  assert.match(issues[0].detail, /115px/)
})
