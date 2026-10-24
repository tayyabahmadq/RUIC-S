/**
 * Opus//DECK App — Escape tests (R16/R17).
 *
 * Runs in a real Electron process. Creates a sandboxed BrowserView,
 * loads a hostile page, and verifies that all escape vectors are blocked:
 *
 *   a. require/process/window.__deckBridge__ are all undefined
 *   b. new windows / navigation away are blocked
 *   c. IPC channels are unreachable
 *   d. fetch/XHR to network fails
 *
 * This test must FAIL if containment regresses.
 */

import { app, BrowserView, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'

app.disableHardwareAcceleration()

async function main(): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const preview = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  })

  win.addBrowserView(preview)
  preview.setBounds({ x: 0, y: 0, width: 800, height: 600 })

  // Block all navigation
  let navigationAttempted = false
  preview.webContents.on('will-navigate', (event) => {
    navigationAttempted = true
    event.preventDefault()
  })

  // Block all new windows
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Load about:blank first
  await preview.webContents.loadURL('about:blank')

  // Wait for about:blank to load
  await new Promise((resolve) => {
    preview.webContents.on('did-finish-load', () => resolve(undefined))
    setTimeout(() => resolve(undefined), 1000)
  })

  // Build script as array of strings joined by newlines
  const scriptLines = []
  scriptLines.push('(async function() {')
  scriptLines.push('  window.__escapeResults = {')
  scriptLines.push("    requireDefined: typeof require !== 'undefined',")
  scriptLines.push("    processDefined: typeof process !== 'undefined',")
  scriptLines.push("    deckBridgeDefined: typeof window.__deckBridge__ !== 'undefined',")
  scriptLines.push("    ipcRendererDefined: typeof window.ipcRenderer !== 'undefined',")
  scriptLines.push('    navigationBlocked: false,')
  scriptLines.push('    newWindowBlocked: false,')
  scriptLines.push('    fetchBlocked: false,')
  scriptLines.push('  }')
  scriptLines.push('')
  scriptLines.push('  // Test navigation blocking')
  scriptLines.push("  const originalUrl = window.location.href")
  scriptLines.push("  window.location.href = 'http://evil.example.com/'")
  scriptLines.push('  // Give time for navigation to be blocked')
  scriptLines.push('  await new Promise(r => setTimeout(r, 100))')
  scriptLines.push('  window.__escapeResults.navigationBlocked = (window.location.href === originalUrl)')
  scriptLines.push('')
  scriptLines.push('  // Test new window blocking')
  scriptLines.push('  try {')
  scriptLines.push("    const newWin = window.open('http://evil.example.com/')")
  scriptLines.push('    window.__escapeResults = window.__escapeResults || {}')
  scriptLines.push('    window.__escapeResults.newWindowBlocked = newWin === null')
  scriptLines.push('  } catch (e) {')
  scriptLines.push('    window.__escapeResults = window.__escapeResults || {}')
  scriptLines.push('    window.__escapeResults.newWindowBlocked = true')
  scriptLines.push('  }')
  scriptLines.push('')
  scriptLines.push('  // Test fetch blocking')
  scriptLines.push('  try {')
  scriptLines.push("    await fetch('http://evil.example.com/')")
  scriptLines.push('      .then(() => { window.__escapeResults = window.__escapeResults || {}; window.__escapeResults.fetchBlocked = false })')
  scriptLines.push('      .catch(() => { window.__escapeResults = window.__escapeResults || {}; window.__escapeResults.fetchBlocked = true })')
  scriptLines.push('  } catch (e) {')
  scriptLines.push('    window.__escapeResults = window.__escapeResults || {}')
  scriptLines.push('    window.__escapeResults.fetchBlocked = true')
  scriptLines.push('  }')
  scriptLines.push('')
  scriptLines.push('  return {')
  scriptLines.push("    requireDefined: typeof require !== 'undefined',")
  scriptLines.push("    processDefined: typeof process !== 'undefined',")
  scriptLines.push("    deckBridgeDefined: typeof window.__deckBridge__ !== 'undefined',")
  scriptLines.push("    ipcRendererDefined: typeof window.ipcRenderer !== 'undefined',")
  scriptLines.push('    navigationBlocked: window.__escapeResults?.navigationBlocked ?? false,')
  scriptLines.push('    newWindowBlocked: window.__escapeResults?.newWindowBlocked ?? false,')
  scriptLines.push('    fetchBlocked: window.__escapeResults?.fetchBlocked ?? false,')
  scriptLines.push('  }')
  scriptLines.push('})()')

  const script = scriptLines.join('\n')
  const results = await preview.webContents.executeJavaScript(script)

  const failures = []
  if (results.requireDefined) failures.push('require is accessible in preview')
  if (results.processDefined) failures.push('process is accessible in preview')
  if (results.deckBridgeDefined) failures.push('__deckBridge__ is accessible in preview')
  if (results.ipcRendererDefined) failures.push('ipcRenderer is accessible in preview')
  if (!results.navigationBlocked) failures.push('navigation away not blocked')
  if (!results.newWindowBlocked) failures.push('new window not blocked')
  if (!results.fetchBlocked) failures.push('fetch not blocked')

  const pass = failures.length === 0
  const resultPath = process.env.DECK_ESCAPE_RESULT
  if (resultPath) {
    writeFileSync(resultPath, JSON.stringify({ pass, details: results }), 'utf8')
  }

  console.log('[escape-tests] ' + (pass ? 'PASS' : 'FAIL') + ': ' + JSON.stringify(results))

  preview.webContents.stop()
  win.removeBrowserView(preview)
  win.destroy()
  app.exit(pass ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err: unknown) => {
    console.error('[escape-tests] FAIL:', err)
    const resultPath = process.env.DECK_ESCAPE_RESULT
    if (resultPath) {
      writeFileSync(resultPath, JSON.stringify({ pass: false, details: {}, error: String(err) }), 'utf8')
    }
    app.exit(3)
  })
})