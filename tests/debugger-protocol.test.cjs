const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const compat = require('../runner-debugger.js');

test('prefers stable CDP 1.3 before legacy 0.1', () => {
  assert.deepEqual(compat.protocolCandidates('0.1'), ['1.3', '0.1']);
});

test('falls back when a protocol version is unsupported', async () => {
  const attempts = [];
  const nativeAttach = async (_target, version) => {
    attempts.push(version);
    if (version === '1.3') throw new Error('Requested protocol version is not supported: 1.3.');
  };

  const version = await compat.attachWithFallback(nativeAttach, { tabId: 42 }, '0.1');

  assert.equal(version, '0.1');
  assert.deepEqual(attempts, ['1.3', '0.1']);
});

test('does not swallow non-version debugger errors', async () => {
  const nativeAttach = async () => {
    throw new Error('Another debugger is already attached to the tab');
  };

  await assert.rejects(
    compat.attachWithFallback(nativeAttach, { tabId: 42 }, '0.1'),
    /already attached/
  );
});

test('runner loads protocol compatibility before crawl startup', () => {
  const html = fs.readFileSync('runner.html', 'utf8');
  const compatIndex = html.indexOf('runner-debugger.js');
  const crawlIndex = html.indexOf('runner-crawl.js');

  assert.ok(compatIndex >= 0, 'runner-debugger.js must be loaded');
  assert.ok(crawlIndex >= 0, 'runner-crawl.js must be loaded');
  assert.ok(compatIndex < crawlIndex, 'protocol compatibility must load before crawler startup');
});
