/**
 * Opus//DECK App — Electron main process entry (R16, R18, R19).
 *
 * Responsibilities:
 *   - bootstrap: `loadEngine()`, construct the `DeckHost` (which owns the
 *     engine runtime, the event journal and the invoke surface);
 *   - bridge host: `installDeckIpc()` forwards journaled events to the renderer
 *     as batched, ordered IPC and marshals the four invoke commands;
 *   - window lifecycle: create the BrowserWindow with the isolated preload, and
 *     on close behave like the CLI's Ctrl-C — abort the run, release claims and
 *     persist the journal position, then close.
 *
 * The engine is a read-only dependency: ZERO edits to `opus-deck-software/`.
 * Nothing in this file touches key material: key resolution lives one layer
 * down in `transport-factory.ts`, inside main (R19).
 */
import * as path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { loadEngine } from '../engine/engine-load'
import { DeckHost } from './deck-host'
import { installDeckIpc, type DeckIpcMain } from './ipc'
import { buildEngineTransport } from './transport-factory'
import { PreviewHost } from './preview-host'

let mainWindow: BrowserWindow | null = null
let host: DeckHost | null = null
let disposeIpc: (() => void) | null = null
let previewHost: PreviewHost | null = null

function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'index.js')
}

function rendererPath(): string {
  return path.join(__dirname, '..', 'renderer', 'index.html')
}

function journalDir(): string {
  return path.join(app.getPath('userData'), 'deck-journal')
}

/** Adapt the real `ipcMain` to the narrow, Electron-free `DeckIpcMain` seam. */
const ipcAdapter: DeckIpcMain = {
  handle(channel, listener) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => listener(event, ...args))
  },
  removeHandler(channel) {
    ipcMain.removeHandler(channel)
  },
  on(channel, listener) {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      listener(event, ...args)
    })
  },
  removeListener(channel, listener) {
    ipcMain.removeListener(channel, listener as (...args: unknown[]) => void)
  },
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d0d11',
    title: 'Ruic — Control Deck',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only contextBridge + ipcRenderer, both available to
      // sandboxed preloads — so the full Chromium sandbox can stay on.
      sandbox: true,
    },
  })

  // Navigation guards (defense-in-depth; the renderer is a local file with a
  // strict CSP and no reason to navigate or open windows).
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  // Graceful abort: window-close behaves exactly like the CLI's Ctrl-C.
  win.on('close', (event) => {
    const currentHost = host
    const closing = mainWindow
    if (currentHost === null || closing === null || !currentHost.isRunning()) return
    // Stop the close once, run the abort path, then tear the window down.
    event.preventDefault()
    mainWindow = null
    void currentHost.abort().finally(() => {
      closing.destroy()
    })
  })

  void win.loadFile(rendererPath())
  return win
}

app.whenReady().then(() => {
  const engine = loadEngine()
  mainWindow = createWindow()
  // Create the preview host BEFORE the DeckHost: the host stores the handle
  // once in its constructor, so a later assignment would never be seen.
  previewHost = new PreviewHost()
  previewHost.attach(mainWindow)
  host = new DeckHost({
    engine,
    journalDir: journalDir(),
    transportFactory: (config, loadedEngine) => buildEngineTransport(config, loadedEngine),
    previewHost: previewHost,
  })
  disposeIpc = installDeckIpc({
    host,
    ipcMain: ipcAdapter,
    getWebContents: () => mainWindow?.webContents ?? null,
  })
  host.setPreviewHost(false, null, [])

  // preview.state rides deck:events:batch via installDeckIpc; no second path.
  // preview open/close rides deck:invoke -> DeckHost.previewAction; no 4th
  // channel is registered here.

  // Resize the preview view when the main window is resized
    mainWindow.on('resize', () => {
      if (previewHost !== null) {
        const [width, height] = mainWindow!.getSize()
        previewHost.resize(width, height)
      }
    })
}, (error: unknown) => {
  // Engine-load or bootstrap failure must not become a silent blank app.
  console.error('Ruic failed to start:', error)
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  } else if (mainWindow === null) {
    mainWindow = BrowserWindow.getAllWindows()[0] ?? createWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    disposeIpc?.()
    disposeIpc = null
    app.quit()
  }
})
