/**
 * Opus//DECK — Phase 3 (integration roadmap): persona-as-data.
 *
 * `CREW/personas/<id>.md` — a Markdown file whose frontmatter declares the
 * role and whose body IS the system prompt for that role. The registry is
 * presence-driven: a role with NO persona file falls back to the shipped
 * built-in prompt, so shipped behavior never depends on a persona file
 * existing (zero-risk default).
 *
 * RULING R9 — frontmatter is a FLAT, SINGLE-LINE `key: value` subset, parsed
 * by hand (no YAML parser, no new dependency). Keys are exactly:
 *   id (required), role (required), contextWindowTokens?, modelRef?
 * Values contain no colons, no nesting and no lists.
 *
 * BOOT-TIME LINT — an invalid persona file aborts boot with a precise error
 * (file + key + expected vs found); a MISSING file (or a missing CREW/
 * directory entirely) never does. This is the "lint your agent corpus before
 * it ships" stance; the shipped behavior of the deck stays file-free.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CommonsError } from '../config/errors.js'

/** The roles a persona may claim. An unknown role is a boot-time lint failure. */
export const PERSONA_ROLES = ['lead', 'engineer', 'auditor', 'reviewer'] as const
export type PersonaRole = (typeof PERSONA_ROLES)[number]

/** Frontmatter keys accepted by the R9 flat subset. */
export const PERSONA_REQUIRED_KEYS = ['id', 'role'] as const
export const PERSONA_OPTIONAL_KEYS = ['contextWindowTokens', 'modelRef'] as const
const PERSONA_ALL_KEYS: readonly string[] = [...PERSONA_REQUIRED_KEYS, ...PERSONA_OPTIONAL_KEYS]

/** `<memoryDir>/CREW/personas` — where the runtime corpus lives. */
export const CREW_PERSONAS_SEGMENTS = ['CREW', 'personas'] as const

/** One linted persona: the data plus the system prompt it carries. */
export interface Persona {
  /** The `id` frontmatter key (informational; the file name is the corpus key). */
  readonly id: string
  readonly role: PersonaRole
  readonly contextWindowTokens?: number
  readonly modelRef?: string
  /** The body below the closing `---` delimiter: the system prompt for this role. */
  readonly systemPrompt: string
  /** Absolute path of the source file — carried so every lint error is locatable. */
  readonly file: string
}

/** The boot-linted registry handed to the composition root. */
export interface PersonaRegistry {
  /** Absolute directory the registry was scanned from (it may not exist). */
  readonly dir: string
  readonly personas: readonly Persona[]
  get(role: PersonaRole): Persona | undefined
  has(role: PersonaRole): boolean
  /** Roles with no persona file — these keep the shipped built-in prompt. */
  missingRoles(): PersonaRole[]
}

function lintError(code: string, file: string, message: string): CommonsError {
  return new CommonsError(code, `${file}: ${message}`, { detail: `${file}: ${message}` })
}

function isRole(value: string): value is PersonaRole {
  return (PERSONA_ROLES as readonly string[]).includes(value)
}

/**
 * Strict R9 line parser. Throws a CommonsError naming the file, the key and
 * the expected-vs-found value for every violation.
 */
