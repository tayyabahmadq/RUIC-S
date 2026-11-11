/**
 * Opus//DECK — Phase 11: Wiring — shared event hub.
 *
 * ONE EventHub instance serves every phase. Each phase's bus interface is a
 * view over the same hub, so there is exactly one bus instance (the known
 * isolation-bus bug is avoided): the prompt assembler (crew/buildPrompt) and
 * the compactor both emit compaction.requested on this same hub.
 *
 * Views:
 *  - Phase 1 EventBus: on/once/emit (sync; used by initOpusDeck + crew)
 *  - Leader Bus: emit(subscribe/published) — promise-based
 *  - Compactor bus: subscribe/emit — sync-friendly
 */
type HubHandler = (payload: unknown) => void

export class EventHub {
  private readonly handlers = new Map<string, Set<HubHandler>>()
  private readonly history: Array<{ id: string; type: string; payload: unknown; at: string }> = []
  private counter = 0

  on(event: string, handler: HubHandler): void {
    let set = this.handlers.get(event)
    if (!set) { set = new Set(); this.handlers.set(event, set) }
    set.add(handler)
  }

  once(event: string, handler: HubHandler): void {
    const wrapper = (payload: unknown): void => { this.off(event, wrapper); handler(payload) }
    this.on(event, wrapper)
  }

  off(event: string, handler: HubHandler): void {
    const set = this.handlers.get(event)
    if (set) set.delete(handler)
  }

  emit(event: string, payload: unknown): void {
    const set = this.handlers.get(event)
    if (set) {
      for (const handler of [...set]) {
        try { handler(payload) } catch { }
      }
    }
    this.history.push({ id: `evt-${String(++this.counter).padStart(6, '0')}`, type: event, payload, at: new Date().toISOString() })
  }

  /** Leader Bus.emit — returns event id. */
  emitWithId(event: string, payload: unknown): string {
    const id = `evt-${String(++this.counter).padStart(6, '0')}`
    this.history.push({ id, type: event, payload, at: new Date().toISOString() })
    const set = this.handlers.get(event)
    if (set) {
      for (const handler of [...set]) {
        try { handler(payload) } catch { }
      }
    }
    return id
  }

  subscribe(event: string, handler: HubHandler): void {
    this.on(event, handler)
  }

  /** Leader Bus.published() — snapshot of every emitted event. */
  published(): Array<{ id: string; type: string; payload: unknown; at: string }> {
    return [...this.history]
  }
}

/** Phase 1 EventSink: forwards every bus event into the shared hub. */
export function hubSink(hub: EventHub): { write(event: string, payload: unknown): void } {
  return {
    write(event: string, payload: unknown): void { hub.emit(event, payload) },
  }
}

/** Leader Bus adapter over the hub (promise-based signatures). */
export function hubBus(hub: EventHub) {
  return {
    emit: (type: string, payload: unknown): Promise<string> => Promise.resolve(hub.emitWithId(type, payload)),
    subscribe: (type: string, handler: (payload: unknown) => void): Promise<void> => { hub.subscribe(type, handler); return Promise.resolve() },
    published: (): Promise<Array<{ id: string; type: string; payload: unknown; at: string }>> => Promise.resolve(hub.published()),
  }
}
