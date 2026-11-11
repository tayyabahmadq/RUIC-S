/**
 * opus-deck — Phase 10: CLI & Surface (public API).
 */
export { CommonsError } from './types.js'
export {
  formatTokens, formatDuration, formatSeverity, SeverityColor, ResetColor,
} from './types.js'
export { registerAbort, isAborted } from './abort.js'
export { Commands, type CommandHandler } from './commands.js'
export { renderDashboard, replayFromDelta, type DashboardState } from './dashboard.js'
export type {
  RunConfig, Task, PresenceEntry, WorkingSetEntry, EventBus, BusEvent,
} from './types.js'
