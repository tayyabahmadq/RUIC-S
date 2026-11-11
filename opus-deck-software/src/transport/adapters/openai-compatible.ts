/**
 * OpenAI-compatible transport: POST {endpoint}/chat/completions, SSE stream.
 */
import { CommonsError, ErrorCodes } from '../errors.js'
import { HttpStatusError, withRetry, DEFAULT_RETRY_POLICY } from '../retry.js'
import { SseParser } from '../sse.js'
import { trimTrailingSlash } from '../transport.js'
import type {
  AdapterOptions,
  CompletionRequest,
  FetchLike,
  ModelRef,
  RetryPolicy,
  TransportChunk,
} from '../types.js'

interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

interface ReadableStreamLike {
  getReader(): ReaderLike
}

interface FetchResponseLike {
  ok: boolean
  status: number
  body: ReadableStreamLike | null
  text: () => Promise<string>
}

interface FetchInitLike {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export class OpenAiCompatibleTransport {
  private readonly ref: ModelRef
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly retry: RetryPolicy
  private readonly includeUsage: boolean

  constructor(options: AdapterOptions) {
    this.ref = options.ref
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry }
    this.includeUsage = options.includeUsage ?? true
  }

  async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
    const url = `${trimTrailingSlash(this.ref.endpoint)}/chat/completions`
    // OpenAI chat takes the system prompt as a leading message, not a body field.
    const messages: Array<{ role: string; content: string }> = [...req.messages]
    if (req.system && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: req.system })
    }
    const body: Record<string, unknown> = {
      model: this.ref.model,
      messages,
      stream: true,
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    // Opt-in native reasoning depth (OpenAI-style endpoints: low/medium/high).
    if (this.ref.reasoningEffort !== undefined) body.reasoning_effort = this.ref.reasoningEffort
    if (this.includeUsage) body.stream_options = { include_usage: true }

    const init: FetchInitLike = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.ref.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    }

    const response = await withRetry(() => this.fetchImpl(url, init), this.retry, req.signal)
    if (!response.ok) {
      throw new HttpStatusError(response.status, `OpenAI-compatible ${response.status}`)
    }
    if (!response.body) {
      throw new CommonsError(ErrorCodes.TRANSPORT_STREAM, 'OpenAI-compatible stream body is null')
    }

    const parser = new SseParser()
    const reader = response.body.getReader()
    let done = false
    while (!done) {
      const { value, done: readerDone } = await reader.read()
      done = readerDone
      if (value) {
        parser.feed(new TextDecoder().decode(value, { stream: !done }))
        for (const msg of parser.parseMessages()) {
          for (const chunk of sseMessageToChunks(msg)) {
            yield chunk
          }
        }
      }
    }
    for (const msg of parser.flush()) {
      for (const chunk of sseMessageToChunks(msg)) {
        yield chunk
      }
    }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function sseMessageToChunks(msg: { event?: string; data: string }): TransportChunk[] {
  const chunks: TransportChunk[] = []
  try {
    const parsed = JSON.parse(msg.data)
    if (!parsed || typeof parsed !== 'object') return chunks
    // Real OpenAI chat-completions chunks: choices[0].delta.content + usage.
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
    const deltaContent = choice?.delta?.content
    if (typeof deltaContent === 'string' && deltaContent.length > 0) {
      chunks.push({ type: 'text', text: deltaContent })
    }
    if (choice?.finish_reason) {
      chunks.push({ type: 'done', finishReason: String(choice.finish_reason) })
    }
    if (parsed.usage && typeof parsed.usage === 'object') {
      const usage = parsed.usage as Record<string, unknown>
      if (typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
        chunks.push({ type: 'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens })
      }
    }
    // Legacy project-private dialect: {type:'text'|'usage'|'done', ...}.
    if (
      parsed.type === 'text' && typeof parsed.text === 'string' &&
      !chunks.some((c) => c.type === 'text')
    ) {
      chunks.push({ type: 'text', text: parsed.text })
    } else if (
      parsed.type === 'usage' &&
      typeof parsed.inputTokens === 'number' &&
      typeof parsed.outputTokens === 'number' &&
      !chunks.some((c) => c.type === 'usage')
    ) {
      chunks.push({ type: 'usage', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens })
    } else if (parsed.type === 'done' && typeof parsed.finishReason === 'string') {
      chunks.push({ type: 'done', finishReason: parsed.finishReason })
    }
  } catch {
    // Non-JSON SSE frames ([DONE] sentinels, keepalives) are not text output —
    // emitting them as text corrupted model responses.
  }
  return chunks
}

export { TransportChunk } from '../types.js'
