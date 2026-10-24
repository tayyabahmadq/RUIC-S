/**
 * Opus//DECK — Phase 3: Commons Core.
 * One directory of plain files. openCommons(memoryDir) returns the six
 * operation memory API. Every write appends to DELTA/txn.jsonl first, then
 * applies atomically (temp file + rename). Conflicting writes are queued as
 * "blocked" instead of dropped.
 */
import { promises as fsp } from 'fs'
import * as nodePath from 'path'
import type {
  Commons,
  Delta,
  DecisionEntry,
  DecisionId,
  DecisionRequest,
  Diff,
  PresenceEntry,
  ReadRange,
  SearchHit,
  TxnId,
  TxnStatus,
  WriteRequest,
} from './types.js'
import { CommonsError, ERROR_CODES } from './types.js'

/** Canonical COMMONS paths, relative to the memory directory. */
export const COMMONS_PATHS = {
  BRIEF: 'BRIEF.md',
  DECISIONS: 'DECISIONS.log',
  DIGEST: 'STATE/digest.md',
  PRESENCE: 'STATE/presence.json',
  TASKS: 'STATE/tasks.json',
  FINDINGS: 'STATE/findings.json',
  WORKSPACE: 'WORKSPACE',
  DELTA: 'DELTA',
  ARCHIVE: 'ARCHIVE',
  TXN_LOG: 'DELTA/txn.jsonl',
} as const

const TXN_ID_PATTERN = /^txn-(\d{6})$/
const DEC_ID_PATTERN = /^dec-(\d{6})$/
const SEARCH_MAX_HITS = 1000
const SEARCH_SNIPPET_MAX = 200

function isoNow(): string {
  return new Date().toISOString()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

/** Resolve `rel` inside `root`. Rejects empty, absolute, NUL, and escapes. */
function resolveInside(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new CommonsError(ERROR_CODES.PATH_EMPTY, 'path must be a non-empty string')
  }
  if (rel.includes('\0') || nodePath.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new CommonsError(ERROR_CODES.PATH_ESCAPE, `absolute paths are not allowed: ${rel}`, rel)
  }
  const abs = nodePath.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
    throw new CommonsError(ERROR_CODES.PATH_ESCAPE, `path escapes the memory directory: ${rel}`, rel)
  }
  return abs
}

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function countCompleteLines(raw: string): number {
  if (raw === '') return 0
  return raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0)
}

function validateDelta(raw: unknown): Delta | null {
  if (!isPlainObject(raw)) return null
  const txn = asString(raw.txn)
  if (txn === null || !TXN_ID_PATTERN.test(txn)) return null
  const ts = asString(raw.ts)
  if (ts === null) return null
  const p = asString(raw.path)
  if (p === null || p.length === 0) return null
  const intent = asString(raw.intent)
  if (intent === null) return null
  const author = asString(raw.author)
  if (author === null) return null
  const status = raw.status === 'applied' || raw.status === 'blocked' ? raw.status : null
  if (status === null) return null
  if (!isPlainObject(raw.diff)) return null
  const diff = raw.diff
  if (!Array.isArray(diff.added)) return null
  if (!diff.added.every((x) => typeof x === 'string')) return null
  if (diff.added.some((x) => x.includes('\n') || x.includes('\r'))) return null
  const removedLineCount = asNonNegativeInt(diff.removedLineCount)
  if (removedLineCount === null) return null
  const atLine = asNonNegativeInt(diff.atLine)
  if (atLine === null || atLine < 1) return null
  let claims: string[] | undefined
  if (raw.claims !== undefined) {
    if (!Array.isArray(raw.claims) || !raw.claims.every((x) => typeof x === 'string')) return null
    claims = raw.claims as string[]
  }
  return { txn, ts, path: p, intent, author, status, diff: { added: diff.added as string[], removedLineCount, atLine }, claims }
}

function parseDeltaLog(raw: string): Delta[] {
  const out: Delta[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    const d = validateDelta(parsed)
    if (d !== null) out.push(d)
  }
  return out
}

async function readDeltaLog(logAbs: string): Promise<Delta[]> {
  let raw: string
  try { raw = await fsp.readFile(logAbs, 'utf8') } catch (err) { if (errnoCode(err) === 'ENOENT') return []; throw err }
  return parseDeltaLog(raw)
}

