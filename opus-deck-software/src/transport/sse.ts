/**
 * Incremental SSE parser. Splits on blank lines, parses `data:` fields,
 * ignores comments/keep-alives, honors `[DONE]` for OpenAI-shaped streams.
 */
export class SseParser {
  private buffer = ''
  private closed = false

  feed(chunk: string): void {
    this.buffer += chunk
  }

  /** Returns complete SSE messages parsed so far; keeps a trailing partial line. */
  parseMessages(): Array<{ event?: string; data: string }> {
    const messages: Array<{ event?: string; data: string }> = []
    let idx
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const msg = this.parseBlock(block)
      if (msg) messages.push(msg)
    }
    // handle a final block terminated by end of stream (no trailing blank line)
    return messages
  }

  /** Flush any remaining buffered block as a final message. */
  flush(): Array<{ event?: string; data: string }> {
    const messages: Array<{ event?: string; data: string }> = []
    if (this.buffer.trim().length > 0 && !this.closed) {
      this.closed = true
      const msg = this.parseBlock(this.buffer)
      this.buffer = ''
      if (msg) messages.push(msg)
    }
    return messages
  }

  private parseBlock(block: string): { event?: string; data: string } | null {
    let event: string | undefined
    let data = ''
    for (const line of block.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith(':')) continue // comment / keep-alive
      if (trimmed.startsWith('event:')) {
        event = trimmed.slice(6).trim()
      } else if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim()
        data = data ? `${data}\n${payload}` : payload
      }
    }
    if (data === '[DONE]') return null // stream end marker, no data
    if (data.length === 0 && event === undefined) return null
    return { event, data }
  }
}

/** Parse one SSE message into TransportChunks. */
export function sseMessageToChunks(msg: { event?: string; data: string }): import('./types.js').TransportChunk[] {
  const chunks: import('./types.js').TransportChunk[] = []
  try {
    const parsed = JSON.parse(msg.data)
    if (parsed && typeof parsed === 'object') {
      if (parsed.type === 'text' && typeof parsed.text === 'string') {
        chunks.push({ type: 'text', text: parsed.text })
      } else if (parsed.type === 'usage' && typeof parsed.inputTokens === 'number' && typeof parsed.outputTokens === 'number') {
        chunks.push({ type: 'usage', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens })
      } else if (parsed.type === 'done' && typeof parsed.finishReason === 'string') {
        chunks.push({ type: 'done', finishReason: parsed.finishReason })
      }
    }
  } catch {
    // not JSON — treat whole data as a text chunk
    if (msg.data.length > 0) {
      chunks.push({ type: 'text', text: msg.data })
    }
  }
  return chunks
}

export type { TransportChunk } from './types.js'
