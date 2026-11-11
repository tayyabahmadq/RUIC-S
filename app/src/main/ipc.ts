/**
 * Opus//DECK App — Electron IPC wiring for the Control Deck host.
 *
 * Deliberately thin and Electron-free at the type level: `DeckIpcMain` and
 * `DeckWebContents` are the only Electron shapes this module knows, so it can
 * be exercised without a running app object. `main/index.ts` passes the real
 * `ipcMain` and the live window's `webContents`.
 *
 * Channels (see shared/channels.ts) — exactly three, nothing else:
 *   deck:invoke        renderer -> main  (run | abort | config | crewHealth)
 *   deck:events:batch  main -> renderer  (batched, ordered hub events)
 *   deck:events:replay renderer -> main  (synchronous full-history replay)
 */
import type { DeckInvokeCommand } from '../shared/bridge-types'
import { DECK_CHANNELS, type DeckChannelName } from '../shared/channels'
import type { DeckHost } from './deck-host'

export interface DeckIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, listener: (event: { returnValue: unknown }, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (...args: never[]) => void): void
}

export interface DeckWebContents {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

export interface InstallDeckIpcDeps {
  readonly host: DeckHost
  readonly ipcMain: DeckIpcMain
  /** The current renderer target, or null while no window exists. */
  readonly getWebContents: () => DeckWebContents | null
  readonly channels?: typeof DECK_CHANNELS
}

/** Register the three channels; returns a disposer that unregisters them. */
export function installDeckIpc(deps: InstallDeckIpcDeps): () => void {
  const channels: typeof DECK_CHANNELS = deps.channels ?? DECK_CHANNELS

  const invokeListener = (_event: unknown, ...args: unknown[]): unknown =>
    deps.host.invoke(args[0] as DeckInvokeCommand)

  const replayListener = (event: { returnValue: unknown }): void => {
    event.returnValue = deps.host.replay()
  }

  deps.ipcMain.handle(channels.invoke, invokeListener)
  deps.ipcMain.on(channels.eventsReplay, replayListener)

  const unsubscribe = deps.host.subscribe((batch) => {
    const target = deps.getWebContents()
    if (target !== null && !target.isDestroyed()) target.send(channels.eventsBatch, batch)
  })

  return () => {
    unsubscribe()
    deps.ipcMain.removeHandler(channels.invoke)
    deps.ipcMain.removeListener(channels.eventsReplay, replayListener as never)
  }
}

/** Channel names as an ordered list — used by the keys test. */
export const DECK_IPC_CHANNELS: readonly DeckChannelName[] = [
  DECK_CHANNELS.invoke,
  DECK_CHANNELS.eventsBatch,
  DECK_CHANNELS.eventsReplay,
]
