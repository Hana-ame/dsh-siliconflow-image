#!/bin/bash
# Restart dsh-web.service and verify dsh-siliconflow-image actually reached the
# new process's plugin graph.
#
# WHY A TRANSIENT UNIT: dsh-web.service runs with KillMode=control-group and the
# agent shell that launches this script lives INSIDE that cgroup. setsid/nohup
# cannot escape a cgroup, so anything merely backgrounded dies mid-restart.
# Launched via `systemd-run`, this script becomes a SIBLING unit under
# /system.slice/ and survives the restart it performs.
#
# Usage (from inside a DSH session on this host):
#   sudo -n systemd-run --unit=dsh-web-restart-$(date +%s) --collect \
#     --setenv=DSH_RESTART_DELAY=120 \
#     /home/lumin/dsh-plugins/dsh-siliconflow-image/scripts/restart-verify.sh
#
# Progress + verdict are appended to restart.log; the verdict starts with
# "RESULT:".
#
# WHY THIS RESTART IS NEEDED: a new bundle row may activate through profile
# HMR, but the plugin's JavaScript module generation is fixed for the process
# lifetime. Code edits after the row loaded only reach clients after a new
# process. The browser half (`client.js`) is re-read from disk per request by
# dsh-client-modules, but its *manifest* (`dsh.client`) is scanned at boot, so
# adding or changing that declaration also needs this restart.

set -u

# Root's PATH lacks nvm; dsh's shebang is /usr/bin/env node.
export PATH=/home/lumin/.nvm/versions/node/v22.23.1/bin:$PATH

UNIT=${DSH_RESTART_UNIT:-dsh-web.service}
PORT=${DSH_RESTART_PORT:-3080}
HOST=127.0.0.1
DIR=/home/lumin/dsh-plugins/dsh-siliconflow-image
LOG="$DIR/scripts/restart.log"
NODE=${NODE_BIN:-/home/lumin/.nvm/versions/node/v22.23.1/bin/node}
DSH_BIN=${DSH_BIN:-/home/lumin/.nvm/versions/node/v22.23.1/bin/dsh}
PROFILE=/home/lumin/.dsh/profiles/web
PKG=$DIR
# The transient unit runs as root; dsh resolves $DSH_HOME, so pin the user home
# or every dsh invocation would read /root/.dsh instead.
export DSH_HOME=/home/lumin/.dsh

mkdir -p "$DIR/scripts"

