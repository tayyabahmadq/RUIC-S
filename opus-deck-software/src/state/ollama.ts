/**
 * Common-S — Ollama bridge.
 *
 * The local executor and embedder live on Ollama's OpenAI-compatible server.
 * Everything here degrades gracefully: a missing/stopped Ollama yields null,
 * never a thrown error into the run path (the system must survive the
 * removal of any single model).
 */
import { promises as fs } from 'fs'

export const OLLAMA_BASE = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

export interface OllamaPingResult {
  ok: boolean
  version?: string
  models?: string[]
}

/** Probe the local Ollama server. */
export async function ollamaPing(timeoutMs = 2000): Promise<OllamaPingResult> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    return {
      ok: true,
      models: (data.models ?? []).map((m) => m.name ?? '').filter((n) => n.length > 0),
    }
  } catch {
    return { ok: false }
  }
}

/** Embed via /api/embeddings. Returns null when Ollama is unavailable. */
export async function ollamaEmbed(model: string, text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { embedding?: unknown }
    return Array.isArray(data.embedding) && data.embedding.every((n) => typeof n === 'number')
      ? (data.embedding as number[])
      : null
  } catch {
    return null
  }
}

/** One non-streaming chat completion via /api/chat. Null on failure. */
export async function ollamaChatComplete(
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: { numCtx?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_ctx: options.numCtx ?? 32768 },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: { content?: unknown } }
    return typeof data.message?.content === 'string' ? data.message.content : null
  } catch {
    return null
  }
}

/**
 * Build the Brain embedder from a local embedding model. Null when Ollama is
 * down — the Brain then runs vector-free (cache-gate reports misses).
 */
export function makeOllamaEmbedder(model = 'nomic-embed-text'): () => Promise<((text: string) => Promise<number[] | null>) | null> {
  return async () => {
    const ping = await ollamaPing()
    if (!ping.ok) return null
    return (text: string) => ollamaEmbed(model, text)
  }
}

/** Read the Modelfile the context ladder settled on (context probe artifact). */
export async function readContextFile(memoryDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(`${memoryDir}/STATE/context.txt`, 'utf8')
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}
