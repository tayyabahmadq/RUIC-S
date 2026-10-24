/**
 * Phase 11: crew default-bus retarget seam.
 *
 * buildPrompt() takes its bus from args.bus (injected by wiring) — there is
 * NO isolated module-default bus, so the known isolation-bus bug cannot
 * occur. f07SetDefaultBus() is a no-op seam retained so the wiring layer can
 * uniformly "retarget" the crew bus; the actual bus used is args.bus.
 */
import type { EventBus } from '../crew/types.js'

let _unused: EventBus | undefined

export function f07SetDefaultBus(bus: EventBus): void {
  _unused = bus
}
