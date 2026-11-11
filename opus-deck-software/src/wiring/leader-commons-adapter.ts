/**
 * Phase 11: Leader's Commons adapter over phase-03 commons + filesystem.
 *
 * `folder-06:*` state keys -> STATE/leader-06/<key>.json.
 * WORKSPACE paths -> phase-03 commons.write (atomic diff-write -> DELTA row).
 */
import * as fs from 'fs'
import * as nodePath from 'path'
import type { Commons, WorkspaceFile } from '../leader/types.js'
import type { Commons as F03Commons } from '../commons/types.js'

const STATE_LEADER06 = 'STATE/leader-06'

function isNotFound(err: unknown): boolean {
  return !!(err && typeof err === 'object' && 'code' in err && String((err as { code: unknown }).code) === 'COMMONS_READ_NOT_FOUND')
}

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function fullRewriteDiff(oldContent: string, newContent: string) {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  return { added: newLines, removedLineCount: oldLines.length, atLine: 1 }
}

export class LeaderCommonsAdapter implements Commons {
  constructor(private readonly f03: F03Commons, private readonly memoryDir: string) {}

  private stateFile(key: string): string {
    if (!key.startsWith('leader:')) throw new Error(`LeaderCommonsAdapter: unexpected key ${key}`)
    const segment = key.slice('leader:'.length).replace(/\//g, '__')
    return nodePath.join(this.memoryDir, STATE_LEADER06, `${segment}.json`)
  }

  async read<T>(key: string): Promise<T | undefined> {
    const file = this.stateFile(key)
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      return JSON.parse(raw) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const file = this.stateFile(key)
    await fs.promises.mkdir(nodePath.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  }

  async append(key: string, entry: unknown): Promise<void> {
    const current = (await this.read<unknown[]>(key)) ?? []
    current.push(entry)
    await this.write(key, current)
  }

  async listWorkspace(): Promise<WorkspaceFile[]> {
    const ws = nodePath.join(this.memoryDir, 'WORKSPACE')
    const files = await walkFiles(ws)
    const out: WorkspaceFile[] = []
    for (const rel of files) {
      const full = nodePath.join(ws, ...rel.split('/'))
      const st = await fs.promises.stat(full)
      out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() })
    }
    return out
  }

  async readWorkspace(rel: string): Promise<string> {
    return fs.promises.readFile(nodePath.join(this.memoryDir, 'WORKSPACE', ...rel.split('/')), 'utf8')
  }

  async writeWorkspace(rel: string, content: string): Promise<void> {
    let current = ''
    try { current = await fs.promises.readFile(nodePath.join(this.memoryDir, 'WORKSPACE', ...rel.split('/')), 'utf8') } catch { }
    await this.f03.write({
      path: nodePath.join('WORKSPACE', rel),
      diff: fullRewriteDiff(current, content),
      intent: 'leader workspace write',
      author: 'leader',
    })
  }

  /** STATE/digest.md — the same source the worker's prompt slot 2 uses. */
  readDigest(): string {
    try { return fs.readFileSync(nodePath.join(this.memoryDir, 'STATE', 'digest.md'), 'utf8') } catch { return '' }
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = nodePath.join(dir, e.name)
    if (e.isDirectory()) {
      for (const sub of await walkFiles(full)) results.push(nodePath.join(e.name, sub).split(nodePath.sep).join('/'))
    } else if (e.isFile()) results.push(e.name)
  }
  return results
}
