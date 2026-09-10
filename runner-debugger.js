(() => {
  const PREFERRED_PROTOCOL_VERSIONS = ['1.3', '0.1'];

  function isProtocolVersionError(error) {
    return /protocol version|version is not supported|unsupported.*version|not supported.*(?:0\.1|1\.3)/i.test(
      error?.message || String(error || '')
    );
  }

  function protocolCandidates(requestedVersion) {
    return [...new Set([...PREFERRED_PROTOCOL_VERSIONS, requestedVersion].filter(Boolean))];
  }

  async function attachWithFallback(nativeAttach, target, requestedVersion) {
    let lastError = null;

    for (const version of protocolCandidates(requestedVersion)) {
      try {
        await nativeAttach(target, version);
        return version;
      } catch (error) {
        lastError = error;
        if (!isProtocolVersionError(error)) throw error;
      }
    }

    throw lastError || new Error('Unable to attach the Chrome debugger.');
  }

  function install(debuggerApi, onAttached = () => {}) {
    if (!debuggerApi?.attach || debuggerApi.__siteLensAttachCompatInstalled) return;

    const nativeAttach = debuggerApi.attach.bind(debuggerApi);
    const wrappedAttach = async (target, requestedVersion) => {
      const negotiatedVersion = await attachWithFallback(nativeAttach, target, requestedVersion);
      onAttached(negotiatedVersion);
    };

    try {
      debuggerApi.attach = wrappedAttach;
    } catch {}

    if (debuggerApi.attach !== wrappedAttach) {
      try {
        Object.defineProperty(debuggerApi, 'attach', {
          value: wrappedAttach,
          configurable: true,
          writable: true
        });
      } catch {}
    }

    if (debuggerApi.attach !== wrappedAttach) {
      throw new Error('SiteLens could not install Chrome debugger protocol compatibility.');
    }

    try {
      Object.defineProperty(debuggerApi, '__siteLensAttachCompatInstalled', {
        value: true,
        configurable: true
      });
    } catch {
      debuggerApi.__siteLensAttachCompatInstalled = true;
    }
  }

  const api = { PREFERRED_PROTOCOL_VERSIONS, isProtocolVersionError, protocolCandidates, attachWithFallback, install };

  if (typeof globalThis !== 'undefined') globalThis.SiteLensDebuggerCompat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof chrome !== 'undefined' && chrome.debugger) {
    install(chrome.debugger, (version) => {
      try {
        if (typeof report !== 'undefined' && report?.collector) {
          report.collector.cdpProtocolVersion = version;
        }
      } catch {}
    });
  }
})();