# Trim BEFORE opening the log for append: doing it afterwards would move the
# file out from under the already-open fd and silently lose the closing lines.
if [ -f "$LOG" ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
fi
exec >>"$LOG" 2>&1

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() { say "RESULT: FAIL — $*"; exit 1; }

say "================ restart run begin (unit=$UNIT, euid=$(id -u)) ================"

# ── 1. 预检：文件、语法、单测、组合配置、子进程可解析 ─────────────────────
[ -f "$PKG/index.js" ] || fail "precheck: $PKG/index.js 不存在"
for f in "$PKG"/index.js "$PKG"/client.js "$PKG"/src/*.js; do
  "$NODE" --check "$f" || fail "precheck: 语法错误 $f"
done
say "precheck OK: 语法（index.js + client.js + src/*.js）"

( cd "$PKG" && "$NODE" --test test/*.test.js >/dev/null 2>&1 ) \
  || fail "precheck: 单元测试未全绿"
say "precheck OK: node --test test/*.test.js 全绿"

N_BUNDLE=$(python3 - "$PROFILE/package.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
print("1" if "dsh-siliconflow-image" in p.get("dsh",{}).get("profile",{}).get("bundles",[]) else "0")
PY
)
[ "$N_BUNDLE" = "1" ] || fail "precheck: web profile bundles 未包含 dsh-siliconflow-image"
N_ROWS=$("$DSH_BIN" --profile web --dump-config 2>/dev/null | grep -c 'id: siliconflow-image')
[ "$N_ROWS" = "1" ] || fail "precheck: --dump-config 中 siliconflow-image 行数=$N_ROWS（期望 1）"
say "precheck OK: profile bundles + 组合配置恰好一行"

# 浏览器半：manifest 声明 + ./client 导出 + bundle 真的会注册自己。三者缺一，
# 浏览器里就静默没有参数面板（Host 行正常、dump-config 也正常，只是没 UI）。
python3 - "$PKG/package.json" <<'PY' || fail "precheck: package.json 缺少 dsh.client 或 ./client 导出"
import json,sys
p=json.load(open(sys.argv[1]))
c=p.get("dsh",{}).get("client")
assert isinstance(c,dict) and c.get("platform")=="web", "dsh.client.platform must be web"
assert "./client" in p.get("exports",{}), "exports 缺少 ./client"
PY
grep -q "__ModuleLoader__.load" "$PKG/client.js" || fail "precheck: client.js 没有调用 __ModuleLoader__.load"
"$NODE" -e "
const fs=require('node:fs');
let hit=null;
globalThis.window={__ModuleLoader__:{load:(e)=>{hit=e}}};
new Function(fs.readFileSync('$PKG/client.js','utf8'))();
if(!hit||hit.id!=='dsh-siliconflow-image')process.exit(2);
" || fail "precheck: client.js 注册 id 不是 dsh-siliconflow-image"
say "precheck OK: 浏览器半（dsh.client=web + ./client 导出 + 自注册 id 正确）"

# 解析预检用子进程做，避免借用 dsh 进程自己的 packageJsonCache
( cd "$PROFILE" && "$NODE" -e "import('dsh-siliconflow-image').then(m=>{if(typeof m.apply!=='function')process.exit(3)}).catch(()=>process.exit(2))" ) \
  || fail "precheck: $PROFILE 下 import('dsh-siliconflow-image') 失败"
say "precheck OK: profile 下可解析 dsh-siliconflow-image 的 apply"

if [ "${DSH_PRECHECK_ONLY:-0}" = "1" ]; then say "RESULT: PRECHECK-ONLY OK（未重启）"; exit 0; fi

PATCH_MTIME=$(stat -c %Y "$PKG/index.js")
say "index.js mtime=$PATCH_MTIME"

# ── 2. 留出把最后一条消息送到浏览器的宽限，然后重启 ──────────────────────
delay=${DSH_RESTART_DELAY:-0}
if [ "$delay" -gt 0 ]; then say "holding ${delay}s before restart (delivery grace)"; sleep "$delay"; fi

OLD_PID=$(systemctl show "$UNIT" -p MainPID --value)
say "restarting $UNIT (old MainPID=$OLD_PID)"
systemctl restart "$UNIT" || fail "systemctl restart 返回非零"

# ── 3. 等新 MainPID + 健康；web 先监听后挂路由，必须连续两次 401/200 ─────
NEW_PID=""
for _ in $(seq 1 60); do
  NEW_PID=$(systemctl show "$UNIT" -p MainPID --value)
  [ -n "$NEW_PID" ] && [ "$NEW_PID" != "0" ] && [ "$NEW_PID" != "$OLD_PID" ] && break
  sleep 1
done
[ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] && [ "$NEW_PID" != "0" ] \
  || fail "重启后未拿到新 MainPID（仍为 $NEW_PID）"
say "new MainPID=$NEW_PID"

CODE=000; PREV=000; ok=0
for _ in $(seq 1 90); do
  PREV=$CODE
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$HOST:$PORT/" 2>/dev/null)
  if { [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; } && { [ "$PREV" = "401" ] || [ "$PREV" = "200" ]; }; then
    ok=1; break
  fi
  sleep 1
done
[ "$ok" = "1" ] || fail "健康检查未连续两次 401/200（最后两次 $PREV → $CODE）"
say "healthy: 连续两次 $PREV → $CODE"

# ── 4. 关键断言：journal 不再出现本插件的激活失败 / 启动失败 ───────────────
sleep 2
if journalctl -u "$UNIT" --since "3 min ago" --no-pager 2>/dev/null | grep -qi "siliconflow-image.*failed to import"; then
  fail "journal 仍报 siliconflow-image failed to import"
fi
if journalctl -u "$UNIT" --since "3 min ago" --no-pager 2>/dev/null | grep -q "startup failed"; then
  fail "journal 报 startup failed"
fi
say "journal: 无 siliconflow-image 导入失败、无 startup failed"

# ── 5. 令牌与页面：确认本次启动可交互，把 URL 留进日志供人工复核 ───────────
TOKEN=$(journalctl -u "$UNIT" --since "6 min ago" --no-pager 2>/dev/null \
  | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
if [ -n "$TOKEN" ]; then
  CKDIR=$(mktemp -d)
  CODE0=$(curl -s -c "$CKDIR/c" -o /dev/null -w '%{http_code}' --max-time 8 "http://$HOST:$PORT/?token=$TOKEN")
  CODE1=$(curl -s -b "$CKDIR/c" -o /dev/null -w '%{http_code}' --max-time 8 "http://$HOST:$PORT/")
  rm -rf "$CKDIR"
  say "page: token 首次 $CODE0，带 cookie 二次 $CODE1（期望 200）"
  [ "$CODE1" = "200" ] || fail "带令牌 cookie 的页面返回 $CODE1"
  say "打开（浏览器自动登录）：http://$HOST:$PORT/?token=$TOKEN"
else
  say "page: 未从 journal 取到令牌（不影响结论；页面地址 http://$HOST:$PORT/）"
fi

START_EPOCH=$(systemctl show "$UNIT" -p ActiveEnterTimestampMonotonic --value)
say "new process monotonic-start(us)=$START_EPOCH, plugin index.js mtime(s)=$PATCH_MTIME"

say "RESULT: OK — dsh-siliconflow-image 已由新 MainPID=$NEW_PID 加载；模型选择器应出现「SiliconFlow 生图」，generate_image 工具应进入工具列表"