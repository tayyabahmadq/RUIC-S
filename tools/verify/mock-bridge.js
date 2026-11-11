// UI visual-check harness — mock bridge for the Control Deck renderer.
//
// Loaded as a same-origin <script> BEFORE app.js (CSP `script-src 'self'` is
// intact), so `boot()` finds a `window.__deckBridge__` and the real renderer
// code runs unmodified against scripted events. `window.__mock` lets the
// Playwright driver push batches through the real subscribe path in stages
// (idle → mid-run → completed), exactly like the live IPC would.
;(function () {
  if (typeof window === 'undefined') return

  var CREW = [
    { id: 'lead', role: 'lead', healthy: true, detail: 'gpt-5 · paid' },
    { id: 'eng-1', role: 'engineer', healthy: true, detail: 'qwen2.5-coder:1.5b' },
    { id: 'sec-1', role: 'security', healthy: true, detail: 'qwen2.5-coder:1.5b' },
    { id: 'sec-2', role: 'security', healthy: false, detail: 'qwen2.5-coder:1.5b' },
  ]

  var seq = 0
  function at(i) {
    return new Date(Date.now() - 260000 + i * 9000).toISOString()
  }
  function ev(type, payload) {
    seq += 1
    return { id: 'e' + seq, type: type, payload: payload, at: at(seq) }
  }

  var MIDRUN = [
    ev('run.started', { runId: 'run-01', brief: 'build a trivial app', goalState: ['app builds'] }),
    ev('laya.routed', { runId: 'run-01', decision: 'local', score: 1, reasons: ['trivial brief — fully local routing, zero paid calls'] }),
    ev('phase.change', { runId: 'run-01', phase: 'planning' }),
    ev('presence.update', { runId: 'run-01', modelId: 'lead', role: 'lead', status: 'planning' }),
    ev('task.claimed', { runId: 'run-01', taskId: 'T-01', file: 'src/index.html', holder: 'eng-1' }),
    ev('presence.update', { runId: 'run-01', modelId: 'eng-1', role: 'engineer', status: 'working', taskId: 'T-01' }),
    ev('token.use', { runId: 'run-01', inputTokens: 820, outputTokens: 410 }),
    ev('task.completed', { runId: 'run-01', taskId: 'T-01' }),
    ev('phase.change', { runId: 'run-01', phase: 'auditing' }),
    ev('finding.raised', { runId: 'run-01', findingId: 'FND-1', severity: 'high', path: 'src/index.html', line: 14, message: 'Inline script tag without nonce' }),
    ev('finding.raised', { runId: 'run-01', findingId: 'FND-2', severity: 'low', path: 'src/app.js', line: 42, message: 'Unused variable x' }),
    ev('phase.change', { runId: 'run-01', phase: 'patching' }),
    ev('finding.resolved', { runId: 'run-01', findingId: 'FND-1' }),
    ev('zeak.fallback', { runId: 'run-01', taskId: null, from: 'gpt-5', to: 'qwen2.5-coder:1.5b', reason: 'dept cap' }),
    ev('learning.guide_added', { runId: 'run-01', signature: '{E:css-var-typo}', guide: 'verify CSS variable names before writing', occurrences: 3 }),
    ev('phase.change', { runId: 'run-01', phase: 'merging' }),
    ev('token.use', { runId: 'run-01', inputTokens: 300, outputTokens: 180 }),
  ]

  var COMPLETE = MIDRUN.concat([
    ev('run.completed', { runId: 'run-01', checksum: 'a1b2c3', fileCount: 3 }),
    ev('preview.state', { runId: 'run-01', open: true, currentFile: 'index.html', files: ['index.html', 'app.js', 'style.css', 'MANIFEST.json'] }),
  ])

  var subscriber = null
  function batch(events, base) {
    return { events: events, replayBase: base, at: new Date().toISOString() }
  }

  window.__deckBridge__ = {
    events: {
      subscribe: function (cb) {
        subscriber = cb
        return function () {}
      },
      replay: function () {
        return batch([], 0)
      },
    },
    invoke: function (cmd) {
      return Promise.resolve().then(function () {
        if (cmd.type === 'crewHealth') return { ok: true, data: { crew: CREW } }
        if (cmd.type === 'run') return { ok: true, data: { runId: 'run-01' } }
        if (cmd.type === 'abort') return { ok: true, data: { aborted: true, releasedLocks: 2 } }
        if (cmd.type === 'preview') {
          return { ok: true, data: { open: cmd.payload.action === 'open', currentFile: cmd.payload.file || 'index.html', files: ['index.html', 'app.js', 'style.css', 'MANIFEST.json'] } }
        }
        return { ok: false, error: 'unmocked command' }
      })
    },
  }

  window.__mock = {
    pushMidrun: function () {
      if (subscriber) subscriber(batch(MIDRUN, 0))
    },
    pushComplete: function () {
      if (subscriber) subscriber(batch(COMPLETE, MIDRUN.length))
    },
  }
})()
