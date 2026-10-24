#!/bin/bash
# Common-S v2 — unattended Ollama setup chain (Git Bash / Windows).
# 1. wait for the OllamaSetup.exe download to finish (no curl running, size stable)
# 2. install silently (NSIS /S)
# 3. start the server
# 4. pull qwen2.5-coder:1.5b + nomic-embed-text
# 5. empirical context ladder: 64K -> 32K -> 16K, any CPU offload = fail
LOG="$TEMP/ollama-chain.log"
exec >> "$LOG" 2>&1
echo "=== chain started $(date) ==="

SETUP="$TEMP/OllamaSetup.exe"

# --- 1. wait for the download to complete ---
stable=0
last=0
while true; do
  size=$(stat -c %s "$SETUP" 2>/dev/null || echo 0)
  curlRunning=$(tasklist 2>/dev/null | grep -ci "curl.exe" || true)
  if [ "$curlRunning" -eq 0 ] && [ "$size" -eq "$last" ] && [ "$size" -gt 1000000 ]; then
    break
  fi
  last=$size
  echo "waiting: size=$size curl=$curlRunning"
  sleep 30
done
echo "download complete: $size bytes"

# --- 2. install silently ---
"$SETUP" /S
echo "installer exited $?"

# --- 3. wait for the server ---
OLLAMA_EXE="$LOCALAPPDATA/Programs/Ollama/ollama.exe"
for i in $(seq 1 60); do
  [ -f "$OLLAMA_EXE" ] && break
  sleep 5
done
"$OLLAMA_EXE" serve > "$TEMP/ollama-serve.log" 2>&1 &
sleep 8
up=0
for i in $(seq 1 30); do
  if curl -s --max-time 2 http://localhost:11434/api/version | grep -q version; then up=1; break; fi
  sleep 5
done
if [ "$up" -ne 1 ]; then echo "FATAL: server did not start"; exit 1; fi
echo "server up"

# --- 4. pull models ---
"$OLLAMA_EXE" pull qwen2.5-coder:1.5b || { echo "FATAL: pull failed"; exit 1; }
"$OLLAMA_EXE" pull nomic-embed-text || { echo "FATAL: embed pull failed"; exit 1; }
"$OLLAMA_EXE" list

# --- 5. context ladder (Risk #3: any CPU offload = fail) ---
try_ctx () {
  local CTX=$1
  echo "=== testing num_ctx $CTX ==="
  "$OLLAMA_EXE" rm ruic-coder > /dev/null 2>&1
  printf 'FROM qwen2.5-coder:1.5b\nPARAMETER num_ctx %s\n' "$CTX" > "$TEMP/ruic-modelfile"
  "$OLLAMA_EXE" create ruic-coder -f "$TEMP/ruic-modelfile" || return 1
  python - "$CTX" << 'PYEOF'
import json, sys, urllib.request
ctx = int(sys.argv[1])
words = " ".join("function step%d return 1" % i for i in range(ctx // 4))
req = urllib.request.Request(
    "http://localhost:11434/api/generate",
    data=json.dumps({"model": "ruic-coder", "prompt": words, "stream": False,
                     "options": {"num_predict": 4}}).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(req, timeout=900)
    print("prompt ok")
except Exception as e:
    print("prompt failed:", e)
PYEOF
  local SPLIT
  SPLIT=$("$OLLAMA_EXE" ps | grep ruic-coder)
  echo "$SPLIT"
  if echo "$SPLIT" | grep -E "[0-9]+%[[:space:]]+CPU" > /dev/null; then
    echo "RESULT $CTX: FAIL (CPU offload)"
    return 1
  fi
  if echo "$SPLIT" | grep -q "100% GPU"; then
    echo "RESULT $CTX: PASS (fully on GPU)"
    return 0
  fi
  echo "RESULT $CTX: FAIL (not 100% GPU)"
  return 1
}
BEST=16384
for CTX in 65536 32768 16384; do
  if try_ctx "$CTX"; then BEST=$CTX; break; fi
done
mkdir -p "C:/Users/ctayy/Downloads/Ruic/app/COMMONS/STATE"
echo "$BEST" > "C:/Users/ctayy/Downloads/Ruic/app/COMMONS/STATE/context.txt"
echo "FINAL CONTEXT WINDOW: $BEST"
echo "=== CHAIN COMPLETE $(date) ==="
