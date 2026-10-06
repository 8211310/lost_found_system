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
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
pass=0; fail=0; skipped=0

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

# skip <描述> —— 前置条件不满足时用，和 PASS/FAIL 都区分开。
#
# 为什么不算 FAIL：这一层的职责是「环境活着吗」，缺 psql 不代表后端坏了。
# 为什么也不算 PASS：那样「全绿」会悄悄少测一条判据 —— 这正是 §10 里
# REQUIRE_INTEGRATION 那个开关要防的同一类假象。所以单独计数并打出来。
skip() {
  printf '  %sSKIP%s %s\n' "$YELLOW" "$RESET" "$1"
  skipped=$((skipped + 1))
}

section() { printf '\n%s== %s ==%s\n' "$DIM" "$1" "$RESET"; }

# req <method> <path> [json body] [token]
#
# 结果放进两个全局变量：STATUS（HTTP 状态码）和 BODY（响应体）。
# 用全局变量而不是 stdout，是因为一次请求要同时给出这两样，而 bash 函数只能
# 从 stdout 返回一个字符串 —— 硬塞在一起就得再解析一遍，反而更容易出错。
#
# ⚠ 请求体一律走 stdin（--data-binary @-），**绝不**作为 curl 的命令行参数。
#
# 这不是风格选择，是这台机器上实测出来的坑：Git Bash 把参数交给 Windows 原生的
# curl.exe 时要按当前代码页（cp1252）转换一次，中文字符不在 cp1252 里，
# 于是每个汉字都变成一个 '?'。症状是「注册接口把昵称存成了 ??」——
# 看起来像后端编码坏了，实际上是请求在离开 shell 的那一刻就已经烂了。
# 走 stdin 的字节由 bash 直接写进管道，不经过这次转换，所以是干净的 UTF-8。
#
# 反过来说：如果你在别的环境里看到中文变问号，先用这个办法分清是 shell 的锅还是后端的锅：
#   printf '%s' '{"nickname":"冒烟"}' | curl -X PUT ... --data-binary @-
STATUS=""; BODY=""
req() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local -a args=(-s -X "$method" -w '\n%{http_code}' "$BASE$path")
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi

  local out
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary @-)
    out="$(printf '%s' "$body" | curl "${args[@]}")"
  else
    out="$(curl "${args[@]}")"
  fi
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

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

# ---------------------------------------------------------------- M1 认证
section "M1 认证：#1–#5（注册 → 登录 → /me → 改资料 → 改密码）"

# 每次跑都换一个用户名：这个脚本打的是**开发库**，重复注册会撞 USER_ALREADY_EXISTS。
# 后缀是「秒 + bash 随机数」，同一秒里连跑两次也不会撞。
U="smoke$(date +%s)$RANDOM"
P="correct-horse-battery"
P2="new-password-staple"
printf '  %s本轮冒烟用户：%s%s\n' "$DIM" "$U" "$RESET"

# ---- #1 注册 ----
req POST /api/auth/register "{\"username\":\"$U\",\"password\":\"$P\",\"nickname\":\"冒烟\"}"
check '#1 注册返回 HTTP 200'          '200'              "$STATUS"
check '  code 是 OK'                  '"code":"OK"'     "$BODY"
check '  data.role 是 user（不能让请求体决定角色）' '"role":"user"' "$BODY"
check '  data.nickname 原样返回'      '"nickname":"冒烟"' "$BODY"
if [[ "$BODY" == *'"token"'* ]]; then
  printf '  %sFAIL%s 注册响应里出现了 token —— §4 第 1 行的 data 只有四个字段\n' "$RED" "$RESET"; fail=$((fail + 1))
else
  printf '  %sPASS%s 注册响应里没有 token（§4：注册和登录是两个端点）\n' "$GREEN" "$RESET"; pass=$((pass + 1))
fi

# 重名
req POST /api/auth/register "{\"username\":\"$U\",\"password\":\"$P\"}"
check '  重名返回 HTTP 409'           '409'                        "$STATUS"
check '  code 是 USER_ALREADY_EXISTS' '"code":"USER_ALREADY_EXISTS"' "$BODY"

# 弱密码（8 位但纯数字，中 §8 两条规则里的第二条）
req POST /api/auth/register '{"username":"weakling_smoke","password":"12345678"}'
check '  弱密码返回 HTTP 400'         '400'                  "$STATUS"
check '  code 是 WEAK_PASSWORD'       '"code":"WEAK_PASSWORD"' "$BODY"

