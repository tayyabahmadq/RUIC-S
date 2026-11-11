#!/usr/bin/env bash
# Rebuild the UI visual-check harness from the app's current dist/ output.
# Layout mirrors dist/: renderer/index.html + sibling ../shared/, so the
# page's relative `../shared/bridge-types.js` reference resolves unchanged.
# Relocatable: everything is derived from this script's location, so the
# repo can be cloned anywhere. Run after `npm run build` in app/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <repo>/tools/verify
APP="$(cd "$HERE/../../app" && pwd)"
H="$HERE/.harness"
rm -rf "$H/renderer" "$H/shared"
mkdir -p "$H/renderer" "$H/shared"
cp "$APP"/dist/renderer/* "$H/renderer/"
cp "$APP"/dist/shared/* "$H/shared/"
cp "$HERE/mock-bridge.js" "$H/renderer/mock-bridge.js"
# Inject the mock bridge script between bind-bt.js and app.js.
python3 - "$H/renderer/index.html" <<'PY'
import sys
p = sys.argv[1]
html = open(p, encoding='utf-8').read()
if 'mock-bridge.js' not in html:
    html = html.replace('<script src="bind-bt.js"></script>',
                         '<script src="bind-bt.js"></script>\n  <script src="mock-bridge.js"></script>')
    open(p, 'w', encoding='utf-8').write(html)
PY
echo "harness ready: $H/renderer/index.html"
