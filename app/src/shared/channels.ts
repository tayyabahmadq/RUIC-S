/**
 * Opus//DECK App — IPC channel names.
 *
 * A single runtime constant shared by main (ipc.ts) and preload (bridge.ts).
 * Kept out of `bridge-types.ts` because that module is also loaded unmodified
 * into the renderer as a plain script; this one is main/preload-only.
 *
 * The channel set is the FULL list of surfaces the renderer can reach — there
 * are exactly three (two directions on the event channel, one invoke channel),
 * which is what the keys test asserts (R16/R19: no env, no file, no key
 * surface exists to reach).
 */
export const DECK_CHANNELS = {
  /** renderer -> main: exactly run | abort | config | crewHealth. */
  invoke: 'deck:invoke',
  /** main -> renderer: batched, ordered hub events. */
  eventsBatch: 'deck:events:batch',
  /** renderer -> main: synchronous full-history replay (state reconstruction). */
  eventsReplay: 'deck:events:replay',
} as const

export type DeckChannelName = (typeof DECK_CHANNELS)[keyof typeof DECK_CHANNELS]

/** Every channel the app may ever register. Used by the keys test. */
export const DECK_CHANNEL_NAMES: readonly string[] = Object.values(DECK_CHANNELS)
