/**
 * Opus//DECK App — Preview host (R16/R17/R18).
 *
 * Manages the sandboxed WebContentsView that displays the merged build output
 * from a completed run. The preview is strictly isolated:
 *
 *   - sandbox: true            — no Node.js integration
 *   - contextIsolation: true   — isolated JS context
 *   - nodeIntegration: false   — no Node.js APIs
 *   - webSecurity: true        — same-origin policy enforced
 *   - dedicated Session        — webRequest cancels every request that is not a
 *                                 file:// URL inside the run's outputDir
 *                                 (http, https, ws, and out-of-dir file:// are
 *                                 all cancelled); every permission request is
 *                                 denied
 *   - NO preload script        — no bridge, no IPC, no __deckBridge__
 *   - will-navigate / will-redirect blocked — cannot navigate away
 *   - setWindowOpenHandler deny — no pop-ups
 *   - will-attach-webview blocked — no <webview> injection
 *
 * The preview is purely a read-only, contained display of the merged build
 * output. Generated code is untrusted (R17) and must never reach Node.js, IPC
 * or the network.
 */

import { session, WebContentsView, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DeckPreviewResult } from '../shared/bridge-types'

let instanceCount = 0

/**
 * The preview host manages a single WebContentsView that displays the merged
 * build output from a completed run. It is sandboxed so the generated content
 * cannot escape, access Node.js, or reach any IPC channel or the network.
 */
export class PreviewHost {
  private view: WebContentsView | null = null
  private win: BrowserWindow | null = null
  private previewSession: Electron.Session | null = null
  private isOpen = false
  private currentFile: string | null = null
  private files: string[] = []
  private navigationBlocked = 0
  private newWindowBlocked = 0

  /** The outputDir of the currently open preview, used to scope file:// access. */
  private outputDirFileUrl = ''

  /** Attach the preview view to a BrowserWindow. Called once at startup. */
  attach(win: BrowserWindow): void {
    this.win = win
  }

  /** A dedicated, locked-down Session for each preview instance. */
  private createPreviewSession(): Electron.Session {
    const partition = `preview-deck-${process.pid}-${++instanceCount}`
    const previewSession = session.fromPartition(partition, { cache: false })

    // Network containment: only file:// URLs inside the run's outputDir may
    // load; http/https/ws and out-of-dir file:// are cancelled at the session
    // layer, so generated code cannot fetch resources or read arbitrary files.
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(this.outputDirFileUrl) })
    })

    // Deny every permission request (geolocation, notifications, etc.).
    previewSession.setPermissionRequestHandler(() => false)

    return previewSession
  }

  /** Open the preview, loading the given entry point from outputDir. */
  async open(
    memoryDir: string,
    outputDir: string,
    entryPoint: string | undefined,
  ): Promise<{ open: boolean; currentFile: string | null; files: string[] }> {
    if (this.win === null) {
      return { open: false, currentFile: null, files: [] }
    }

    const outputRoot = path.resolve(outputDir)
    // Trailing separator: pathToFileURL of a directory does NOT end with '/',
    // so a bare-prefix check would admit sibling directories (e.g. OUTPUT2).
    this.outputDirFileUrl = pathToFileURL(outputRoot).href.endsWith('/')
      ? pathToFileURL(outputRoot).href
      : pathToFileURL(outputRoot).href + '/'

    // Disclose the file list from MANIFEST.json if present
    let files: string[] = []
    let entry = entryPoint
    try {
      const manifestPath = path.join(outputDir, 'MANIFEST.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        files?: Array<{ path: string }>
      }
      files = (manifest.files ?? []).map((f) => f.path)
      if (entry === undefined && files.length > 0) {
        const html = files.find((f) => f.endsWith('.html') || f.endsWith('.htm'))
        if (html !== undefined) entry = html
      }
    } catch {
      // No MANIFEST.json or unreadable: fall back to entryPoint or empty
    }

    // Strict entry validation: must be a listed file, resolve inside outputDir,
    // and be HTML (the preview surface renders HTML output).
    const resolved = path.resolve(outputRoot, entry ?? '')
    const withinOutput =
      resolved === outputRoot || resolved.startsWith(outputRoot + path.sep)
    const isHtml = /\.(html|htm)$/i.test(entry ?? '')
    if (!withinOutput || !isHtml || !files.includes(entry ?? '')) {
      return { open: false, currentFile: null, files }
    }

    // Destroy any existing preview view first
    this.close()

    // Create the dedicated locked-down session for this preview
    this.previewSession = this.createPreviewSession()

    // Create the sandboxed WebContentsView
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        session: this.previewSession,
      },
    })

    // Block all navigation: the preview only ever shows its entry file
    view.webContents.on('will-navigate', (event) => {
      event.preventDefault()
      this.navigationBlocked += 1
    })
    view.webContents.on('will-redirect', (event) => {
      event.preventDefault()
      this.navigationBlocked += 1
    })
    // Block <webview> injection
    view.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    // Block all new windows: no pop-ups from the preview
    view.webContents.setWindowOpenHandler(() => {
      this.newWindowBlocked += 1
      return { action: 'deny' }
    })

    // Load the entry point from outputDir via file://
    const entryPath = path.join(outputRoot, entry as string)
    const fileUrl = pathToFileURL(entryPath).href
    await view.webContents.loadURL(fileUrl)

    // Add the view to the window's content view, beside the sidebar
    this.win.contentView.addChildView(view)
    const [width, height] = this.win.getSize()
    view.setBounds({ x: 320, y: 0, width: width - 320, height })

    this.view = view
    this.isOpen = true
    this.currentFile = entry as string
    this.files = files

    return { open: true, currentFile: entry as string, files }
  }

  /** Close the preview and destroy the WebContentsView. */
  async close(): Promise<{ open: boolean; currentFile: string | null; files: string[] }> {
    if (this.view !== null) {
      this.view.webContents.stop()
      this.win?.contentView.removeChildView(this.view)
      this.view = null
    }
    this.previewSession = null
    this.outputDirFileUrl = ''
    this.isOpen = false
    this.currentFile = null
    return { open: false, currentFile: null, files: this.files }
  }

  /** Current preview state. */
  get state() {
    return { open: this.isOpen, currentFile: this.currentFile, files: this.files }
  }

  /** Test observability: number of navigations blocked by the host. */
  get navigationBlockedCount(): number {
    return this.navigationBlocked
  }

  /** Test observability: number of new-window attempts blocked by the host. */
  get newWindowBlockedCount(): number {
    return this.newWindowBlocked
  }

  /** Resize the preview view to match the window. */
  resize(width: number, height: number): void {
    if (this.view !== null) {
      this.view.setBounds({ x: 320, y: 0, width: width - 320, height })
    }
  }

  /** Clean up on window close. */
  destroy(): void {
    this.close()
  }

  /** Get the WebContentsView instance for resize handling. */
  get viewElement(): WebContentsView | null {
    return this.view
  }
}
