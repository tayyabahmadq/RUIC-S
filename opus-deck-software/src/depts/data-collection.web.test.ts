/**
 * Common-S tests — Dept 2: the direct web-page collector (WebFetchCollector).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebFetchCollector } from './data-collection.js'

/** A fetch impl serving canned responses keyed by URL. */
function fakeFetch(
  routes: Record<string, { status?: number; body?: string; ctype?: string }>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  type FetchInput = Parameters<typeof fetch>[0]
  type FetchInit = Parameters<typeof fetch>[1]
  const impl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    const route = routes[url] ?? { status: 404 }
    const status = route.status ?? 200
    const headers = new Headers({ 'content-type': route.ctype ?? 'text/html' })
    return new Response(route.body ?? '', { status, headers })
  }) as typeof fetch & { calls: string[] }
  impl.calls = calls
  return impl
}

const PAGE = `<!doctype html><html><head><title>Dotfiles Guide</title>
<script>alert('stripped')</script></head>
<body><h1>Hyprland</h1><p>Wayland &amp; widgets</p><style>body{}</style></body></html>`

const noDelay = (_ms: number) => Promise.resolve()

test('web collector extracts title + text from an HTML page', async () => {
  const fetchImpl = fakeFetch({
    'https://example.com/guide': { body: PAGE, ctype: 'text/html; charset=utf-8' },
    'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', ctype: 'text/plain' },
  })
  const web = new WebFetchCollector({ fetchImpl, delay: noDelay })
  const items = await web.collect('https://example.com/guide')
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Dotfiles Guide')
  assert.ok(items[0].body.includes('Wayland & widgets'))
  assert.ok(!items[0].body.includes('alert'))
  assert.equal(items[0].source, 'https://example.com/guide')
})

test('web collector respects robots.txt Disallow', async () => {
  const fetchImpl = fakeFetch({
    'https://blocked.example.com/private': { body: PAGE },
    'https://blocked.example.com/robots.txt': {
      body: 'User-agent: *\nDisallow: /private\nAllow: /\n',
      ctype: 'text/plain',
    },
  })
  const web = new WebFetchCollector({ fetchImpl, delay: noDelay })
  assert.deepEqual(await web.collect('https://blocked.example.com/private'), [])
  assert.equal(web.missReason, 'robots')
  assert.equal(fetchImpl.calls.some((u) => u.endsWith('/private')), false)
})

test('web collector blocks SSRF targets (loopback, private ranges, non-http)', async () => {
  const fetchImpl = fakeFetch({})
  const web = new WebFetchCollector({ fetchImpl, delay: noDelay })
  for (const topic of [
    'http://localhost/secret',
    'http://127.0.0.1/etc/passwd',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.10/admin',
    'http://10.0.0.3/internal',
    'file:///etc/passwd',
    'ftp://example.com/file',
  ]) {
    assert.deepEqual(await web.collect(topic), [], topic)
  }
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(web.missReason, 'ssrf')
})

test('web collector caps body size (a huge page degrades to a miss)', async () => {
  const big = 'x'.repeat(64 * 1024)
  const fetchImpl = fakeFetch({
    'https://huge.example.com/': { body: `<html><body>${big}</body></html>` },
    'https://huge.example.com/robots.txt': { body: '', ctype: 'text/plain' },
  })
  const web = new WebFetchCollector({ fetchImpl, maxBytes: 1024, delay: noDelay })
  assert.deepEqual(await web.collect('https://huge.example.com/'), [])
  assert.equal(web.missReason, 'size')
})

test('web collector degrades gracefully on timeouts and http errors', async () => {
  const timeouting = (async (): Promise<Response> => {
    throw Object.assign(new Error('the operation was aborted'), { name: 'TimeoutError' })
  }) as unknown as typeof fetch
  const webTimeout = new WebFetchCollector({ fetchImpl: timeouting, delay: noDelay })
  assert.deepEqual(await webTimeout.collect('https://slow.example.com/'), [])
  assert.equal(webTimeout.missReason, 'timeout')

  const fetch500 = fakeFetch({ 'https://err.example.com/': { status: 500 } })
  const webErr = new WebFetchCollector({ fetchImpl: fetch500, delay: noDelay })
  assert.deepEqual(await webErr.collect('https://err.example.com/'), [])
  assert.equal(webErr.missReason, 'http')
})

test('web collector abstains on non-URL topics (chain moves on)', async () => {
  const fetchImpl = fakeFetch({})
  const web = new WebFetchCollector({ fetchImpl, delay: noDelay })
  assert.deepEqual(await web.collect('rust async patterns'), [])
  assert.equal(web.missReason, 'not-url')
  assert.equal(fetchImpl.calls.length, 0)
})

test('web collector honors the per-host politeness gap', async () => {
  let clockMs = 1000
  const waits: number[] = []
  const fetchImpl = fakeFetch({
    'https://polite.example.com/a': { body: PAGE },
    'https://polite.example.com/b': { body: PAGE },
    'https://polite.example.com/robots.txt': { body: '', ctype: 'text/plain' },
  })
  const web = new WebFetchCollector({
    fetchImpl,
    minHostGapMs: 1000,
    now: () => clockMs,
    delay: (ms) => {
      waits.push(ms)
      clockMs += ms
      return Promise.resolve()
    },
  })
  await web.collect('https://polite.example.com/a')
  await web.collect('https://polite.example.com/b')
  assert.deepEqual(waits, [1000]) // second fetch waited out the full gap
})

test('web collector passes JSON bodies through as readable text', async () => {
  const fetchImpl = fakeFetch({
    'https://api.example.com/data': { body: '{"answer":42}', ctype: 'application/json' },
    'https://api.example.com/robots.txt': { body: '', ctype: 'text/plain' },
  })
  const web = new WebFetchCollector({ fetchImpl, delay: noDelay })
  const items = await web.collect('https://api.example.com/data')
  assert.equal(items.length, 1)
  assert.equal(items[0].body, '{"answer":42}')
})
