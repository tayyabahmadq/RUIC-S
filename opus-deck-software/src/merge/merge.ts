/**
 * Phase 9: merge() — gate then copy WORKSPACE/** to outputDir with
 * later-transaction-wins conflict resolution, logging every override.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { z } from 'zod'
import { CommonsError } from './errors.js'
import { checkReadiness, isGatePassed, loadTransactions } from './verify-build.js'
import type { GateSeverity } from './verify-build.js'
import { countLoc, ensureDir, normalizeRel, pathExists, walkFiles } from './fs-utils.js'
import type { Manifest, ManifestEntry, OverrideRecord } from './types.js'

/**
 * Phase 3 (gate severity, R5): `failOn` is THE resolved gate severity value,
 * injected once at wiring. Absent = the shipped default ("critical").
 */
export interface MergeOptions {
  readonly failOn?: GateSeverity
}

const ManifestEntrySchema = z.object({
  path: z.string(), loc: z.number().int().nonnegative(), txn: z.string(),
  sha256: z.string(), bytes: z.number().int().nonnegative(),
})

export const ManifestSchema = z.object({
  version: z.literal(1), createdAt: z.string(), memoryDir: z.string(),
  files: z.array(ManifestEntrySchema),
  overrides: z.array(z.object({ path: z.string(), winner: z.string(), losers: z.array(z.string()) })),
  totalFiles: z.number().int().nonnegative(), totalLoc: z.number().int().nonnegative(),
})

function snapshotCandidate(memoryDir: string, txnId: string, rel: string): string {
  return path.join(memoryDir, 'DELTA', txnId, 'files', ...rel.split('/'))
}

async function readSnapshotIfPresent(memoryDir: string, txnId: string, rel: string): Promise<Buffer | null> {
  const cands = [snapshotCandidate(memoryDir, txnId, rel), path.join(memoryDir, 'DELTA', txnId, ...rel.split('/'))]
  for (const c of cands) {
    if (await pathExists(c)) {
      const st = await fs.promises.stat(c)
      if (st.isFile()) return fs.promises.readFile(c)
    }
  }
  return null
}

export async function merge(memoryDir: string, outputDir: string, options: MergeOptions = {}): Promise<Manifest> {
  if (!(await pathExists(memoryDir))) {
    throw new CommonsError(`memory dir not found: ${memoryDir}`, 'MEMORY_DIR_MISSING')
  }
  const workspaceDir = path.join(memoryDir, 'WORKSPACE')
  if (!(await pathExists(workspaceDir))) {
    throw new CommonsError(`WORKSPACE not found: ${workspaceDir}`, 'WORKSPACE_MISSING')
  }

  const checks = await checkReadiness(memoryDir, {
    ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
  })
  if (!isGatePassed(checks)) {
    const failing = checks.filter((c) => !c.passed)
    throw new CommonsError(
      `pre-merge gate failed: ${failing.map((c) => c.id).join(', ')}`,
      'GATE_FAILED',
      JSON.stringify(failing),
    )
  }

  const txns = await loadTransactions(memoryDir)
  const workspaceFiles = await walkFiles(workspaceDir)

  const writers = new Map<string, string[]>()
  function addWriter(rel: string, txnId: string): void {
    const key = normalizeRel(rel)
    const arr = writers.get(key) ?? []
    if (!arr.includes(txnId)) arr.push(txnId)
    writers.set(key, arr)
  }

  const order = new Map<string, number>()
  txns.forEach((t, i) => order.set(t.id, i))
  for (const t of txns) for (const f of t.files) addWriter(f, t.id)
  for (const f of workspaceFiles) {
    const key = normalizeRel(f)
    if (!writers.has(key)) addWriter(key, txns.length > 0 ? txns[txns.length - 1].id : 'workspace')
  }
  for (const arr of writers.values()) {
    arr.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1))
  }

  const overrides: OverrideRecord[] = []
  for (const [rel, arr] of writers) {
    if (arr.length > 1) overrides.push({ path: rel, winner: arr[arr.length - 1], losers: arr.slice(0, -1) })
  }
  overrides.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const hasAnySnapshot = async (): Promise<boolean> => {
    for (const t of txns) for (const f of t.files) {
      if ((await readSnapshotIfPresent(memoryDir, t.id, f)) !== null) return true
    }
    return false
  }
  const useReplay = txns.length > 0 && await hasAnySnapshot()

  const staged = new Map<string, Buffer>()
  if (useReplay) {
    for (const t of txns) {
      for (const f of t.files) {
        const key = normalizeRel(f)
        const snap = await readSnapshotIfPresent(memoryDir, t.id, key)
        if (snap !== null) staged.set(key, snap)
        else if (!staged.has(key)) {
          const w = path.join(workspaceDir, ...key.split('/'))
          if (await pathExists(w)) {
            const st = await fs.promises.stat(w)
            if (st.isFile()) staged.set(key, await fs.promises.readFile(w))
          }
        }
      }
    }
    for (const f of workspaceFiles) {
      const key = normalizeRel(f)
      if (!staged.has(key)) {
        const w = path.join(workspaceDir, ...key.split('/'))
        staged.set(key, await fs.promises.readFile(w))
      }
    }
  } else {
    for (const f of workspaceFiles) {
      const key = normalizeRel(f)
      const w = path.join(workspaceDir, ...key.split('/'))
      staged.set(key, await fs.promises.readFile(w))
    }
  }

  await ensureDir(outputDir)
  const entries: ManifestEntry[] = []
  for (const rel of [...staged.keys()].sort()) {
    const buf = staged.get(rel) as Buffer
    const dest = path.join(outputDir, ...rel.split('/'))
    await ensureDir(path.dirname(dest))
    await fs.promises.writeFile(dest, buf)
    const arr = writers.get(rel) ?? []
    const lastTxn = arr.length > 0 ? arr[arr.length - 1] : (txns.length > 0 ? txns[txns.length - 1].id : 'workspace')
    entries.push({
      path: rel, loc: countLoc(buf.toString('utf8')), txn: lastTxn,
      sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength,
    })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const manifest: Manifest = {
    version: 1, createdAt: new Date().toISOString(), memoryDir: path.resolve(memoryDir),
    files: entries, overrides, totalFiles: entries.length,
    totalLoc: entries.reduce((n, e) => n + e.loc, 0),
  }

  await fs.promises.writeFile(path.join(outputDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const lines = overrides.length === 0
    ? ['no overrides']
    : overrides.map((o) => `${o.path} winner=${o.winner} losers=${o.losers.join(',')}`)
  await fs.promises.writeFile(path.join(outputDir, 'OVERRIDES.log'), lines.join('\n') + '\n', 'utf8')

  return manifest
}

export async function readManifest(outputDir: string): Promise<Manifest> {
  const file = path.join(outputDir, 'MANIFEST.json')
  if (!(await pathExists(file))) throw new CommonsError(`MANIFEST.json not found: ${file}`, 'NO_MANIFEST')
  const raw = await fs.promises.readFile(file, 'utf8')
  let data: unknown
  try { data = JSON.parse(raw) as unknown } catch (err) {
    throw new CommonsError(`unparsable MANIFEST.json: ${file}`, 'UNPARSABLE_MANIFEST', err instanceof Error ? err.message : String(err))
  }
  const parsed = ManifestSchema.safeParse(data)
  if (!parsed.success) {
    throw new CommonsError(`invalid MANIFEST.json: ${file}`, 'INVALID_MANIFEST', parsed.error.message)
  }
  return parsed.data
}
