/**
 * 远程 bootstrap 脚本 —— 经 ssh stdin 在目标主机执行,幂等。
 *
 * 流程:探测平台 → 已装过同版本则跳过 → 缺产物则打印 AGW_NEED_UPLOAD 退出 3
 * (客户端上传后重跑)→ 有存活实例则复用 → 否则启动并等 stdout 哨兵。
 * 脚本只用 POSIX sh + 通用工具(grep/tar/sha256sum|shasum),不依赖 python/node。
 */
export interface BootstrapArtifactSet {
  version: string
  protocolVersion: number
  /** target(linux-x64 等)→ 产物文件名与 sha256;客户端据此决定上传哪个文件。 */
  artifacts: Record<string, { file: string; sha256: string }>
}

export const BOOTSTRAP_NEED_UPLOAD_CODE = 3

export function buildBootstrapScript(set: BootstrapArtifactSet): string {
  const sha = (target: string) => set.artifacts[target]?.sha256 ?? 'missing'
  return `#!/bin/sh
set -eu
AGW_VERSION='${set.version}'
AGW_PROTOCOL='${set.protocolVersion}'
ROOT="$HOME/.agent-development-gateway/server"

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS-$ARCH" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  *) echo "AGW_ERROR 不支持的平台 $OS-$ARCH" >&2; exit 2 ;;
esac
if [ "$OS" = Linux ] && { ldd --version 2>&1 | grep -qi musl; }; then
  echo "AGW_ERROR musl libc 暂不支持(node-pty 没有 musl prebuild)" >&2
  exit 2
fi
case "$TARGET" in
  linux-x64) AGW_SHA256='${sha('linux-x64')}' ;;
  linux-arm64) AGW_SHA256='${sha('linux-arm64')}' ;;
  darwin-arm64) AGW_SHA256='${sha('darwin-arm64')}' ;;
  darwin-x64) AGW_SHA256='${sha('darwin-x64')}' ;;
esac
if [ "$AGW_SHA256" = missing ]; then
  echo "AGW_ERROR 客户端没有 $TARGET 平台的产物,请先运行 pnpm package -- --target $TARGET" >&2
  exit 2
fi
AGW_FILE="agent-gateway-server-\${AGW_VERSION}-\${TARGET}.tar.gz"
DIR="agent-gateway-server-\${AGW_VERSION}-\${TARGET}"
INST="$ROOT/versions/$DIR"

if [ ! -f "$INST/install.json" ]; then
  mkdir -p "$ROOT/downloads" "$ROOT/versions"
  OK=0
  if [ -f "$ROOT/downloads/$AGW_FILE" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$ROOT/downloads" && echo "$AGW_SHA256  $AGW_FILE" | sha256sum -c - >/dev/null 2>&1) && OK=1
    else
      (cd "$ROOT/downloads" && echo "$AGW_SHA256  $AGW_FILE" | shasum -a 256 -c - >/dev/null 2>&1) && OK=1
    fi
  fi
  if [ "$OK" != 1 ]; then
    echo "AGW_NEED_UPLOAD $AGW_FILE"
    exit ${BOOTSTRAP_NEED_UPLOAD_CODE}
  fi
  TMP="$ROOT/versions/.\${DIR}.tmp"
  rm -rf "$TMP"
  mkdir -p "$TMP"
  tar -xzf "$ROOT/downloads/$AGW_FILE" -C "$TMP" --strip-components=1
  rm -rf "$INST"
  mv "$TMP" "$INST"
  echo "AGW_INSTALLED $DIR"
fi

if [ -f "$ROOT/runtime.json" ]; then
  PID=$(grep -o '"pid":[0-9]*' "$ROOT/runtime.json" | head -1 | cut -d: -f2)
  PV=$(grep -o '"protocolVersion":[0-9]*' "$ROOT/runtime.json" | head -1 | cut -d: -f2)
  if [ -n "\${PID:-}" ] && [ "\${PV:-}" = "$AGW_PROTOCOL" ] && kill -0 "$PID" 2>/dev/null; then
    echo "AGENT_GATEWAY_LISTENING $(tr -d '\\n' < "$ROOT/runtime.json")"
    exit 0
  fi
fi

rm -f "$ROOT/server.log.1"
[ -f "$ROOT/server.log" ] && mv "$ROOT/server.log" "$ROOT/server.log.1"
AGENT_GATEWAY_DATA_DIR="$ROOT" PORT=0 AGENT_GATEWAY_AUTH=token nohup "$INST/bin/start.sh" > "$ROOT/server.log" 2>&1 < /dev/null &
for i in $(seq 1 60); do
  LINE=$(grep AGENT_GATEWAY_LISTENING "$ROOT/server.log" 2>/dev/null | tail -1 || true)
  if [ -n "$LINE" ]; then
    echo "$LINE"
    exit 0
  fi
  sleep 0.5
done
echo "AGW_ERROR server 启动后 30s 内未报告监听端口" >&2
tail -n 10 "$ROOT/server.log" >&2 || true
exit 1
`
}

/** 从 bootstrap 输出中解析哨兵行。 */
export function parseListeningSentinel(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.startsWith('AGENT_GATEWAY_LISTENING '))
  if (!line) return undefined
  try {
    return JSON.parse(line.slice('AGENT_GATEWAY_LISTENING '.length)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** NEED_UPLOAD 时解析需要的产物文件名。 */
export function parseNeededUpload(stdout: string): string | undefined {
  const line = stdout
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.startsWith('AGW_NEED_UPLOAD '))
  return line?.slice('AGW_NEED_UPLOAD '.length).trim() || undefined
}
