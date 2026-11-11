/**
 * Typed event bus for Opus//DECK. Plain TypeScript, no external libraries.
 * Handlers fire synchronously in registration order; `once` handlers are
 * removed after their first invocation. Events are forwarded to an EventSink.
 */
import type { EventBus, EventName, EventPayloads, EventSink } from './types.js'

export class EventBusImpl implements EventBus {
  private readonly handlers = new Map<EventName, Set<(payload: EventPayloads[EventName]) => void>>()
  private readonly sink: EventSink

  constructor(sink: EventSink) {
    this.sink = sink
  }

  on(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
  }

  once(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void {
    const runOnce = (payload: EventPayloads[EventName]): void => {
      this.removeHandler(event, runOnce)
      handler(payload)
    }
    this.addHandler(event, runOnce)
  }

  emit(event: EventName, payload: unknown): void {
    const set = this.handlers.get(event)
    if (set === undefined) {
      return
    }
    // Copy the set: handlers may unsubscribe while emitting.
    for (const handler of [...set]) {
      handler(payload as EventPayloads[EventName])
    }
    this.sink.write(event, payload as EventPayloads[EventName])
  }

  private addHandler(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
  }

  private removeHandler(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void {
    const set = this.handlers.get(event)
    if (set === undefined) {
      return
    }
    set.delete(handler)
    if (set.size === 0) {
      this.handlers.delete(event)
    }
  }
}

export type { EventBus, EventName, EventPayloads } from './types'
