/**
 * REPAIR 5 (R14) — Encoding guard for DECISIONS.log.
 * R14-EXTENDED — generalized to every governance artifact: DECISIONS.log,
 * MERGE_REPORT.md and every docs/**\/*.md file the project treats as an audit
 * trail.
 *
 * For each covered file the guard asserts:
 *  - zero NUL bytes (the UTF-16LE fingerprint: NULs between ASCII characters),
 *  - strict UTF-8 decode succeeds (TextDecoder fatal),
 *  - a byte-lossless UTF-8 round-trip.
 *
 * The companion test injects a NUL into a temp copy of EVERY covered file and
 * asserts the guard rejects it — the executable fail-then-pass proof. The
 * remediation history this guard was extracted from: DECISIONS.log (Phase 11)
 * and MERGE_REPORT.md (Phase 11 + R13 sections), both of which carried UTF-16LE
 * runs in a UTF-8 file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'node:os'
import path from 'node:path'

/** Assert a byte buffer is clean UTF-8; returns the decoded text. */
function assertCleanUtf8(label: string, raw: Buffer): string {
  assert.ok(!raw.includes(0), `${label} contains NUL bytes — not clean UTF-8`)

  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    assert.fail(`${label} is not valid strict UTF-8`)
  }

  const reEncoded = Buffer.from(text, 'utf-8')
  assert.strictEqual(reEncoded.length, raw.length, `${label} UTF-8 round-trip changed byte length`)
  assert.ok(reEncoded.equals(raw), `${label} UTF-8 round-trip changed byte content`)
  return text
}

/** Every governance artifact the project treats as an audit trail (repo-root relative). */
function governanceArtifacts(): string[] {
  const root = process.cwd()
  const artifacts = ['DECISIONS.log', 'MERGE_REPORT.md']
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else if (entry.name.endsWith('.md')) artifacts.push(rel)
    }
  }
  walk(path.join(root, 'docs'), 'docs')
  return artifacts
}

test('all governance artifacts decode as strict UTF-8 with no NUL bytes', () => {
  const artifacts = governanceArtifacts()
  for (const rel of ['DECISIONS.log', 'MERGE_REPORT.md', 'docs/PROVENANCE.md']) {
    assert.ok(artifacts.includes(rel), `${rel} is covered by the governance guard`)
  }
  for (const rel of artifacts) {
    const raw = fs.readFileSync(path.join(process.cwd(), rel)) // throws if a covered artifact vanished
    assertCleanUtf8(rel, raw)
  }

  // Spot-check a line that lived inside DECISIONS.log's UTF-16LE section
  // (Phase 11 review agent) — recovered text must still be readable.
  const decisions = assertCleanUtf8('DECISIONS.log', fs.readFileSync(path.join(process.cwd(), 'DECISIONS.log')))
  const phase11Line = decisions.split('\n').find((line) => line.includes('PHASE 11 (review agent)'))
  assert.ok(phase11Line, 'Expected PHASE 11 section header in DECISIONS.log')
  assert.ok(phase11Line!.includes('GATE PASS'), 'PHASE 11 section header should contain GATE PASS')

  // Spot-check the MERGE_REPORT.md text recovered from its UTF-16LE regions.
  const merge = assertCleanUtf8('MERGE_REPORT.md', fs.readFileSync(path.join(process.cwd(), 'MERGE_REPORT.md')))
  assert.ok(merge.includes('Repair 3 — Coverage check at consumption point (R3)'), 'MERGE_REPORT R3 section is greppable')
  assert.ok(merge.includes('## Addendum — Phase 11: Review Agent (f11)'), 'MERGE_REPORT Phase 11 addendum is greppable')
})

test('encoding guard FAILS on a NUL-injected copy of every governance artifact (fail-then-pass proof)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-encoding-guard-'))
  try {
    for (const rel of governanceArtifacts()) {
      const raw = fs.readFileSync(path.join(process.cwd(), rel))
      // Inject a NUL mid-file (the exact defect class: NULs between ASCII chars).
      const at = Math.min(4096, raw.length - 1)
      const injected = Buffer.concat([raw.subarray(0, at), Buffer.from([0]), raw.subarray(at)])
      const copy = path.join(tmp, rel.replace(/[\\/]/g, '__'))
      fs.writeFileSync(copy, injected)
      assert.throws(
        () => assertCleanUtf8(rel + ' (NUL-injected)', fs.readFileSync(copy)),
        /NUL bytes/,
        `${rel}: the guard must reject a NUL-injected copy`,
      )
    }

    // The strict-UTF-8 half of the guard also rejects an invalid byte sequence.
    const decisions = fs.readFileSync(path.join(process.cwd(), 'DECISIONS.log'))
    const at = Math.min(4096, decisions.length - 1)
    const badBytes = Buffer.concat([decisions.subarray(0, at), Buffer.from([0x80]), decisions.subarray(at)])
    assert.throws(
      () => assertCleanUtf8('DECISIONS.log (invalid sequence)', badBytes),
      /NUL bytes|strict UTF-8/,
      'the guard must reject an invalid UTF-8 byte sequence',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