# 用户名不存在和密码错误必须**完全同形**，否则登录接口就是一本用户名字典的探针
req POST /api/auth/login '{"username":"definitely_not_registered_smoke","password":"whatever"}'
unknown_status="$STATUS"; unknown_body="$BODY"
req POST /api/auth/login "{\"username\":\"$U\",\"password\":\"wrong-password\"}"
check '#2 密码错误返回 HTTP 401'      '401' "$STATUS"
check '  code 是 INVALID_CREDENTIALS' '"code":"INVALID_CREDENTIALS"' "$BODY"
if [[ "$unknown_status" == "$STATUS" && "$unknown_body" == *'"code":"INVALID_CREDENTIALS"'* ]]; then
  printf '  %sPASS%s 用户名不存在与密码错误同形（防账号枚举）\n' "$GREEN" "$RESET"; pass=$((pass + 1))
else
  printf '  %sFAIL%s 用户名不存在（%s）与密码错误（%s）不同形，能拿它枚举注册用户\n' \
    "$RED" "$RESET" "$unknown_status" "$STATUS"; fail=$((fail + 1))
fi

# ---- #2 登录 ----
req POST /api/auth/login "{\"username\":\"$U\",\"password\":\"$P\"}"
check '#2 登录返回 HTTP 200'          '200'              "$STATUS"
check '  code 是 OK'                  '"code":"OK"'     "$BODY"
check '  data 里有 expires_at'        '"expires_at":"'  "$BODY"
TOKEN="$(printf '%s' "$BODY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [[ ${#TOKEN} -gt 20 ]]; then
  printf '  %sPASS%s 拿到 token（%d 字符）\n' "$GREEN" "$RESET" "${#TOKEN}"
  pass=$((pass + 1))
else
  printf '  %sFAIL%s 没从响应里取出 token，后面几步都会连带失败\n' "$RED" "$RESET"
  printf '       %s实际输出: %s%s\n' "$DIM" "${BODY:0:400}" "$RESET"
  fail=$((fail + 1))
fi

# ---- #3 GET /api/auth/me ----
req GET /api/auth/me '' "$TOKEN"
check '#3 带 token 访问 /me 返回 200' '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"' "$BODY"
check "  返回的是本人（$U）"           "\"username\":\"$U\"" "$BODY"
if [[ "$BODY" == *password* || "$BODY" == *'$2a$'* || "$BODY" == *'$2b$'* ]]; then
  printf '  %sFAIL%s /me 的响应里出现了 password 或 bcrypt 哈希\n' "$RED" "$RESET"; fail=$((fail + 1))
else
  printf '  %sPASS%s /me 的响应里没有 password_hash\n' "$GREEN" "$RESET"; pass=$((pass + 1))
fi

req GET /api/auth/me
check '  不带 token 返回 HTTP 401'    '401'                  "$STATUS"
check '  code 是 UNAUTHORIZED'        '"code":"UNAUTHORIZED"' "$BODY"
check '  401 也带 request_id'         '"request_id":"'       "$BODY"

# 改签名的**第一个**字符。不能改最后一个：base64url 末位有 2 个填充位被忽略，
# 'A'/'B'/'C'/'D' 解出来是同样的字节，改了等于没改，测试会假红。
sig="${TOKEN##*.}"
prefix="${TOKEN%.*}"
repl="A"; [[ "${sig:0:1}" == "A" ]] && repl="B"
req GET /api/auth/me '' "${prefix}.${repl}${sig:1}"
check '  签名被改一个字符 → 401'      '401'                  "$STATUS"
check '  code 是 UNAUTHORIZED'        '"code":"UNAUTHORIZED"' "$BODY"

# ---- #4 PUT /api/auth/me ----
req PUT /api/auth/me '{"nickname":"冒烟改名","phone":"问宿舍阿姨"}' "$TOKEN"
check '#4 改资料返回 HTTP 200'        '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"' "$BODY"
check '  新昵称生效'                  '"nickname":"冒烟改名"' "$BODY"
# 只传了 nickname 和 phone，email 必须原封不动（「字段缺失」和「空串」是两回事）
req PUT /api/auth/me '{"email":"a@b.c"}' "$TOKEN"
check '  改 email 不会冲掉 nickname'  '"nickname":"冒烟改名"' "$BODY"
# 这个系统不发邮件也不发短信，所以刻意不校验格式 —— 和 items.contact 同一个判断
req PUT /api/auth/me '{"phone":"图书馆前台 86919001"}' "$TOKEN"
check '  非格式化的联系方式被原样接受' '"phone":"图书馆前台 86919001"' "$BODY"
req PUT /api/auth/me '{"nickname":""}' "$TOKEN"
check '  昵称清空被拒（VALIDATION）'  '"code":"VALIDATION"' "$BODY"
req PUT /api/auth/me '{"nickname":"黑客"}'
check '  改资料不带 token → 401'      '"code":"UNAUTHORIZED"' "$BODY"

# ---- #5 POST /api/auth/change-password ----
req POST /api/auth/change-password "{\"old_password\":\"not-mine\",\"new_password\":\"$P2\"}" "$TOKEN"
check '#5 旧密码不对返回 HTTP 400'    '400'                       "$STATUS"
check '  code 是 OLD_PASSWORD_WRONG'  '"code":"OLD_PASSWORD_WRONG"' "$BODY"

req POST /api/auth/change-password "{\"old_password\":\"$P\",\"new_password\":\"12345678\"}" "$TOKEN"
check '  新密码太弱 → WEAK_PASSWORD'  '"code":"WEAK_PASSWORD"' "$BODY"

req POST /api/auth/change-password "{\"old_password\":\"$P\",\"new_password\":\"$P2\"}" "$TOKEN"
check '  改密码成功返回 HTTP 200'     '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"' "$BODY"
check '  data 是 null（§4：没有需要回传的结果）' '"data":null' "$BODY"

req POST /api/auth/login "{\"username\":\"$U\",\"password\":\"$P2\"}"
check '  新密码能登录'                '"code":"OK"' "$BODY"
req POST /api/auth/login "{\"username\":\"$U\",\"password\":\"$P\"}"
check '  旧密码登不上了'              '"code":"INVALID_CREDENTIALS"' "$BODY"

# 已知限制：改密码**不会**让旧 token 失效（JWT 无状态，只能等它过期）。
# 要真正做到需要给 users 加一列 password_changed_at，计划 §3.7 里没有。
req GET /api/auth/me '' "$TOKEN"
check '  旧 token 仍然有效（已知限制，见 m1_auth_test.go）' '"code":"OK"' "$BODY"

# ---- 封禁 ----
# 这一步必须直接改库：M6 才有封禁端点。所以它需要 psql 和开发库的凭据，
# 拿不到就 SKIP —— 这条判据在 backend/smoketest/m1_auth_test.go 里是无条件覆盖的。
envval() { sed -n "s/^$1=//p" "$ROOT/backend/.env" 2>/dev/null | head -1; }
DB_USER="$(envval DB_USER)";     DB_USER="${DB_USER:-lf}"
DB_PASSWORD="$(envval DB_PASSWORD)"; DB_PASSWORD="${DB_PASSWORD:-lf}"
DB_NAME="$(envval DB_NAME)";     DB_NAME="${DB_NAME:-lostfound}"
DB_PORT="$(envval DB_PORT)";     DB_PORT="${DB_PORT:-5432}"

if ! command -v psql >/dev/null 2>&1; then
  skip '封禁后登录 → USER_BANNED（本机没有 psql，无法直接改库）'
elif ! PGPASSWORD="$DB_PASSWORD" psql -w -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
     -c "UPDATE users SET status='banned', updated_at=now() WHERE username='$U'" >/dev/null 2>&1; then
  skip "封禁后登录 → USER_BANNED（psql 连不上 $DB_USER@$DB_NAME，试试 bash scripts/setup-postgres.sh）"
else
  req POST /api/auth/login "{\"username\":\"$U\",\"password\":\"$P2\"}"
  check '封禁后登录返回 HTTP 403'     '403'                 "$STATUS"
  check '  code 是 USER_BANNED'       '"code":"USER_BANNED"' "$BODY"

  # 旧 token 也必须立刻失效。role/status 刻意不进 JWT claims、中间件每请求回库读一次，
  # 换的就是这一条：admin 一点封禁，那个人手上的 token 当场作废，而不是还能用满 24 小时。
  req GET /api/auth/me '' "$TOKEN"
  check '  封禁后旧 token 立刻失效'   '"code":"USER_BANNED"' "$BODY"
fi

# ---------------------------------------------------------------- 汇总
printf '\n%s────────────────────────────%s\n' "$DIM" "$RESET"
if [[ $fail -eq 0 ]]; then
  printf '%s全部通过：%d 项%s' "$GREEN" "$pass" "$RESET"
  [[ $skipped -gt 0 ]] && printf '，%s跳过 %d 项%s' "$YELLOW" "$skipped" "$RESET"
  printf '\n'
else
  printf '%s%d 项通过，%d 项失败%s' "$RED" "$pass" "$fail" "$RESET"
  [[ $skipped -gt 0 ]] && printf '，%s%d 项跳过%s' "$YELLOW" "$skipped" "$RESET"
  printf '\n'
fi
printf '%s开发库里留下了本轮的冒烟用户 %s；要清掉就在 pgAdmin 里删掉这一行。%s\n' "$DIM" "$U" "$RESET"
printf '%s拿上面任意一条的 request_id 去后端日志里 grep，能看到完整链路%s\n\n' "$DIM" "$RESET"
[[ $fail -eq 0 ]] || exit 1
exit 0
