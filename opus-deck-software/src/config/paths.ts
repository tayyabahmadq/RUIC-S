/**
 * Canonical COMMONS path constants.
 *
 * SCHEME (byte-exact): every exported constant is a BARE RELATIVE SEGMENT
 * (directory entries carry NO trailing slash; file entries are full relative
 * paths). Consumers address memory through these constants; the wiring layer
 * resolves them against memoryDir at the boundary. Do NOT hardcode joins.
 *
 * Nine exported constants:
 *   BRIEF, DECISIONS, DIGEST, PRESENCE, TASKS, FINDINGS,
 *   WORKSPACE, DELTA, ARCHIVE, TXN_LOG
 */
export const BRIEF: string = 'BRIEF.md'
export const DECISIONS: string = 'DECISIONS.log'
export const DIGEST: string = 'STATE/digest.md'
export const PRESENCE: string = 'STATE/presence.json'
export const TASKS: string = 'STATE/tasks.json'
export const FINDINGS: string = 'STATE/findings.json'
export const WORKSPACE: string = 'WORKSPACE'
export const DELTA: string = 'DELTA'
export const ARCHIVE: string = 'ARCHIVE'
export const TXN_LOG: string = 'DELTA/txn.jsonl'
