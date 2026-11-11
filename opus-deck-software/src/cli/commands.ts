/**
 * Phase 10: /opus command handlers.
 */
import { CommonsError } from './types.js'

export type CommandHandler = (...args: readonly string[]) => Promise<void> | void

export const Commands = new Map<string, CommandHandler>([
  ['run', runCommand],
  ['status', statusCommand],
  ['crew', crewCommand],
  ['report', reportCommand],
  ['config', configCommand],
  ['codegraph', codegraphCommand],
])

async function runCommand(...args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    throw new CommonsError('CLI-RUN-001', 'Usage: /opus run — no arguments required.')
  }
}

async function statusCommand(...args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    throw new CommonsError('CLI-STATUS-001', 'Usage: /opus status — no arguments required.')
  }
}

async function crewCommand(...args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    throw new CommonsError('CLI-CREW-001', 'Usage: /opus crew — no arguments required.')
  }
}

async function reportCommand(...args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    throw new CommonsError('CLI-REPORT-001', 'Usage: /opus report — no arguments required.')
  }
}

async function configCommand(...args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    throw new CommonsError('CLI-CONFIG-001', 'Usage: /opus config — no arguments required.')
  }
}

/**
 * Phase 12: explicit codegraph trigger (`deck codegraph build`).
 * The command surface validates usage; the rebuild itself runs through
 * the wired composition root (WiredDeck.f12.rebuildCodegraph), consistent
 * with the Phase-10 declarative command table.
 */
async function codegraphCommand(...args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] !== 'build' || args.length > 1) {
    throw new CommonsError('CLI-CODEGRAPH-001', 'Usage: /opus codegraph build — no other arguments supported.')
  }
}
