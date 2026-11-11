/**
 * Custom transport: endpoint used verbatim, OpenAI-shaped body, tolerate missing usage.
 */
import { CommonsError, ErrorCodes } from '../errors.js'
import { HttpStatusError, withRetry, DEFAULT_RETRY_POLICY } from '../retry.js'
import { SseParser } from '../sse.js'
import type {
  AdapterOptions,
  CompletionRequest,
  FetchLike,
  ModelRef,
  RetryPolicy,
  TransportChunk,
} from '../types.js'

interface FetchInitLike {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export class CustomTransport {
  private readonly ref: ModelRef
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly retry: RetryPolicy

  constructor(options: AdapterOptions) {
    this.ref = options.ref
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry }
  }

  async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
    const url = this.ref.endpoint // used verbatim
    const body: Record<string, unknown> = {
      model: this.ref.model,
      messages: req.messages,
      stream: true,
    }
    if (req.system) body.system = req.system
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    // Opt-in native reasoning depth, OpenAI-style field for custom endpoints.
    if (this.ref.reasoningEffort !== undefined) body.reasoning_effort = this.ref.reasoningEffort

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
      throw new HttpStatusError(response.status, `Custom ${response.status}`)
    }
    if (!response.body) {
      throw new CommonsError(ErrorCodes.TRANSPORT_STREAM, 'Custom stream body is null')
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
    if (parsed && typeof parsed === 'object') {
      if (parsed.type === 'text' && typeof parsed.text === 'string') chunks.push({ type: 'text', text: parsed.text })
      else if (
        parsed.type === 'usage' &&
        typeof parsed.inputTokens === 'number' &&
        typeof parsed.outputTokens === 'number'
      ) {
        chunks.push({ type: 'usage', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens })
      } else if (parsed.type === 'done' && typeof parsed.finishReason === 'string') {
        chunks.push({ type: 'done', finishReason: parsed.finishReason })
      }
    }
  } catch {
    if (msg.data.length > 0) chunks.push({ type: 'text', text: msg.data })
  }
  return chunks
}

export { TransportChunk } from '../types.js'
