// Opus//DECK Control Deck — publish the shared contract as the global `BT`.
//
// Loaded immediately after `../shared/bridge-types.js`, which populated the
// `module.exports` object created by `prelude.js`. The renderer then reads the
// canonical ordering + state-reduction helpers from `BT`.
window.BT = window.module.exports;
