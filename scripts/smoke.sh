#!/usr/bin/env bash
#
# 手工冒烟脚本（计划 §10 的第③层）。
#
# 它和 backend/smoketest/ 的区别：
#   smoketest/  由 go test 驱动，跑在临时测试库 lostfound_test 上，验证「代码逻辑对」
#   这个脚本    打的是你正在跑的那个 dev server 和它的开发库，验证「环境活着」
# 两个都要跑：前者过了不代表你的 docker / .env / 端口没问题。
#
# 用法（Git Bash）：
#   docker compose up -d                          # Docker 路径
#   bash scripts/setup-postgres.sh                # 或：原生 Windows PostgreSQL 路径
#   cd backend && go run ./cmd/server &
#   bash scripts/smoke.sh
#
# 换端口：BASE=http://localhost:9090 bash scripts/smoke.sh

set -uo pipefail

BASE="${BASE:-http://localhost:8080}"
GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
pass=0; fail=0

tmp_headers="$(mktemp)"
trap 'rm -f "$tmp_headers"' EXIT

# check <描述> <期望包含的子串> <实际输出>
check() {
  if [[ "$3" == *"$2"* ]]; then
    printf '  %sPASS%s %s\n' "$GREEN" "$RESET" "$1"
    pass=$((pass + 1))
  else
    printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"
    printf '       %s期望包含: %s%s\n' "$DIM" "$2" "$RESET"
    printf '       %s实际输出: %s%s\n' "$DIM" "${3:0:400}" "$RESET"
    fail=$((fail + 1))
  fi
}

section() { printf '\n%s== %s ==%s\n' "$DIM" "$1" "$RESET"; }

# ---------------------------------------------------------------- 前置检查
section "前置：服务在跑吗"
if ! curl -s -o /dev/null --max-time 5 "$BASE/api/health"; then
  printf '%s连不上 %s%s\n' "$RED" "$BASE" "$RESET"
  cat <<'EOF'

  按顺序检查：
    1. 数据库起来了吗
         Docker 路径：  docker compose up -d        （docker compose ps 看状态）
         原生路径：     pg_isready -h 127.0.0.1 -p 5432
                        没起就 bash scripts/setup-postgres.sh
    2. cd backend && cp .env.example .env
       然后给 JWT_SECRET 填一个随机串：openssl rand -hex 32
    3. cd backend && go run ./cmd/server
       看终端里有没有 startup.failed —— 它会直接告诉你缺哪个变量或连不上哪个库

EOF
  exit 1
fi
printf '  %sPASS%s %s 有响应\n' "$GREEN" "$RESET" "$BASE"
pass=$((pass + 1))

# ---------------------------------------------------------------- #38 健康检查
section "#38 GET /api/health"
body="$(curl -s -D "$tmp_headers" "$BASE/api/health")"
check 'code 是 OK'                    '"code":"OK"'  "$body"
check 'data.status 是 ok'             '"status":"ok"' "$body"
check 'data.db 是 ok'                 '"db":"ok"'    "$body"
check 'data.version 非空'             '"version":"'  "$body"
check '信封里有 request_id'           '"request_id":"' "$body"
check '响应头回写 X-Request-ID'       'X-Request-Id:' "$(cat "$tmp_headers")"

# request_id 的形状：日期-16位十六进制（8 字节随机数）
rid="$(printf '%s' "$body" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')"
if [[ "$rid" =~ ^[0-9]{8}-[0-9a-f]{16}$ ]]; then
  printf '  %sPASS%s request_id 形状正确（%s）\n' "$GREEN" "$RESET" "$rid"
  pass=$((pass + 1))
else
  printf '  %sFAIL%s request_id 形状不对：%s（期望 YYYYMMDD-16位十六进制）\n' "$RED" "$RESET" "$rid"
  fail=$((fail + 1))
fi

# ---------------------------------------------------------------- 信封契约
section "信封契约：非正常路径也必须是同一个形状"

body="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/health")"
check 'POST /api/health 返回 405'     '405' "$body"
body="$(curl -s -X POST "$BASE/api/health")"
check '  且 body 是 METHOD_NOT_ALLOWED' '"code":"METHOD_NOT_ALLOWED"' "$body"

body="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/definitely-not-real")"
check '不存在的路径返回 404'          '404' "$body"
body="$(curl -s "$BASE/api/definitely-not-real")"
check '  且 body 是 NOT_FOUND（不是 gin 的纯文本 404）' '"code":"NOT_FOUND"' "$body"
check '  且仍然带 request_id'         '"request_id":"' "$body"

# ---------------------------------------------------------------- RequestID 防线
section "RequestID：沿用客户端传入的，且过滤危险字符"

# 客户端自带的 id 必须原样沿用 —— 这样前端的「一次操作」能和后端日志对上
out="$(curl -s -D "$tmp_headers" -H 'X-Request-ID: 20261007-manual01' "$BASE/api/health")"
check '沿用客户端传入的 request_id'   '20261007-manual01' "$out"
check '  响应头也原样回写'            '20261007-manual01' "$(cat "$tmp_headers")"

# 非白名单字符必须被过滤掉。白名单是 [A-Za-z0-9._-]，
# 换行、制表符这些能把日志撕成两行的字符都在名单外 —— 这是日志注入的防线。
# 这里用 ! @ 空格 来测，而不是真的塞换行符：带换行的 header 值 curl 根本不会发出去。
out="$(curl -s -H 'X-Request-ID: abc!!def@@ ghi' "$BASE/api/health")"
check '非白名单字符被过滤（abc!!def@@ ghi → abcdefghi）' '"request_id":"abcdefghi"' "$out"

# ---------------------------------------------------------------- 汇总
printf '\n%s────────────────────────────%s\n' "$DIM" "$RESET"
if [[ $fail -eq 0 ]]; then
  printf '%s全部通过：%d 项%s\n\n' "$GREEN" "$pass" "$RESET"
  exit 0
fi
printf '%s%d 项通过，%d 项失败%s\n' "$RED" "$pass" "$fail" "$RESET"
printf '%s拿上面任意一条的 request_id 去后端日志里 grep，能看到完整链路%s\n\n' "$DIM" "$RESET"
exit 1
