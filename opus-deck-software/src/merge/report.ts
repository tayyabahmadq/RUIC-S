/**
 * Phase 9: deterministic REPORT.md generation.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { CommonsError } from './errors.js'
import { loadClaims, loadCriteria, loadFindings, loadTransactions, loadVerifications } from './verify-build.js'
import { ensureDir, pathExists, walkFiles } from './fs-utils.js'
import type { Manifest, ReportOptions } from './types.js'

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

async function loadLeadModel(memoryDir: string): Promise<string> {
  const file = path.join(memoryDir, 'STATE', 'presence.json')
  if (!(await pathExists(file))) return 'lead'
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const lead = data['lead']
    if (typeof lead === 'string' && lead.length > 0) return lead
    const leadModel = data['leadModel']
    if (typeof leadModel === 'string' && leadModel.length > 0) return leadModel
  } catch { return 'lead' }
  return 'lead'
}

async function loadCompactionCount(memoryDir: string): Promise<number> {
  const file = path.join(memoryDir, 'STATE', 'compaction.json')
  if (!(await pathExists(file))) return 0
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const c = data['count']
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return c
  } catch { return 0 }
  return 0
}

export function checksumForManifest(manifest: Manifest): string {
  const lines = [...manifest.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

async function loadManifestForReport(memoryDir: string, options: ReportOptions): Promise<Manifest | null> {
  if (options.manifest !== undefined) return options.manifest
  const candidates = [path.join(memoryDir, 'MANIFEST.json'), path.join(memoryDir, 'WORKSPACE', 'MANIFEST.json')]
  for (const c of candidates) {
    if (await pathExists(c)) {
      try {
        const raw = await fs.promises.readFile(c, 'utf8')
        return JSON.parse(raw) as Manifest
      } catch { continue }
    }
  }
  return null
}

export async function generateReport(memoryDir: string, options: ReportOptions = {}): Promise<string> {
  if (!(await pathExists(memoryDir))) {
    throw new CommonsError(`memory dir not found: ${memoryDir}`, 'MEMORY_DIR_MISSING')
  }

  const txns = await loadTransactions(memoryDir)
  const findings = await loadFindings(memoryDir)
  const criteria = await loadCriteria(memoryDir)
  const verifications = await loadVerifications(memoryDir)
  await loadClaims(memoryDir)

  const manifest = await loadManifestForReport(memoryDir, options)

  const authorByTxn = new Map<string, string>()
  for (const t of txns) authorByTxn.set(t.id, t.author)

  const locByModel = new Map<string, { files: string[]; loc: number }>()
  function addLoc(model: string, file: string, loc: number): void {
    const e = locByModel.get(model) ?? { files: [], loc: 0 }
    e.files.push(file); e.loc += loc; locByModel.set(model, e)
  }

  if (manifest !== null) {
    for (const f of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const model = authorByTxn.get(f.txn) ?? 'unknown'
      addLoc(model, f.path, f.loc)
    }
  } else {
    const ws = path.join(memoryDir, 'WORKSPACE')
    const files = (await pathExists(ws)) ? await walkFiles(ws) : []
    const writerOf = new Map<string, string>()
    for (const t of txns) for (const f of t.files) writerOf.set(f, t.id)
    const lastTxn = txns.length > 0 ? txns[txns.length - 1].id : 'workspace'
    for (const rel of files) {
      const buf = await fs.promises.readFile(path.join(ws, ...rel.split('/')), 'utf8')
      const loc = buf.length === 0 ? 0 : buf.split('\n').length
      const txn = writerOf.get(rel) ?? lastTxn
      addLoc(authorByTxn.get(txn) ?? 'unknown', rel, loc)
    }
  }

  const leadModel = options.leadModel ?? (await loadLeadModel(memoryDir))
  const compactionCount = options.compactionCount ?? (await loadCompactionCount(memoryDir))
  const checksum = options.checksum ?? (manifest !== null ? checksumForManifest(manifest) : await (async () => {
    const ws = path.join(memoryDir, 'WORKSPACE')
    if (!(await pathExists(ws))) return createHash('sha256').update('').digest('hex')
    const h = createHash('sha256')
    for (const rel of await walkFiles(ws)) {
      const buf = await fs.promises.readFile(path.join(ws, ...rel.split('/')))
      h.update(`${rel}:${createHash('sha256').update(buf).digest('hex')}\n`)
    }
    return h.digest('hex')
  })())
  const timestamp = options.timestamp ?? (manifest?.createdAt ?? new Date().toISOString())

  const L: string[] = []
  L.push('# Build Report', '', '## Crew', '', '| Model | Files | LOC | Paths |', '| --- | ---: | ---: | --- |')
  const models = [...locByModel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  if (models.length === 0) L.push('| (none) | 0 | 0 | - |')
  else for (const [model, v] of models) {
    const paths = v.files.slice().sort().join(', ')
    L.push(`| ${mdEscapeCell(model)} | ${v.files.length} | ${v.loc} | ${mdEscapeCell(paths === '' ? '-' : paths)} |`)
  }
  L.push('', '## Findings', '', '| Severity | Location | Detector | Resolved |', '| --- | --- | --- | --- |')
  const sortedFindings = [...findings].sort((a, b) =>
    a.severity < b.severity ? -1 : a.severity > b.severity ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? -1) - (b.line ?? -1))
  if (sortedFindings.length === 0) L.push('| (none) | - | - | - |')
  else for (const f of sortedFindings) {
    const loc = f.line !== undefined ? `${f.path}:${f.line}` : f.path
    L.push(`| ${mdEscapeCell(f.severity)} | ${mdEscapeCell(loc)} | ${mdEscapeCell(f.detector)} | ${f.resolved ? 'yes' : 'no'} |`)
  }
  L.push('', '## Goal-State Verification', '', '| Criterion | Status | Evidence |', '| --- | --- | --- |')
  const verById = new Map(verifications.map((v) => [v.criterionId, v]))
  for (const c of [...criteria].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const v = verById.get(c.id)
    L.push(`| ${mdEscapeCell(`${c.id}: ${c.description}`)} | ${mdEscapeCell(v?.status ?? 'pending')} | ${mdEscapeCell(v?.evidence ?? '-')} |`)
  }
  L.push('', '## Sign-off', '', `- Lead model: ${mdEscapeCell(leadModel)}`, `- Checksum: ${checksum}`, `- Timestamp: ${timestamp}`, `- Compaction count: ${compactionCount}`, '')
  return L.join('\n')
}

export async function writeReport(memoryDir: string, outPath: string, options: ReportOptions = {}): Promise<string> {
  const content = await generateReport(memoryDir, options)
  await ensureDir(path.dirname(path.resolve(outPath)))
  await fs.promises.writeFile(outPath, content, 'utf8')
  return content
}
