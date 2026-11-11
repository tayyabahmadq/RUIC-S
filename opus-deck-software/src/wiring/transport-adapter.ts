/**
 * Phase 11: Transport adapters reconciling every phase to phase-02's
 * authoritative Transport.complete(req): AsyncIterable<TransportChunk>.
 *
 *  - F06TransportAdapter: Leader's completion() -> complete() (A6)
 *  - F04TransportAdapter: compactor's chat() -> complete()
 *  - F07TransportClient: crew's stream/complete/chat -> complete()
 */
import type {
  CompletionRequest, CompletionResponse, Message, Transport as F06Transport,
} from '../leader/types.js'
import type {
  Transport as F02Transport, TransportChunk,
} from '../transport/types.js'
import type {
  Transport as F04Transport, LlmRequest, LlmResponse,
} from '../compactor/types.js'
import type { TransportClient } from '../crew/types.js'

function mapRole(role: Message['role']): 'system' | 'user' | 'assistant' {
  return role === 'tool' ? 'system' : role
}

/** The usage an injected `onUsage` sink receives (mirrors the E1 worker's StreamUsage). */
export interface CollectedUsage { readonly inputTokens: number; readonly outputTokens: number }

/**
 * Collect a text answer from phase-02's chunk iterable.
 *
 * Phase E3 (R24, completing E1's crew worker and E2's leader adapter): the full
 * canonical grammar - text, then usage, then a terminal `done`.
 *   - text chunks are collected and concatenated;
 *   - `usage` chunks are ROUTED (never concatenated into the answer). Each
 *     token count is number-checked before it is reported. When no `onUsage`
 *     sink is supplied the usage is simply consumed and dropped - the phase-02
 *     usage layer and the shell's transport wrapper already account for it, so
 *     counting it here too would double-count (the same reasoning as E1);
 *   - the FIRST `done` breaks the iteration, so a chunk after the terminator is
 *     never consumed.
 *
 * `onUsage` is OPTIONAL and additive: no existing caller must pass it, and no
 * existing call shape changes (the E1 `usageSink` seam pattern).
 */
function collectChunks(
  transport: F02Transport,
  modelId: string,
  prompt: string,
  options?: { system?: string },
  onUsage?: (usage: CollectedUsage) => void,
): Promise<string> {
  const chunks: string[] = []
  return (async () => {
    for await (const chunk of transport.complete({
      modelId,
      messages: [{ role: 'user' as const, content: prompt }],
      // Phase 3 (personas): forward the system prompt (engineer persona body).
      // Absent = the exact shipped request shape.
      ...(options?.system === undefined ? {} : { system: options.system }),
    })) {
      if (chunk.type === 'text') { chunks.push(chunk.text); continue }
      if (chunk.type === 'usage') {
        if (onUsage !== undefined
          && typeof chunk.inputTokens === 'number' && typeof chunk.outputTokens === 'number') {
          onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
        }
        continue
      }
      if (chunk.type === 'done') break
    }
    return chunks.join('')
  })()
}

/** Leader's Transport.completion over phase-02 complete(). */
export class F06TransportAdapter implements F06Transport {
  constructor(private readonly transport: F02Transport) {}
  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    const chunks: string[] = []
    let inputTokens = 0, outputTokens = 0
    const req = {
      modelId: request.modelId,
      messages: request.messages.map((m) => ({ role: mapRole(m.role), content: m.content })),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    }
    // Phase E2 (R24): the full canonical phase-02 chunk grammar, mirroring the
    // crew worker's E1 (R21) fix. A REAL adapter streams text, then usage, then
    // a terminal `done`; this adapter used to concatenate EVERY text chunk and
    // never stopped, so any chunk after `done` was appended to the leader's
    // JSON and failed the parse with LEADER_INVALID_LLM_JSON. Now:
    //   - text chunks are collected and concatenated (unchanged);
    //   - usage chunks are read (number-checked) into the response usage, never
    //     concatenated into the text;
    //   - the FIRST `done` terminates the iteration - nothing after it is
    //     consumed.
    for await (const chunk of this.transport.complete(req)) {
      if (chunk.type === 'text') { chunks.push(chunk.text); continue }
      if (chunk.type === 'usage') {
        if (typeof chunk.inputTokens === 'number') inputTokens = chunk.inputTokens
        if (typeof chunk.outputTokens === 'number') outputTokens = chunk.outputTokens
        continue
      }
      if (chunk.type === 'done') break
    }
    return { text: chunks.join(''), modelId: request.modelId, usage: { inputTokens, outputTokens } }
  }
}

/** Compactor's Transport.chat over phase-02 complete(). */
export class F04TransportAdapter implements F04Transport {
  constructor(private readonly transport: F02Transport, private readonly defaultModelId: string) {}
  async chat(req: LlmRequest): Promise<LlmResponse> {
    const text = await collectChunks(this.transport, req.model ?? this.defaultModelId, req.messages.map((m) => m.content).join('\n'), { system: req.system })
    return { text, model: req.model ?? this.defaultModelId }
  }
}

/** Crew's TransportClient over phase-02 complete(). stream() returns the raw chunk iterable. */
export class F07TransportClient implements TransportClient {
  constructor(private readonly transport: F02Transport) {}
  stream(modelId: string, prompt: string, options?: { system?: string }): unknown {
    // Phase 3 (personas): forward the system prompt so the engineer persona
    // reaches the model. Absent = the exact shipped request shape.
    return this.transport.complete({
      modelId,
      messages: [{ role: 'user', content: prompt }],
      ...(options?.system === undefined ? {} : { system: options.system }),
    })
  }
  complete(modelId: string, prompt: string, options?: { system?: string }): unknown {
    return collectChunks(this.transport, modelId, prompt, options)
  }
  chat(modelId: string, prompt: string, options?: { system?: string }): unknown {
    return collectChunks(this.transport, modelId, prompt, options)
  }
}

export type { TransportChunk } from '../transport/types.js'
