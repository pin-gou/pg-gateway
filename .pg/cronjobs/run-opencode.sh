#!/bin/bash
set -euo pipefail

RUN_OPENCODE_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$RUN_OPENCODE_SCRIPT_DIR/../.." && pwd)"
JOB_FILE="${1:-$RUN_OPENCODE_SCRIPT_DIR/job.yaml}"
cd "$REPO_ROOT"

if [ ! -f "$JOB_FILE" ]; then
    echo ">>> $JOB_FILE not found, skip"
    exit 0
fi

# 解析结构化 YAML：用 python3 + PyYAML，字段值经 base64 编码输出，
# 保证 prompt 等多行字段在 shell 间传递不损坏
B64_VALUES="$(python3 - "$JOB_FILE" <<'PYEOF'
import base64
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write("PyYAML not installed, please pip install pyyaml\n")
    sys.exit(1)

with open(sys.argv[1]) as f:
    data = yaml.safe_load(f) or {}

for key in ("model", "agent", "title", "prompt"):
    value = data.get(key)
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    print("%s_B64=%s" % (key.upper(), base64.b64encode(value.encode()).decode()))
PYEOF
)"

eval "$B64_VALUES"

PROMPT="$(printf '%s' "$PROMPT_B64" | base64 -d)"
MODEL="$(printf '%s' "$MODEL_B64" | base64 -d)"
AGENT="$(printf '%s' "$AGENT_B64" | base64 -d)"
TITLE="$(printf '%s' "$TITLE_B64" | base64 -d)"

if [ -z "$PROMPT" ]; then
    echo ">>> $JOB_FILE prompt is empty, skip"
    exit 0
fi

# 暂存本地修改，避免 git 操作丢失变更
STASH_RESULT=$(git stash push -m "cronjob-auto-stash-$(date +%Y%m%d%H%M%S)" 2>&1) || true

# 无论脚本后续是否出错，退出时恢复暂存
trap 'git stash pop 2>/dev/null || true' EXIT

git checkout master

git pull --rebase

OPENCODE_ARGS=()
if [ -n "$MODEL" ]; then OPENCODE_ARGS+=(--model "$MODEL"); fi
if [ -n "$AGENT" ]; then OPENCODE_ARGS+=(--agent "$AGENT"); fi
if [ -n "$TITLE" ]; then OPENCODE_ARGS+=(--title "$TITLE"); fi

echo ">>> opencode run ${OPENCODE_ARGS[*]}"
opencode run "${OPENCODE_ARGS[@]}" "$PROMPT"
