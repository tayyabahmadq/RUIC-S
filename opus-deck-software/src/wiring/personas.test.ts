/**
 * Phase 3 (integration roadmap): persona-as-data — CREW/personas corpus.
 *
 * Covers:
 *  - the FALLBACK MATRIX: no CREW/ directory at all / a directory with some
 *    roles / an invalid file in the directory;
 *  - BOOT-TIME LINT: precise errors (file + key + expected vs found) for every
 *    R9 frontmatter violation, and an invalid file aborting boot;
 *  - the wiring seams: lead persona -> leader plan() system prompt, engineer
 *    persona -> crew worker system prompt, reviewer persona -> f11 review call;
 *  - shipped behavior never depends on a persona file existing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { CommonsError } from '../config/errors.js'
import { wireOpusDeck } from './index.js'
import { loadPersonas, parsePersona, personasDir, PERSONA_ROLES } from './personas.js'
import { createEngineerWorker, createTaskQueue, f07GetDefaultSystemPrompt, f07SetDefaultSystemPrompt } from '../crew/index.js'

// --- harness ---------------------------------------------------------------

const BUILT_IN_LEAD_PROMPT = 'You are the lead planner.'
const BUILT_IN_REVIEWER_PROMPT = 'You are a senior security reviewer. Output only valid JSON.'

interface RecordedCall { system?: string; prompt: string }

function recordingTransport(): { transport: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    transport: {
      async *complete(): AsyncIterable<{ type: 'text'; text: string }> {
        const req = arguments[0] as { system?: string; messages: { role: string; content: string }[] }
        const prompt = req.messages.map((m) => m.content).join('\n')
        // Some callers (the leader) send the system prompt as a system message
        // rather than a top-level option; record either form.
        const system = req.system ?? req.messages.find((m) => m.role === 'system')?.content
        calls.push({ ...(system === undefined ? {} : { system }), prompt })
        if (prompt.includes('TASK_DECOMPOSITION')) {
          yield { type: 'text', text: JSON.stringify([{ id: 'T-01', path: 'src/app.ts', description: 'build it', acceptance: ['ok'] }]) }
        } else if (prompt.includes('CRITERION_VERIFICATION')) {
          yield { type: 'text', text: JSON.stringify({ satisfied: true, evidence: 'src/app.ts:1' }) }
        } else {
          yield { type: 'text', text: '[]' }
        }
      },
    } as any,
  }
}

function crewModel(id: string, model: string) {
  return { id, provider: 'custom' as const, model, contextWindowTokens: 4096 }
}

function mkRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function personaFile(fields: Record<string, string>, body: string): string {
  const frontmatter = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${frontmatter}\n---\n${body}\n`
}

function writePersona(memoryDir: string, name: string, content: string): void {
  const dir = personasDir(memoryDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content, 'utf8')
}

async function wireIn(root: string, transport: any): Promise<Awaited<ReturnType<typeof wireOpusDeck>>> {
  const memoryDir = path.join(root, 'COMMONS')
  const runtime = initOpusDeck({
    memoryDir, outputDir: path.join(root, 'OUTPUT'), brief: 'build an app', goalState: ['app builds'],
    crew: {
      lead: crewModel('lead', 'lead-model'),
      engineers: [crewModel('eng-1', 'eng-model')],
      security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
    },
  })
  return wireOpusDeck(runtime, {
    transport, leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'],
  })
}

function expectLintFailure(run: () => unknown, code: string, snippets: readonly string[]): CommonsError {
  try {
    run()
  } catch (err) {
    assert.ok(err instanceof CommonsError, `expected a CommonsError, got ${String(err)}`)
    const lint = err as CommonsError
    assert.strictEqual(lint.code, code, `expected code ${code}, got ${lint.code} (${lint.message})`)
    for (const snippet of snippets) {
      assert.ok(lint.message.includes(snippet), `error must mention ${JSON.stringify(snippet)}; got: ${lint.message}`)
    }
    return lint
  }
  throw new Error(`E_EXPECTED_LINT_FAILURE: expected ${code}`)
}

// ---------------------------------------------------------------------------
// 1. Fallback matrix, case 1 — no CREW/ directory at all
// ---------------------------------------------------------------------------

test('fallback matrix (1/3): no CREW/ directory at all — empty registry, shipped behavior everywhere', async () => {
  const root = mkRoot('opus-crew-none-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const registry = loadPersonas(memoryDir)
    assert.strictEqual(registry.personas.length, 0, 'no personas')
    assert.deepStrictEqual([...registry.missingRoles()], [...PERSONA_ROLES], 'every role is missing')

    const { transport, calls } = recordingTransport()
    const wired = await wireIn(root, transport)
    assert.strictEqual(wired.personas.personas.length, 0, 'wiring sees an empty registry')

    // lead: the built-in planner prompt is used verbatim
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })
    const planCall = calls.find((c) => c.prompt.includes('TASK_DECOMPOSITION'))
    assert.ok(planCall, 'a plan call was made')
    assert.ok(planCall!.system?.startsWith(BUILT_IN_LEAD_PROMPT), 'built-in lead prompt is used')
    assert.strictEqual(wired.f07.systemPrompt, undefined, 'no engineer persona')

    // engineer: the worker still behaves exactly as shipped (no system prompt)
    assert.strictEqual(f07GetDefaultSystemPrompt(), undefined, 'crew default is unset')
    const systems: (string | undefined)[] = []
    const worker = createEngineerWorker('eng-1', {
      queue: createTaskQueue([{ id: 'T-01', description: 'do it' }]),
      commons: { write: async () => { }, read: async () => '' },
      locks: { acquire: async () => { }, release: async () => { } },
      transport: {
        async *stream(): AsyncIterable<string> {
          const opts = arguments[2] as { system?: string } | undefined
          systems.push(opts?.system)
          yield JSON.stringify({ intent: 'write', path: 'src/out.ts', added: ['x'], atLine: 1, removedLineCount: 0 })
        },
      },
    })
    await worker.run()
    assert.deepStrictEqual(systems, [undefined], 'the worker sent no system prompt')

    // reviewer: the built-in reviewer prompt is used verbatim
    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(appPath, 'export const a = 1;\n', 'utf8')
    await wired.f11.reviewAgent.review({ runId: 'run-1', brief: 'build an app', goalState: ['app builds'], memoryDir })
    const reviewCall = calls.find((c) => c.prompt.includes('Files under review'))
    assert.ok(reviewCall, 'a review call was made')
    assert.strictEqual(reviewCall!.system, BUILT_IN_REVIEWER_PROMPT, 'built-in reviewer prompt is used')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Fallback matrix, case 2 — a directory with SOME roles
// ---------------------------------------------------------------------------

test('fallback matrix (2/3): directory with some roles — the present role wins, absent roles fall back', async () => {
  const root = mkRoot('opus-crew-partial-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const engineerBody = 'You are the deck engineer. Output ONLY the write-intent JSON object.'
    writePersona(memoryDir, 'engineer.md', personaFile(
      { id: 'engineer', role: 'engineer', contextWindowTokens: '32000', modelRef: 'eng-model' },
      engineerBody,
    ))

    const registry = loadPersonas(memoryDir)
    assert.strictEqual(registry.personas.length, 1, 'exactly one persona')
    assert.ok(registry.has('engineer'))
    assert.strictEqual(registry.get('engineer')!.systemPrompt, engineerBody)
    assert.strictEqual(registry.get('engineer')!.contextWindowTokens, 32000)
    assert.strictEqual(registry.get('engineer')!.modelRef, 'eng-model')
    assert.deepStrictEqual([...registry.missingRoles()], ['lead', 'auditor', 'reviewer'])

    const { transport, calls } = recordingTransport()
    const wired = await wireIn(root, transport)
    assert.strictEqual(wired.personas.get('engineer')!.systemPrompt, engineerBody)

    // lead persona is absent -> built-in prompt (unchanged shipped behavior)
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })
    const planCall = calls.find((c) => c.prompt.includes('TASK_DECOMPOSITION'))
    assert.ok(planCall!.system?.startsWith(BUILT_IN_LEAD_PROMPT), 'lead falls back to the built-in prompt')

    // engineer persona is present -> it is the crew default (wiring retargeted it)
    assert.strictEqual(f07GetDefaultSystemPrompt(), engineerBody, 'wiring set the crew default system prompt')
    assert.strictEqual(wired.f07.systemPrompt, engineerBody, 'wired deck exposes the engineer persona body')

    const systems: (string | undefined)[] = []
    const worker = createEngineerWorker('eng-1', {
      queue: createTaskQueue([{ id: 'T-01', description: 'do it' }]),
      commons: { write: async () => { }, read: async () => '' },
      locks: { acquire: async () => { }, release: async () => { } },
      transport: {
        async *stream(): AsyncIterable<string> {
          const opts = arguments[2] as { system?: string } | undefined
          systems.push(opts?.system)
          yield JSON.stringify({ intent: 'write', path: 'src/out.ts', added: ['x'], atLine: 1, removedLineCount: 0 })
        },
      },
    })
    await worker.run()
    assert.deepStrictEqual(systems, [engineerBody], 'the worker sent the engineer persona as its system prompt')

    // reviewer persona is absent -> built-in prompt
    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(appPath, 'export const a = 1;\n', 'utf8')
    await wired.f11.reviewAgent.review({ runId: 'run-1', brief: 'build an app', goalState: ['app builds'], memoryDir })
    const reviewCall = calls.find((c) => c.prompt.includes('Files under review'))
    assert.strictEqual(reviewCall!.system, BUILT_IN_REVIEWER_PROMPT, 'reviewer falls back to the built-in prompt')
  } finally {
    f07SetDefaultSystemPrompt(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Fallback matrix, case 3 — an invalid file in the directory
// ---------------------------------------------------------------------------

test('fallback matrix (3/3): an invalid persona file aborts boot with a precise error', async () => {
  const root = mkRoot('opus-crew-invalid-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const file = path.join(personasDir(memoryDir), 'engineer.md')
    writePersona(memoryDir, 'engineer.md', personaFile({ id: 'engineer', role: 'robot' }, 'You are an engineer.'))

    // direct load: throws, naming file + key + expected vs found
    expectLintFailure(() => loadPersonas(memoryDir), 'PERSONA_UNKNOWN_ROLE', [
      file, 'role', 'lead|engineer|auditor|reviewer', "'robot'",
    ])

    // boot: wireOpusDeck rejects — the corpus is linted before anything ships
    const { transport } = recordingTransport()
    const runtime = initOpusDeck({
      memoryDir, outputDir: path.join(root, 'OUTPUT'), brief: 'build an app', goalState: ['app builds'],
      crew: {
        lead: crewModel('lead', 'lead-model'),
        engineers: [crewModel('eng-1', 'eng-model')],
        security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
      },
    })
    await assert.rejects(
      () => wireOpusDeck(runtime, { transport, leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'] }),
      (err: unknown) => err instanceof CommonsError && err.code === 'PERSONA_UNKNOWN_ROLE' && err.message.includes(file),
      'boot aborts on an invalid persona file',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Boot-time lint — precise errors for every R9 violation
// ---------------------------------------------------------------------------

const FILE = 'CREW/personas/lead.md'

test('boot lint: a missing required key names the file, the key and the keys found', () => {
  expectLintFailure(() => parsePersona('---\nrole: lead\n---\nbody\n', FILE), 'PERSONA_MISSING_KEY', [
    FILE, "missing required frontmatter key 'id'", 'role',
  ])
  expectLintFailure(() => parsePersona('---\nid: lead\n---\nbody\n', FILE), 'PERSONA_MISSING_KEY', [
    FILE, "missing required frontmatter key 'role'", 'id',
  ])
})

test('boot lint: an unknown role names the expected roles and the found value', () => {
  expectLintFailure(() => parsePersona('---\nid: x\nrole: boss\n---\nbody\n', FILE), 'PERSONA_UNKNOWN_ROLE', [
    FILE, 'role', 'lead|engineer|auditor|reviewer', "'boss'",
  ])
})

test('boot lint: an unknown key is rejected (R9: exactly id, role, contextWindowTokens?, modelRef?)', () => {
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\ntemperature: 0.5\n---\nbody\n', FILE), 'PERSONA_UNKNOWN_KEY', [
    FILE, "'temperature'", 'id, role, contextWindowTokens, modelRef',
  ])
})

test('boot lint: R9 flat-subset violations (colons, nesting, lists) are rejected', () => {
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\nmodelRef: acct:project:model\n---\nbody\n', FILE), 'PERSONA_FRONTMATTER_INVALID', [
    FILE, "must not contain ':'",
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\n  nested: value\n---\nbody\n', FILE), 'PERSONA_FRONTMATTER_INVALID', [
    FILE, 'not a flat "key: value" entry',
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\n- one\n---\nbody\n', FILE), 'PERSONA_FRONTMATTER_INVALID', [
    FILE, 'not a flat "key: value" entry',
  ])
})

test('boot lint: malformed delimiters, duplicate keys and empty bodies are rejected', () => {
  expectLintFailure(() => parsePersona('id: x\nrole: lead\n---\nbody\n', FILE), 'PERSONA_FRONTMATTER_INVALID', [
    FILE, "expected the opening frontmatter delimiter '---'",
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\nbody without a closing delimiter\n', FILE), 'PERSONA_FRONTMATTER_UNCLOSED', [
    FILE, "expected a closing '---' delimiter line",
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nid: y\nrole: lead\n---\nbody\n', FILE), 'PERSONA_DUPLICATE_KEY', [
    FILE, "duplicate frontmatter key 'id'",
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\n---\n', FILE), 'PERSONA_BODY_EMPTY', [
    FILE, 'persona body is empty',
  ])
  expectLintFailure(() => parsePersona('---\nid: x\nrole: lead\ncontextWindowTokens: a lot\n---\nbody\n', FILE), 'PERSONA_FRONTMATTER_INVALID', [
    FILE, 'contextWindowTokens', 'positive integer', "'a lot'",
  ])
})

test('boot lint: two persona files claiming the same role is a corpus conflict', () => {
  const root = mkRoot('opus-crew-conflict-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    writePersona(memoryDir, 'a-lead.md', personaFile({ id: 'a', role: 'lead' }, 'A'))
    const second = path.join(personasDir(memoryDir), 'b-lead.md')
    writePersona(memoryDir, 'b-lead.md', personaFile({ id: 'b', role: 'lead' }, 'B'))
    expectLintFailure(() => loadPersonas(memoryDir), 'PERSONA_ROLE_CONFLICT', [second, "'lead'"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persona-as-data: a valid file parses into data + the body as the system prompt', () => {
  const content = '---\r\nid: lead\r\nrole: lead\r\ncontextWindowTokens: 128000\r\nmodelRef: opus\r\n---\r\nYou are the lead.\r\nOutput JSON only.\r\n'
  const persona = parsePersona(content, FILE)
  assert.strictEqual(persona.id, 'lead')
  assert.strictEqual(persona.role, 'lead')
  assert.strictEqual(persona.contextWindowTokens, 128000)
  assert.strictEqual(persona.modelRef, 'opus')
  assert.strictEqual(persona.systemPrompt, 'You are the lead.\nOutput JSON only.', 'the body IS the system prompt')
  assert.strictEqual(persona.file, FILE)
})

// ---------------------------------------------------------------------------
// 5. Wiring — every call site that exists today
// ---------------------------------------------------------------------------

test('wiring: the lead persona drives the plan() system prompt end to end', async () => {
  const root = mkRoot('opus-crew-lead-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const leadBody = 'You are the deck lead. Decompose the brief into tasks and output ONLY the JSON array.'
    writePersona(memoryDir, 'lead.md', personaFile({ id: 'lead', role: 'lead' }, leadBody))

    const { transport, calls } = recordingTransport()
    const wired = await wireIn(root, transport)
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })

    const planCall = calls.find((c) => c.prompt.includes('TASK_DECOMPOSITION'))
    assert.strictEqual(planCall!.system, leadBody, 'the persona body is the plan system prompt')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: the reviewer persona drives every f11 review/reflect call', async () => {
  const root = mkRoot('opus-crew-reviewer-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const reviewerBody = 'You are the deck reviewer. Output ONLY a JSON array of findings.'
    writePersona(memoryDir, 'reviewer.md', personaFile({ id: 'reviewer', role: 'reviewer' }, reviewerBody))

    const { transport, calls } = recordingTransport()
    const wired = await wireIn(root, transport)
    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(appPath, 'const x = 1;\n', 'utf8')
    await wired.f11.reviewAgent.review({ runId: 'run-1', brief: 'build an app', goalState: ['app builds'], memoryDir })

    const reviewCalls = calls.filter((c) => c.prompt.includes('Files under review') || c.prompt.includes('candidate security findings'))
    assert.ok(reviewCalls.length >= 2, 'review + reflect calls were made')
    for (const call of reviewCalls) assert.strictEqual(call.system, reviewerBody)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: the engineer persona reaches the model through the wired crew transport', async () => {
  const root = mkRoot('opus-crew-engineer-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const engineerBody = 'You are the deck engineer.'
    writePersona(memoryDir, 'engineer.md', personaFile({ id: 'engineer', role: 'engineer' }, engineerBody))

    const { transport, calls } = recordingTransport()
    const wired = await wireIn(root, transport)
    assert.strictEqual(wired.f07.systemPrompt, engineerBody)

    // the wired crew client forwards the system option to the f02 transport
    await (async () => { for await (const _ of wired.f07.transport.stream('eng-1', 'hello', { system: engineerBody }) as AsyncIterable<unknown>) { /* drain */ } })()
    const forwarded = calls.find((c) => c.prompt === 'hello')
    assert.strictEqual(forwarded!.system, engineerBody, 'the F07 client forwards the system prompt')

    // and without a system option the request shape is exactly as shipped
    await (async () => { for await (const _ of wired.f07.transport.stream('eng-1', 'plain') as AsyncIterable<unknown>) { /* drain */ } })()
    const plain = calls.find((c) => c.prompt === 'plain')
    assert.strictEqual(plain!.system, undefined, 'no system option -> no system in the request')
  } finally {
    f07SetDefaultSystemPrompt(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: the auditor persona loads into the registry (call-site hook is deferred)', async () => {
  // DEFERRAL (recorded): folder-08 audit is a deterministic scanner with no
  // LLM call site, so there is nothing to inject the auditor persona into
  // today. The persona still loads, lints and is exposed on the registry so
  // the hook is a one-line wire-up when an LLM audit call lands.
  const root = mkRoot('opus-crew-auditor-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const auditorBody = 'You are the deck auditor.'
    writePersona(memoryDir, 'auditor.md', personaFile({ id: 'auditor', role: 'auditor' }, auditorBody))

    const { transport } = recordingTransport()
    const wired = await wireIn(root, transport)
    assert.ok(wired.personas.has('auditor'))
    assert.strictEqual(wired.personas.get('auditor')!.systemPrompt, auditorBody)
    assert.deepStrictEqual([...wired.personas.missingRoles()], ['lead', 'engineer', 'reviewer'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persona retry: a persona never displaces the corrective note on a retry', async () => {
  const root = mkRoot('opus-crew-retry-')
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const engineerBody = 'You are the deck engineer.'
    writePersona(memoryDir, 'engineer.md', personaFile({ id: 'engineer', role: 'engineer' }, engineerBody))
    const { transport } = recordingTransport()
    await wireIn(root, transport)
    assert.strictEqual(f07GetDefaultSystemPrompt(), engineerBody)

    const systems: string[] = []
    const attempts: string[] = []
    const worker = createEngineerWorker('eng-1', {
      queue: createTaskQueue([{ id: 'T-01', description: 'do it' }]),
      commons: { write: async () => { }, read: async () => '' },
      locks: { acquire: async () => { }, release: async () => { } },
      transport: {
        async *stream(): AsyncIterable<string> {
          const opts = arguments[2] as { system?: string } | undefined
          systems.push(opts?.system ?? '')
          const attempt = attempts.length
          attempts.push('x')
          if (attempt === 0) yield 'not json at all'
          else yield JSON.stringify({ intent: 'write', path: 'src/out.ts', added: ['x'], atLine: 1, removedLineCount: 0 })
        },
      },
    })
    await worker.run()
    assert.strictEqual(systems[0], engineerBody, 'first attempt: the persona is the system prompt')
    assert.ok(systems[1]!.startsWith(engineerBody), 'retry keeps the persona')
    assert.ok(systems[1]!.includes('not valid JSON'), 'retry appends the corrective note')
  } finally {
    f07SetDefaultSystemPrompt(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
