/**
 * Phase E3-REPAIR (R24, family closure): the f11 REVIEW AGENT terminates on
 * `done`.
 *
 * `ReviewAgent.callTransport` iterated the phase-02 chunk iterable without
 * terminating on `done`, concatenating every text chunk. This is the fourth and
 * last member of the R24 family (crew worker E1/R21, leader adapter E2/R24,
 * compactor shared helper E3/R24).
 *
 * It is the WORST of the four, and that is why it was repaired explicitly: the
 * answer to this call is FINDINGS JSON, parsed by parseReviewOutput. A post-done
 * chunk appended to the array makes the JSON unparsable, and BOTH parsers fail
 * soft - parseReviewOutput and parseReflectOutput return [] on unparseable
 * input. So the failure mode is not a loud error; it is a security review that
 * reports ZERO findings because it could not read its own output.
 *
 * The stub emits the full canonical grammar - findings JSON split in two (to
 * prove concatenation), then usage, then done - followed by a post-done chunk
 * carrying a unique marker. The test asserts the findings parse cleanly AND
 * that the marker appears NOWHERE: not in the parsed result, not in the
 * persisted STATE/findings.json, not in the reviews/<runId>.json audit.
 *
 * It MUST fail on pre-fix code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from '../wiring/index.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'
import type { Finding as F08Finding, RuleId } from '../audit/types.js'

/** The unique marker a post-`done` chunk would carry if it were consumed. */
const LEAK = 'POST-DONE-LEAK-MUST-NOT-BE-CONSUMED'

const DIRTY = 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\n'

/** One real finding, so a successful parse is provable rather than vacuous. */
const FINDINGS_JSON = JSON.stringify([
  {
    ruleId: 'SEC-004',
    path: 'WORKSPACE/src/app.ts',
    line: 1,
    evidence: 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";',
    message: 'Hardcoded API token',
    patchStrategy: 'env-var',
  },
])

/**
 * text (split in two) -> usage -> done -> a post-done leak chunk, on BOTH the
 * review call and the reflect call.
 */
function leakyReviewerTransport(): F02Transport {
  return {
    async *complete(): AsyncIterable<TransportChunk> {
      const req = arguments[0] as { messages: { content: string }[] }
      const prompt = req.messages.map((m) => m.content).join('\n')
      const body = prompt.includes('verdict') || prompt.toLowerCase().includes('reflect')
        ? JSON.stringify([{ findingId: 'unknown', verdict: 'confirmed' }])
        : FINDINGS_JSON
      const cut = Math.max(1, Math.floor(body.length / 2))
      yield { type: 'text', text: body.slice(0, cut) }
      yield { type: 'text', text: body.slice(cut) }
      yield { type: 'usage', inputTokens: 25, outputTokens: 15 }
      yield { type: 'done', finishReason: 'stop' }
      // Unreachable once the reviewer terminates on done.
      yield { type: 'text', text: LEAK }
    },
  }
}

test('R24: the review agent terminates on done - a post-done chunk reaches neither the findings, the persisted rows, nor the review audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e3r-review-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const runtime = initOpusDeck({
      memoryDir, outputDir: path.join(root, 'OUTPUT'),
      brief: 'build an app', goalState: ['app builds'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'lead-model', contextWindowTokens: 4096 },
        engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-model', contextWindowTokens: 4096 }],
        security: [
          { id: 'sec-1', provider: 'custom', model: 'sec-model', contextWindowTokens: 4096 },
          { id: 'sec-2', provider: 'custom', model: 'sec-model-2', contextWindowTokens: 4096 },
        ],
      },
    })
    const wired = await wireOpusDeck(runtime, {
      transport: leakyReviewerTransport(),
      leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(appPath, DIRTY, 'utf8')

    // Pre-fix this returns ZERO findings (the parsers fail soft) - which is the
    // whole point: the corruption is SILENT. Measured pre-fix vs post-fix on the
    // identical stub: 0 findings / "no findings" in the audit, versus 1 finding /
    // the finding recorded. No error, no exception - a security review that
    // passes a file it could not read.
    //
    // WHICH ASSERTION DISCRIMINATES: it is assertion (1), the parse. Pre-fix,
    // the post-done text makes the JSON unparsable and the parser returns [],
    // so nothing is ever persisted and the LEAK MARKER never reaches the audit
    // in EITHER state - the parse failure masks it. Assertions (2) and (3) are
    // therefore guards against a future variant in which a post-done chunk
    // reaches a persisted surface, not additional proofs.
    const result = await wired.f11.reviewAgent.review({
      runId: 'run-e3r',
      brief: 'build an app',
      goalState: ['app builds'],
      memoryDir,
    })

    // 1. The findings JSON parsed cleanly, and it is a REAL finding - so the
    //    assertion above cannot pass vacuously by being empty.
    assert.strictEqual(result.findings.length, 1, 'exactly one finding was parsed from the split text chunks')
    assert.strictEqual(result.findings[0].ruleId, 'SEC-004', 'the parsed finding is the SEC-004')
    assert.ok(
      !JSON.stringify(result.findings).includes(LEAK),
      'the post-done chunk is NOT in the parsed result',
    )

    // 2. Not in the persisted findings.
    const toPersist: F08Finding[] = result.findings.map((f) => ({
      id: f.id,
      ruleId: f.ruleId as RuleId,
      severity: f.severity,
      path: f.path,
      detectorModelId: f.ruleId,
      resolved: false,
      evidence: f.evidence,
      message: f.message,
      line: f.line,
      patchStrategy: f.patchStrategy,
      auditorCount: 1,
      blocking: f.blocking,
    }))
    await wired.persistFindings(toPersist)
    const persistedRaw = fs.readFileSync(path.join(memoryDir, 'STATE', 'findings.json'), 'utf8')
    assert.ok(!persistedRaw.includes(LEAK), 'the post-done chunk is NOT in the persisted findings')

    // 3. Not in the review audit.
    const auditPath = path.join(memoryDir, 'STATE', 'folder-11', 'reviews', 'run-e3r.json')
    assert.ok(fs.existsSync(auditPath), 'the review audit file was written')
    const auditRaw = fs.readFileSync(auditPath, 'utf8')
    assert.ok(!auditRaw.includes(LEAK), 'the post-done chunk is NOT in the reviews/<runId>.json audit')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})