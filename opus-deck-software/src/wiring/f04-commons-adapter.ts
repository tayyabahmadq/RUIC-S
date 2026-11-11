/**
 * Phase 11: Compactor's Commons adapter over phase-03 commons + filesystem.
 *
 * Compactor expects {read, exists, write, append, list} over root-relative
 * paths. write() routes through phase-03's atomic diff-write so digest
 * rewrites append DELTA rows. list() reads the real COMMONS directory.
 */
import * as fs from 'fs'
import * as nodePath from 'path'
import type { Commons as F04Commons } from '../compactor/types.js'
import type { Commons as F03Commons } from '../commons/types.js'

function isNotFound(err: unknown): boolean {
  return !!(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    String((err as { code: unknown }).code) === 'COMMONS_READ_NOT_FOUND'
  )
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

export class F04CommonsAdapter implements F04Commons {
  constructor(private readonly commons: F03Commons, private readonly memoryDir: string) {}

  private abs(rel: string): string {
    return nodePath.join(this.memoryDir, rel)
  }

  async read(rel: string): Promise<string> {
    return this.commons.read(rel)
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await this.commons.read(rel)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async write(rel: string, content: string): Promise<void> {
    let current = ''
    try { current = await this.commons.read(rel) } catch (err) { if (!isNotFound(err)) throw err }
    await this.commons.write({
      path: rel, diff: fullRewriteDiff(current, content),
      intent: 'compactor rewrite', author: 'compactor',
    })
  }

  async append(rel: string, content: string): Promise<void> {
    let current = ''
    try { current = await this.commons.read(rel) } catch (err) { if (!isNotFound(err)) throw err }
    await this.commons.write({
      path: rel,
      diff: { added: splitLines(content), removedLineCount: 0, atLine: splitLines(current).length + 1 },
      intent: 'compactor append', author: 'compactor',
    })
  }

  async list(dir: string): Promise<string[]> {
    const absDir = this.abs(dir)
    let entries
    try { entries = await fs.promises.readdir(absDir, { withFileTypes: true }) } catch { return [] }
    return entries
      .filter((e) => e.isFile())
      .map((e) => nodePath.join(dir, e.name).split(nodePath.sep).join('/'))
      .sort()
  }
}
