/**
 * Anthropic transport: POST {endpoint}/v1/messages, native SSE event names.
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

export const ANTHROPIC_VERSION: '2023-06-01' = '2023-06-01'
export const ANTHROPIC_DEFAULT_MAX_TOKENS: 4096 = 4096

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
}

interface FetchInitLike {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export class AnthropicTransport {
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
    this.includeUsage = options.includeUsage ?? false
  }

  async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
    const url = `${trimTrailingSlash(this.ref.endpoint)}/v1/messages`
    const body: Record<string, unknown> = {
      model: this.ref.model,
      max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: req.messages,
      stream: true,
    }
    if (req.system) {
      body.system = req.system
    } else {
      const systemMsgs = req.messages.filter((m) => m.role === 'system').map((m) => m.content)
      if (systemMsgs.length > 0) body.system = systemMsgs.join('\n\n')
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    // Opt-in native thinking depth. Per the Anthropic Messages API (GA), effort
    // lives inside `output_config` and controls thinking depth; thinking itself
    // is adaptive/on by default on current models — never send budget_tokens.
    if (this.ref.reasoningEffort !== undefined) body.output_config = { effort: this.ref.reasoningEffort }

    const init: FetchInitLike = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(this.ref.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    }

    const response = await withRetry(() => this.fetchImpl(url, init), this.retry, req.signal)
    if (!response.ok) {
      throw new HttpStatusError(response.status, `Anthropic ${response.status}`)
    }
    if (!response.body) {
      throw new CommonsError(ErrorCodes.TRANSPORT_STREAM, 'Anthropic stream body is null')
    }

    const parser = new SseParser()
    const reader = response.body.getReader()
    let inputTokens = 0
    let done = false
    while (!done) {
      const { value, done: readerDone } = await reader.read()
      done = readerDone
      if (value) {
        parser.feed(new TextDecoder().decode(value, { stream: !done }))
        for (const msg of parser.parseMessages()) {
          for (const chunk of anthropicMessageToChunks(msg, inputTokens)) {
            if (chunk.type === 'usage') inputTokens = Math.max(inputTokens, chunk.inputTokens)
            yield chunk
          }
        }
      }
    }
    for (const msg of parser.flush()) {
      for (const chunk of anthropicMessageToChunks(msg, inputTokens)) {
        yield chunk
      }
    }
    yield { type: 'done', finishReason: 'end_turn' }
  }
}

function anthropicMessageToChunks(msg: { event?: string; data: string }, knownInputTokens = 0): TransportChunk[] {
  const chunks: TransportChunk[] = []
  try {
    const parsed = JSON.parse(msg.data)
    if (!parsed || typeof parsed !== 'object') return chunks
    const type = parsed.type
    if (type === 'content_block_delta') {
      const delta = parsed.delta
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
        chunks.push({ type: 'text', text: delta.text })
      }
    } else if (type === 'message_start') {
      // Anthropic reports input usage in message_start, not message_delta.
      const usage = parsed.message?.usage
      if (usage && typeof usage.input_tokens === 'number') {
        chunks.push({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens ?? 0 })
      }
    } else if (type === 'message_delta') {
      const usage = parsed.usage
      if (usage && typeof usage.output_tokens === 'number') {
        chunks.push({
          type: 'usage',
          inputTokens: usage.input_tokens ?? knownInputTokens,
          outputTokens: usage.output_tokens,
        })
      }
      if (parsed.stop_reason) {
        chunks.push({ type: 'done', finishReason: parsed.stop_reason })
      }
    }
  } catch {
    // ignore malformed
  }
  return chunks
}

export { TransportChunk } from '../types.js'
