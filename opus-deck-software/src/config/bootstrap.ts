/**
 * Runtime bootstrap for OpusDeck.
 * Validates the configuration, creates the memory/output directories and the
 * canonical COMMONS tree, and hands back the runtime (event bus + resolved
 * config + version + shutdown).
 */
import fs from 'fs'
import path from 'path'
import { EventBusImpl } from './bus.js'
import { resolveOpusDeckConfig } from './index.js'
import type { OpusDeckConfig, OpusDeckRuntime } from './types.js'
import { BRIEF, DECISIONS, DIGEST, PRESENCE, TASKS, FINDINGS, WORKSPACE, DELTA, ARCHIVE, TXN_LOG } from './paths.js'

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Default event sink: writes every bus event to the console as one JSON line. */
const defaultEventSink: { write(event: string, payload: unknown): void } = {
  write(event, payload) {
    console.log(`[${event}] ${JSON.stringify(payload)}`)
  },
}

export function initOpusDeck(config: OpusDeckConfig): OpusDeckRuntime {
  const resolved = resolveOpusDeckConfig(config)

  fs.mkdirSync(resolved.memoryDir, { recursive: true })
  fs.mkdirSync(resolved.outputDir, { recursive: true })

  // Canonical COMMONS tree (created only when missing, never overwritten).
  const root = resolved.memoryDir
  const initFiles: Array<[string, string]> = [
    [BRIEF, '# Brief\n'],
    [DECISIONS, ''],
    [DIGEST, '# Digest\n\nOwned by the compactor.\n'],
    [PRESENCE, JSON.stringify({ updated: new Date().toISOString(), entries: [] }, null, 2) + '\n'],
    [TASKS, '[]\n'], // array: merge/verify-build requires task/claim rows
    [FINDINGS, JSON.stringify([]) + '\n'],
    [TXN_LOG, ''],
  ]
  for (const [rel, content] of initFiles) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    try {
      fs.writeFileSync(abs, content, { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  for (const dir of [WORKSPACE, DELTA, ARCHIVE]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }

  const bus = new EventBusImpl(defaultEventSink as never)

  const shutdown = (): Promise<void> => Promise.resolve()

  return {
    bus,
    config: resolved,
    version: readPackageVersion(),
    shutdown,
  }
}

export type { OpusDeckRuntime }
