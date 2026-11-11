/**
 * Phase 10 smoke test — CLI & surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTokens, formatDuration, formatSeverity } from './types.js'
import { Commands } from './commands.js'
import { renderDashboard, replayFromDelta } from './dashboard.js'

test('format helpers', () => {
  assert.ok(formatTokens(4000, 1234).includes('1.2k'))
  assert.strictEqual(formatDuration(61234), '1:01.2')
  assert.ok(formatSeverity('critical', false).includes('critical'))
  assert.ok(formatSeverity('high', true).includes('resolved'))
})

test('Commands map has the five commands', () => {
  for (const cmd of ['run', 'status', 'crew', 'report', 'config']) {
    assert.ok(Commands.has(cmd), `command ${cmd} registered`)
  }
})

test('renderDashboard / replayFromDelta', () => {
  const events: [string, unknown][] = [['run.started', { runId: 'r1' }], ['task.completed', { taskId: 'T-01' }]]
  const state = replayFromDelta(events, 'r1')
  assert.strictEqual(state.runId, 'r1')
  assert.strictEqual(state.events.length, 2)
  const out = renderDashboard(state)
  assert.ok(out.includes('r1'))
  assert.ok(out.includes('task.completed'))
})
