const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { URL } = require('node:url')

const source = fs.readFileSync(path.resolve(__dirname, '../runner-export.js'), 'utf8')

function loadExport() {
  const context = {
    URL,
    redactText: value => String(value ?? ''),
    safeUrl: value => String(value ?? ''),
    config: {},
    viewportProfiles: () => [],
    parseLines: () => [],
    report: {
      origin: 'https://mpc.test',
      pages: [],
      project: { name: 'MPC' },
      diagnosticId: 'test',
      mode: 'full',
      startedAt: '2026-09-11T00:00:00Z',
      scores: {},
      summary: {}
    },
    zip: { add: () => {} }
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  return context
}

test('external discovery URLs retain only their origin', () => {
  const exporter = loadExport()
  const sanitized = exporter.sanitizeDiscoveryForExport({
    rejected: [
      { url: 'https://example.com/private/profile/alice?token=secret#section', reason: 'external-origin' },
      { url: 'https://mpc.test/duplicates?page=2', reason: 'duplicate' }
    ]
  })

  assert.equal(sanitized.rejected[0].url, 'https://example.com/[REDACTED_EXTERNAL_PATH]')
  assert.equal(sanitized.rejected[0].reason, 'external-origin')
  assert.equal(sanitized.rejected[1].url, 'https://mpc.test/duplicates?page=2')
})

test('text export redacts common email and MPC key patterns', () => {
  const exporter = loadExport()
  const value = exporter.redactText('owner@example.test uses mpc_ext_abcdefghijklmnop')

  assert.doesNotMatch(value, /owner@example\.test/)
  assert.doesNotMatch(value, /mpc_ext_abcdefghijklmnop/)
  assert.match(value, /\[REDACTED_EMAIL\]/)
  assert.match(value, /\[REDACTED_MPC_API_KEY\]/)
})
