/**
 * Opus//DECK App — Electron preload entry.
 *
 * Runs in the isolated preload world and exposes exactly one global to the
 * renderer: the typed `DeckBridge` on `window.__deckBridge__`. The renderer
 * never imports engine code, never touches COMMONS and never sees a model
 * call (R16); key material and environment access never cross (R19).
 */
import { contextBridge, ipcRenderer, type IpcRenderer, type IpcRendererEvent } from 'electron'
import { buildBridge, type DeckPreloadIpc } from './bridge'

function createIpcAdapter(ipc: IpcRenderer): DeckPreloadIpc {
  const wrapped = new Map<
    (event: unknown, payload: unknown) => void,
    (event: IpcRendererEvent, ...args: unknown[]) => void
  >()
  return {
    invoke: (channel, payload) => ipc.invoke(channel, payload) as Promise<unknown>,
    sendSync: (channel) => ipc.sendSync(channel) as unknown,
    on: (channel, handler) => {
      const listener = (event: IpcRendererEvent, ...args: unknown[]): void => {
        handler(event, args[0])
      }
      wrapped.set(handler, listener)
      ipc.on(channel, listener)
    },
    off: (channel, handler) => {
      const listener = wrapped.get(handler)
      if (listener !== undefined) {
        ipc.off(channel, listener)
        wrapped.delete(handler)
      }
    },
  }
}

contextBridge.exposeInMainWorld('__deckBridge__', buildBridge(createIpcAdapter(ipcRenderer)))
