/**
 * Phase 11: Crew's CommonsClient adapter over phase-03 commons.
 *
 * EngineerWorker writes via CommonsClient.write({intent, path, author,
 * added, atLine, removedLineCount}) and reads BRIEF.md / STATE/digest.md /
 * STATE/presence.json. Paths are WORKSPACE-relative, prefixed with WORKSPACE/
 * before phase-03 commons.write (atomic -> DELTA row).
 */
import * as nodePath from 'path'
import type { CommonsClient, CommonsWriteArgs } from '../crew/types.js'
import type { Commons as F03Commons } from '../commons/types.js'

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export class F07CommonsClient implements CommonsClient {
  constructor(private readonly f03: F03Commons, private readonly memoryDir: string) {}

  private workspacePath(p: string): string {
    return p.startsWith('WORKSPACE/') ? p : nodePath.join('WORKSPACE', p)
  }

  write(args: CommonsWriteArgs): unknown {
    const rel = this.workspacePath(args.path)
    const added = args.added ?? (args.content ?? '').split('\n')
    return this.f03.write({
      path: rel,
      diff: { added: added as string[], removedLineCount: args.removedLineCount ?? 0, atLine: args.atLine ?? 1 },
      intent: args.intent ?? 'crew write', author: args.author,
    })
  }

  read(p: string): unknown {
    return this.f03.read(p)
  }
}