export function parsePersona(text: string, file: string): Persona {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r?\n/)

  if (lines[0] !== '---') {
    throw lintError(
      'PERSONA_FRONTMATTER_INVALID',
      file,
      `line 1: expected the opening frontmatter delimiter '---', found ${JSON.stringify(lines[0] ?? '')}`,
    )
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break }
  }
  if (close === -1) {
    throw lintError(
      'PERSONA_FRONTMATTER_UNCLOSED',
      file,
      `frontmatter is not closed: expected a closing '---' delimiter line (found ${lines.length - 1} line(s) after the opening delimiter)`,
    )
  }

  const values = new Map<string, string>()
  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const match = /^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$/.exec(line)
    if (match === null) {
      throw lintError(
        'PERSONA_FRONTMATTER_INVALID',
        file,
        `line ${i + 1}: ${JSON.stringify(line)} is not a flat "key: value" entry — R9 restricts frontmatter to single-line key:value pairs (no colons in values, no nesting, no lists)`,
      )
    }
    const key = match[1]
    const value = match[2].trim()
    if (!PERSONA_ALL_KEYS.includes(key)) {
      throw lintError(
        'PERSONA_UNKNOWN_KEY',
        file,
        `line ${i + 1}: unknown frontmatter key '${key}'; expected one of: ${PERSONA_ALL_KEYS.join(', ')} (required: ${PERSONA_REQUIRED_KEYS.join(', ')})`,
      )
    }
    if (values.has(key)) {
      throw lintError('PERSONA_DUPLICATE_KEY', file, `line ${i + 1}: duplicate frontmatter key '${key}'`)
    }
    if (value === '') {
      throw lintError('PERSONA_FRONTMATTER_INVALID', file, `line ${i + 1}: key '${key}' has an empty value`)
    }
    if (value.includes(':')) {
      throw lintError(
        'PERSONA_FRONTMATTER_INVALID',
        file,
        `line ${i + 1}: value for '${key}' must not contain ':' (R9: values are flat single-line scalars), found ${JSON.stringify(value)}`,
      )
    }
    values.set(key, value)
  }

  for (const key of PERSONA_REQUIRED_KEYS) {
    if (!values.has(key)) {
      const found = [...values.keys()].join(', ')
      throw lintError(
        'PERSONA_MISSING_KEY',
        file,
        `missing required frontmatter key '${key}': expected one of [${PERSONA_ALL_KEYS.join(', ')}], found keys: [${found === '' ? 'none' : found}]`,
      )
    }
  }

  // Guaranteed by the required-keys loop above.
  const id = values.get('id') as string
  const role = values.get('role') as string
  if (!isRole(role)) {
    throw lintError(
      'PERSONA_UNKNOWN_ROLE',
      file,
      `role: expected one of ${PERSONA_ROLES.join('|')}, found '${role}'`,
    )
  }

  const tokensRaw = values.get('contextWindowTokens')
  let contextWindowTokens: number | undefined
  if (tokensRaw !== undefined) {
    if (!/^\d+$/.test(tokensRaw) || Number(tokensRaw) <= 0) {
      throw lintError(
        'PERSONA_FRONTMATTER_INVALID',
        file,
        `contextWindowTokens: expected a positive integer, found '${tokensRaw}'`,
      )
    }
    contextWindowTokens = Number(tokensRaw)
  }
  const modelRef = values.get('modelRef')

  const body = lines.slice(close + 1).join('\n').trim()
  if (body === '') {
    throw lintError(
      'PERSONA_BODY_EMPTY',
      file,
      `persona body is empty — the text below the closing '---' delimiter IS the system prompt for role '${role}'`,
    )
  }

  return {
    id,
    role,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(modelRef === undefined ? {} : { modelRef }),
    systemPrompt: body,
    file,
  }
}

export function personasDir(memoryDir: string): string {
  return path.join(memoryDir, ...CREW_PERSONAS_SEGMENTS)
}

function emptyRegistry(dir: string): PersonaRegistry {
  return makeRegistry(dir, [])
}

function makeRegistry(dir: string, personas: Persona[]): PersonaRegistry {
  return {
    dir,
    personas,
    get: (role: PersonaRole) => personas.find((p) => p.role === role),
    has: (role: PersonaRole) => personas.some((p) => p.role === role),
    missingRoles: () => PERSONA_ROLES.filter((role) => !personas.some((p) => p.role === role)),
  }
}

/**
 * Boot-time load + lint of `<memoryDir>/CREW/personas/*.md`.
 *
 * - No CREW/ directory at all  -> empty registry (never an error).
 * - A directory with SOME roles -> those roles resolve; the rest fall back.
 * - An invalid file anywhere  -> throws (boot aborts) with file/key/expected.
 */
export function loadPersonas(memoryDir: string): PersonaRegistry {
  const dir = personasDir(memoryDir)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return emptyRegistry(dir)
    throw lintError('PERSONA_DIR_UNREADABLE', dir, `cannot read the persona directory: ${(err as Error).message}`)
  }

  // Only *.md files are personas; anything else in the folder is ignored.
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const personas: Persona[] = []
  const roleOwner = new Map<PersonaRole, string>()
  for (const name of names) {
    const file = path.join(dir, name)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      throw lintError('PERSONA_FILE_UNREADABLE', file, `cannot read the persona file: ${(err as Error).message}`)
    }
    const persona = parsePersona(text, file)
    const owner = roleOwner.get(persona.role)
    if (owner !== undefined) {
      throw lintError(
        'PERSONA_ROLE_CONFLICT',
        file,
        `role '${persona.role}' is already claimed by ${owner}; exactly one persona file may claim each role`,
      )
    }
    roleOwner.set(persona.role, file)
    personas.push(persona)
  }
  return makeRegistry(dir, personas)
}
