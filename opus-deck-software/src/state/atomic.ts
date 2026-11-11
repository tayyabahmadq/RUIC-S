/**
 * Common-S Brain — atomic JSON persistence.
 * Every Brain store write goes temp-file + rename: a reader never observes
 * half-updated state (Risk #4). No in-place writes, ever.
 */
import { promises as fsp } from 'fs'
import * as nodePath from 'path'

/** Write `data` to `file` atomically: serialize, write to `.<name>.<pid>.tmp`,
 * then rename over the target. The rename is atomic on POSIX and NTFS. */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = nodePath.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = nodePath.join(dir, `.${nodePath.basename(file)}.${process.pid}.tmp`)
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, file)
}

/** Read a JSON file, returning `fallback` when missing or corrupt. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
