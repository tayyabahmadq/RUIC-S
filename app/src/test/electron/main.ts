/**
 * Opus//DECK App — Electron bridge-contract test (R16, gate item 3).
 *
 * This is a REAL Electron main process. It constructs the SAME `DeckHost` that
 * `main/index.ts` uses, installs the SAME IPC wiring, opens a REAL BrowserWindow
 * with the REAL isolated preload and the REAL renderer script, and drives the
 * run through the actual contextBridge:
 *
 *   renderer  window.__deckBridge__.invoke(...)  ->  ipcRenderer.invoke
 *            ->  ipcMain.handle('deck:invoke')   ->  DeckHost.invoke
 *
 * It then compares the state the renderer itself reconstructed
 * (`window.__deckState__`) against the host's directly-computed
 * `expectedState()`. Two modes:
 *
 *   DECK_CONTRACT_MODE=cold    window opened before the run;
 *   DECK_CONTRACT_MODE=midrun  window opened at `auditing` (mid-run open).
 *
 * The verdict is written to `DECK_CONTRACT_RESULT` as JSON; the process exits 0
 * on match, 2 on mismatch, 3 on error.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { loadEngine } from '../../engine/engine-load'
import { DeckHost } from '../../main/deck-host'
import { installDeckIpc, type DeckIpcMain } from '../../main/ipc'
import type { DeckConfigInput, ReconstructedState } from '../../shared/bridge-types'
import {
  FixedClock,
  canonical,
  makeTempMemoryDir,
  removeDir,
  scriptedBuiltTransport,
  scriptedConfig,
} from '../scripted'

const MODE = process.env['DECK_CONTRACT_MODE'] === 'midrun' ? 'midrun' : 'cold'
const RESULT_PATH = process.env['DECK_CONTRACT_RESULT'] ?? ''

app.disableHardwareAcceleration()

let win: BrowserWindow | null = null

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

function preloadPath(): string {
  return path.join(__dirname, '..', '..', 'preload', 'index.js')
}

function rendererPath(): string {
  return path.join(__dirname, '..', '..', 'renderer', 'index.html')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await delay(25)
  }
}

async function evalInRenderer<T>(expression: string): Promise<T> {
  if (win === null) throw new Error('no renderer window')
  const value = await win.webContents.executeJavaScript(expression)
  return value as T
}

async function openWindow(): Promise<void> {
  const created = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win = created
  await created.loadFile(rendererPath())
  await waitFor(
    () => evalInRenderer<boolean>('Boolean(window.__deckInternals__ && window.__deckInternals__.isReady())'),
    15000,
    'renderer boot',
  )
}

function firstDifference(a: unknown, b: unknown): string {
  const left = canonical(a)
  const right = canonical(b)
  if (left === right) return ''
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `at ${i}: "${left.slice(Math.max(0, i - 40), i + 40)}" != "${right.slice(Math.max(0, i - 40), i + 40)}"`
    }
  }
  return `length ${left.length} != ${right.length}`
}

function writeResult(payload: unknown): void {
  if (RESULT_PATH === '') return
  fs.writeFileSync(RESULT_PATH, JSON.stringify(payload, null, 2), 'utf8')
}

async function run(): Promise<void> {
  const engine = loadEngine()
  const memoryDir = makeTempMemoryDir(`electron-${MODE}`)
  const config: DeckConfigInput = scriptedConfig(memoryDir)
  const clock = new FixedClock()
  let midRunOpened = false

  const deckHost = new DeckHost({
    engine,
    clock,
    runIdFactory: () => 'run-000001',
    initialConfig: config,
    transportFactory: () => scriptedBuiltTransport(),
    hooks: {
      afterPhase: async (phase) => {
        if (MODE === 'midrun' && phase === 'auditing' && !midRunOpened) {
          midRunOpened = true
          await openWindow()
        }
      },
    },
  })

  installDeckIpc({
    host: deckHost,
    ipcMain: ipcAdapter,
    getWebContents: () => win?.webContents ?? null,
  })

  if (MODE === 'cold') await openWindow()

  const runResponse = await deckHost.invoke({ type: 'run', payload: config })
  if (!runResponse.ok) throw new Error(`run failed: ${runResponse.error}`)
  deckHost.flushNow()

  await waitFor(
    async () => {
      const applied = await evalInRenderer<number>('window.__deckInternals__.appliedEventCount()')
      const healthPending = await evalInRenderer<boolean>('window.__deckInternals__.healthRefreshPending()')
      return applied >= deckHost.journalLength() && !healthPending
    },
    20000,
    'renderer event drain',
  )
  deckHost.flushNow()
  await delay(50)

  const rendererState = await evalInRenderer<ReconstructedState>('JSON.parse(JSON.stringify(window.__deckState__))')
  const expected = deckHost.expectedState()
  const matches = canonical(rendererState) === canonical(expected)

  writeResult({
    mode: MODE,
    matches,
    journalLength: deckHost.journalLength(),
    rendererApplied: await evalInRenderer<number>('window.__deckInternals__.appliedEventCount()'),
    runId: expected.runId,
    phase: expected.phase,
    renderedPhase: rendererState.phase,
    tasks: expected.tasks.length,
    findings: expected.findings.length,
    presence: expected.presence.length,
    crewHealth: expected.crewHealth.length,
    tokenSpend: expected.tokenSpend,
    elapsedMs: expected.elapsedMs,
    mismatch: matches ? null : firstDifference(rendererState, expected),
  })

  deckHost.dispose()
  removeDir(memoryDir)
  app.exit(matches ? 0 : 2)
}

app.whenReady().then(() => {
  run().catch((err: unknown) => {
    writeResult({
      mode: MODE,
      matches: false,
      error: err instanceof Error ? err.message : String(err),
    })
    app.exit(3)
  })
})
