// Opus//DECK Control Deck — CommonJS prelude for the shared contract file.
//
// The compiled shared contract (`../shared/bridge-types.js`) is emitted as
// CommonJS, so a classic <script> load needs `module`/`exports` to already
// exist. This file runs BEFORE it; `bind-bt.js` runs AFTER it and publishes the
// module exports as the global `BT`. Loading these as external files (instead
// of an inline script) keeps the page's strict CSP (`script-src 'self'`) intact.
window.module = { exports: {} };
window.exports = window.module.exports;
