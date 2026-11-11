/**
 * Opus//DECK App — preload bridge builder.
 *
 * `buildBridge` is a pure function of a minimal IPC surface, so the exact
 * object that gets exposed on `window.__deckBridge__` can be built and
 * asserted on outside Electron. `preload/index.ts` supplies the real
 * `ipcRenderer` adapter and hands the result to `contextBridge`.
 *
 * R16: this object is the ENTIRE renderer-facing surface. There is no method
 * here that reads a file, reads the environment, or touches a model (R19).
 */
import type {
  DeckBridge,
  DeckEventBatch,
  DeckInvokeCommand,
  DeckInvokeResponse,
  DeckInvokeResults,
} from '../shared/bridge-types'
import { DECK_CHANNELS } from '../shared/channels'

/** The narrow slice of ipcRenderer this bridge needs. */
export interface DeckPreloadIpc {
  invoke(channel: string, payload: unknown): Promise<unknown>
  sendSync(channel: string): unknown
  on(channel: string, handler: (event: unknown, payload: unknown) => void): void
  off(channel: string, handler: (event: unknown, payload: unknown) => void): void
}

export function buildBridge(ipc: DeckPreloadIpc): DeckBridge {
  return {
    events: {
      subscribe: (onBatch) => {
        const handler = (_event: unknown, payload: unknown): void => {
          onBatch(payload as DeckEventBatch)
        }
        ipc.on(DECK_CHANNELS.eventsBatch, handler)
        return () => {
          ipc.off(DECK_CHANNELS.eventsBatch, handler)
        }
      },
      replay: () => ipc.sendSync(DECK_CHANNELS.eventsReplay) as DeckEventBatch,
    },
    invoke: <C extends DeckInvokeCommand>(command: C) =>
      ipc.invoke(DECK_CHANNELS.invoke, command) as Promise<
        DeckInvokeResponse<DeckInvokeResults[C['type']]>
      >,
  }
}