/** Claim table derived from the delta log. */
function computeClaims(deltas: Delta[]): Map<string, string> {
  const claims = new Map<string, string>()
  for (const d of deltas) {
    if (d.status !== 'applied') continue
    if (d.claims) for (const p of d.claims) claims.set(p, d.author)
    if (!d.claims || !d.claims.includes(d.path)) claims.delete(d.path)
  }
  return claims
}

function maxTxnSeq(deltas: Delta[]): number {
  let max = 0
  for (const d of deltas) max = Math.max(max, Number(d.txn.slice(4)))
  return max
}

/** Optional claims authority seam (phase 5 locks authority). When set, the
 * write() claims gate consults it instead of (or in addition to) DELTA. */
let claimsAuthority: ((path: string) => string | undefined) | null = null

/** Install the claims authority used by Commons.write() to gate conflicting writes. */
export function setClaimsAuthority(fn: (path: string) => string | undefined): void {
  claimsAuthority = fn
}

/** Open (creating if missing) the COMMONS memory directory. Idempotent. */
export async function openCommons(memoryDir: string): Promise<Commons> {
  if (typeof memoryDir !== 'string' || memoryDir.trim().length === 0) {
    throw new CommonsError(ERROR_CODES.OPEN_INVALID_DIR, 'memoryDir must be a non-empty string')
  }
  const root = nodePath.resolve(memoryDir)
  await fsp.mkdir(root, { recursive: true })

  const initFiles: Array<[string, string]> = [
    [COMMONS_PATHS.BRIEF, '# Brief\n'],
    [COMMONS_PATHS.DECISIONS, ''],
    [COMMONS_PATHS.DIGEST, '# Digest\n\nOwned by the compactor.\n'],
    [COMMONS_PATHS.PRESENCE, JSON.stringify({ updated: isoNow(), entries: [] }, null, 2) + '\n'],
    [COMMONS_PATHS.TASKS, JSON.stringify({ tasks: [] }, null, 2) + '\n'],
    [COMMONS_PATHS.FINDINGS, JSON.stringify([]) + '\n'],
    [COMMONS_PATHS.TXN_LOG, ''],
  ]
  for (const [rel, content] of initFiles) {
    const abs = nodePath.join(root, rel)
    await fsp.mkdir(nodePath.dirname(abs), { recursive: true })
    try { await fsp.writeFile(abs, content, { flag: 'wx' }) } catch (err) { if (errnoCode(err) !== 'EEXIST') throw err }
  }
  for (const dir of [COMMONS_PATHS.WORKSPACE, COMMONS_PATHS.DELTA, COMMONS_PATHS.ARCHIVE]) {
    await fsp.mkdir(nodePath.join(root, dir), { recursive: true })
  }

  const logAbs = nodePath.join(root, COMMONS_PATHS.TXN_LOG)
  const decAbs = nodePath.join(root, COMMONS_PATHS.DECISIONS)
  for (const abs of [logAbs, decAbs]) {
    const raw = await fsp.readFile(abs, 'utf8')
    if (raw.length > 0 && !raw.endsWith('\n')) {
      const lastNl = raw.lastIndexOf('\n')
      await fsp.truncate(abs, lastNl + 1)
    }
  }

  let deltas = await readDeltaLog(logAbs)
  let txnCounter = Math.max(maxTxnSeq(deltas), countCompleteLines(await fsp.readFile(logAbs, 'utf8'))) + 1
  const nextTxnId = (): TxnId => `txn-${String(txnCounter++).padStart(6, '0')}`

  async function read(path: string, range?: ReadRange): Promise<string> {
    const abs = resolveInside(root, path)
    let stat
    try { stat = await fsp.stat(abs) } catch (err) { if (errnoCode(err) === 'ENOENT') throw new CommonsError(ERROR_CODES.READ_NOT_FOUND, `no such file: ${path}`, path); throw err }
    if (stat.isDirectory()) throw new CommonsError(ERROR_CODES.READ_NOT_A_FILE, `path is a directory: ${path}`, path)
    const content = await fsp.readFile(abs, 'utf8')
    if (range === undefined) return content
    if (!isPlainObject(range) || asNonNegativeInt(range.fromLine) === null || asNonNegativeInt(range.toLine) === null || range.fromLine < 1 || range.toLine < range.fromLine) {
      throw new CommonsError(ERROR_CODES.READ_RANGE_INVALID, 'range must satisfy 1 <= fromLine <= toLine')
    }
    const lines = splitLines(content)
    if (range.fromLine > lines.length) return ''
    const to = Math.min(range.toLine, lines.length)
    return lines.slice(range.fromLine - 1, to).join('\n')
  }

  async function write(req: WriteRequest): Promise<TxnId> {
    if (!isPlainObject(req)) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req must be an object')
    const p = asString(req.path)
    if (p === null || p.length === 0) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.path must be a non-empty string')
    const diff = req.diff
    if (!isPlainObject(diff)) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.diff must be an object')
    if (!Array.isArray(diff.added) || !diff.added.every((x) => typeof x === 'string')) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.diff.added must be an array of strings')
    if (diff.added.some((x) => x.includes('\n') || x.includes('\r'))) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.diff.added entries must be single lines')
    const removedLineCount = asNonNegativeInt(diff.removedLineCount)
    if (removedLineCount === null) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.diff.removedLineCount must be an integer >= 0')
    const atLine = asNonNegativeInt(diff.atLine)
    if (atLine === null || atLine < 1) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.diff.atLine must be an integer >= 1')
    const intent = asString(req.intent)
    if (intent === null) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.intent must be a string')
    const author = asString(req.author)
    if (author === null || author.length === 0) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.author must be a non-empty string')
    let claims: string[] | undefined
    if (req.claims !== undefined) {
      if (!Array.isArray(req.claims) || !req.claims.every((x) => typeof x === 'string')) throw new CommonsError(ERROR_CODES.WRITE_INVALID, 'req.claims must be an array of strings')
      claims = [...new Set(req.claims)]
    }

    const abs = resolveInside(root, p)

    // claims gate — evaluated BEFORE range validation so conflicts are queued (blocked).
    deltas = await readDeltaLog(logAbs)
    const claimer = claimsAuthority ? claimsAuthority(p) : computeClaims(deltas).get(p)
    const blocked = claimer !== undefined && claimer !== author

    let lines: string[] = []
    if (!blocked) {
      try {
        const stat = await fsp.stat(abs)
        if (stat.isDirectory()) throw new CommonsError(ERROR_CODES.TARGET_IS_DIRECTORY, `write target is a directory: ${p}`, p)
        lines = splitLines(await fsp.readFile(abs, 'utf8'))
      } catch (err) {
        if (err instanceof CommonsError) throw err
        if (errnoCode(err) !== 'ENOENT') throw err
      }
      if (atLine - 1 > lines.length || atLine + removedLineCount - 1 > lines.length) {
        throw new CommonsError(ERROR_CODES.DIFF_OUT_OF_RANGE, `diff out of range for ${p}`, p)
      }
    }

    const txn = nextTxnId()
    const entry: Delta = { txn, ts: isoNow(), path: p, intent, author, status: blocked ? 'blocked' : 'applied', diff: { added: diff.added.slice(), removedLineCount, atLine }, claims }
    await fsp.appendFile(logAbs, JSON.stringify(entry) + '\n')
    deltas.push(entry)

    if (!blocked) {
      const next = lines.slice(0, atLine - 1).concat(diff.added.slice(), lines.slice(atLine - 1 + removedLineCount))
      const tmp = nodePath.join(nodePath.dirname(abs), '.' + nodePath.basename(abs) + '.' + txn + '.tmp')
      try {
        await fsp.mkdir(nodePath.dirname(abs), { recursive: true })
        await fsp.writeFile(tmp, next.length > 0 ? next.join('\n') + '\n' : '')
        await fsp.rename(tmp, abs)
      } catch (err) {
        throw new CommonsError(ERROR_CODES.TXN_APPLY_FAILED, `transaction ${txn} logged but diff failed to apply to ${p}`, err instanceof Error ? err.message : String(err))
      }
    }
    return txn
  }

  async function decide(req: DecisionRequest): Promise<DecisionId> {
    if (!isPlainObject(req)) throw new CommonsError(ERROR_CODES.DECIDE_INVALID, 'req must be an object')
    const summary = asString(req.summary)
    if (summary === null) throw new CommonsError(ERROR_CODES.DECIDE_INVALID, 'req.summary must be a string')
    const rationale = asString(req.rationale)
    if (rationale === null) throw new CommonsError(ERROR_CODES.DECIDE_INVALID, 'req.rationale must be a string')
    const author = asString(req.author)
    if (author === null || author.length === 0) throw new CommonsError(ERROR_CODES.DECIDE_INVALID, 'req.author must be a non-empty string')
    const decAbs = nodePath.join(root, COMMONS_PATHS.DECISIONS)
    const raw = await fsp.readFile(decAbs, 'utf8')
    const id: DecisionId = `dec-${String(countCompleteLines(raw) + 1).padStart(6, '0')}`
    const entry: DecisionEntry = { id, ts: isoNow(), summary, rationale, author }
    await fsp.appendFile(decAbs, JSON.stringify(entry) + '\n')
    return id
  }

  async function sync(since?: TxnId): Promise<Delta[]> {
    if (since !== undefined && (typeof since !== 'string' || !TXN_ID_PATTERN.test(since))) {
      throw new CommonsError(ERROR_CODES.SYNC_UNKNOWN_SINCE, `unknown since transaction: ${String(since)}`, String(since))
    }
    const all = await readDeltaLog(logAbs)
    if (since === undefined) return all
    const idx = all.findIndex((d) => d.txn === since)
    if (idx === -1) throw new CommonsError(ERROR_CODES.SYNC_UNKNOWN_SINCE, `no transaction ${since} in DELTA/txn.jsonl`, since)
    return all.slice(idx + 1)
  }

  async function who(): Promise<PresenceEntry[]> {
    const abs = nodePath.join(root, COMMONS_PATHS.PRESENCE)
    let raw: string
    try { raw = await fsp.readFile(abs, 'utf8') } catch (err) { if (errnoCode(err) === 'ENOENT') return []; throw err }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (err) { throw new CommonsError(ERROR_CODES.PRESENCE_CORRUPT, 'STATE/presence.json is not valid JSON', err instanceof Error ? err.message : String(err)) }
    const corrupt = (why: string): CommonsError => new CommonsError(ERROR_CODES.PRESENCE_CORRUPT, `STATE/presence.json: ${why}`)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) throw corrupt('expected an object with an "entries" array')
    const out: PresenceEntry[] = []
    for (let i = 0; i < (parsed.entries as unknown[]).length; i++) {
      const e = (parsed.entries as unknown[])[i]
      if (!isPlainObject(e)) throw corrupt(`entries[${i}] is not an object`)
      const model = asString(e.model)
      const lastSeen = asString(e.lastSeen)
      const status = e.status === 'active' || e.status === 'idle' || e.status === 'gone' ? e.status : null
      if (model === null || model.length === 0) throw corrupt(`entries[${i}].model must be a non-empty string`)
      if (lastSeen === null) throw corrupt(`entries[${i}].lastSeen must be a string`)
      if (status === null) throw corrupt(`entries[${i}].status must be "active" | "idle" | "gone"`)
      out.push({ model, role: asString(e.role) ?? '', since: asString(e.since) ?? '', lastSeen, status })
    }
    return out
  }

  async function search(query: string): Promise<SearchHit[]> {
    if (typeof query !== 'string' || query.trim().length === 0) return []
    const lower = query.toLowerCase()
    const wsAbs = nodePath.join(root, COMMONS_PATHS.WORKSPACE)
    const hits: SearchHit[] = []
    async function walk(dirAbs: string): Promise<void> {
      let entries
      try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }) } catch (err) { if (errnoCode(err) === 'ENOENT') return; throw err }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const ent of entries) {
        if (hits.length >= SEARCH_MAX_HITS) return
        const full = nodePath.join(dirAbs, ent.name)
        if (ent.isDirectory()) { await walk(full); continue }
        if (!ent.isFile()) continue
        if (ent.name.startsWith('.')) continue
        let content: string
        try { content = await fsp.readFile(full, 'utf8') } catch { continue }
        const rel = nodePath.relative(root, full).split(nodePath.sep).join('/')
        const lines = splitLines(content)
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= SEARCH_MAX_HITS) return
          if (lines[i].toLowerCase().includes(lower)) {
            hits.push({ path: rel, line: i + 1, snippet: lines[i].trim().slice(0, SEARCH_SNIPPET_MAX) })
          }
        }
      }
    }
    await walk(wsAbs)
    return hits
  }

  return { read, write, decide, sync, who, search }
}
