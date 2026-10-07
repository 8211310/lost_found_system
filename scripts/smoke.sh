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

# check_re <描述> <ERE 模式> <实际输出> —— check 的正则版。
#
# 用来验「形状」而不是某个字面值，比如「images 数组里只剩一个对象」。
# 这类断言用子串写不出来（子串匹配不了括号和次数），用字面值写又会被 id 的
# 随机性绑死 —— 每次跑 id 都不一样。
check_re() {
  if printf '%s' "$3" | grep -qE "$2"; then
    printf '  %sPASS%s %s\n' "$GREEN" "$RESET" "$1"
    pass=$((pass + 1))
  else
    printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"
    printf '       %s期望匹配: %s%s\n' "$DIM" "$2" "$RESET"
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
#
# ⚠ 同一条坑对 **URL 查询串** 也成立，而它更隐蔽：`?keyword=冒烟` 作为参数发出去
#   会变成 `?keyword=???`，于是「搜索能命中」这条检查会假红，而「搜索不该命中」
#   那条检查会假绿。所以本脚本里所有出现在 URL 里的非 ASCII 都写成百分号编码，
#   并在旁边注释出它对应的中文 —— 失败信息里看到的仍是 %E5%86%92 这种可读性差的东西，
#   但那至少是**诚实**的可读性差。
#
# ⚠ M3 之后 #13 的响应里出现了**第二个** `"item":{"id":…}` —— 它是 matches_preview
#   数组里每一条匹配的候选帖（MatchHit 的形状就是 {item, score, breakdown}）。
#   `"item":\{"id":([0-9]+)` 因此会抠到候选帖的 id 而不是刚建出来那条，
#   而且因为候选是别人发的帖，症状是后面整段「本人改帖」变成 403 FORBIDDEN，
#   看起来像是权限模块坏了。全部五处抽取一律改用 `itemIDOf`（锚在 `"data":{` 上）。
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

# req_upload <token> <文件路径> [表单字段名，默认 file]
#
# multipart 请求没法用 req 发：req 只会把字符串塞进 --data-binary，
# 而 #6 的契约恰恰是「字段名必须叫 file、Content-Type 必须是 multipart 带 boundary」。
# curl 的 -F 会自己生成 boundary，不要手写 —— 手写的会和 curl 里的不一致。
req_upload() {
  local token="$1" file="$2" field="${3:-file}"
  local dir base out
  dir="$(dirname "$file")"; base="$(basename "$file")"

  # ⚠ 先 cd 再传**相对文件名**，而不是把绝对路径交给 curl。
  # Git Bash 会把「看起来像绝对路径」的参数换算成 Windows 路径再交给原生的 curl.exe，
  # 但 -F 的值是 `file=@/d/.../fake.png` 这种带 `file=@` 前缀的形式，换算规则在这里不靠谱。
  # 相对路径不参与换算；而 multipart 的 filename 本来也只该是 basename ——
  # 把本机目录结构写进一次上传请求里没有任何意义（它还会被存进日志）。
  out="$(cd "$dir" && curl -s -X POST -w '\n%{http_code}' \
        -H "Authorization: Bearer $token" -F "${field}=@${base}" "$BASE/api/uploads")"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# ---------------------------------------------------------------- 配置读取
# 这个脚本打的是**你正在跑的那个 dev server**，所以路径、端口都得从 backend/.env 里读，
# 而不是假设默认值 —— 有人把 UPLOAD_DIR 改成 D:/data/uploads 之后，
# 按默认值去找文件的检查会报「文件不存在」，而那恰恰是它要检查的事情本身。
envval() { sed -n "s/^$1=//p" "$ROOT/backend/.env" 2>/dev/null | head -1; }

DB_USER="$(envval DB_USER)";         DB_USER="${DB_USER:-lf}"
DB_PASSWORD="$(envval DB_PASSWORD)"; DB_PASSWORD="${DB_PASSWORD:-lf}"
DB_NAME="$(envval DB_NAME)";         DB_NAME="${DB_NAME:-lostfound}"
DB_PORT="$(envval DB_PORT)";         DB_PORT="${DB_PORT:-5432}"

# UPLOAD_DIR 是**相对后端进程工作目录**的（go run ./cmd/server 是在 backend/ 下跑的），
# 所以相对路径要拼上 backend/。
UPLOAD_DIR="$(envval UPLOAD_DIR)"; UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"
case "$UPLOAD_DIR" in
  /*)                       UPLOAD_ABS="$UPLOAD_DIR" ;;
  [A-Za-z]:[\\/]*)          UPLOAD_ABS="$UPLOAD_DIR" ;;
  *)                        UPLOAD_ABS="$ROOT/backend/$UPLOAD_DIR" ;;
esac

# 假图片：只有魔数是真的，后面全是填充字节。
#
# 为什么不用一张真 PNG：#6 的判定依据是**内容嗅探**（http.DetectContentType 只看前几个字节），
# 不是文件后缀，也不是能不能解码。所以 8 个魔数字节就足够让它认成 image/png，
# 而脚本里塞一段 base64 的真图片只会让这份脚本更难读。
# 反过来说，M2 的测试里确实验了「内容是 PNG 但后缀叫 .php」—— 那也正是这个意思。
make_fake() { # make_fake <输出路径> <魔数 printf 串> <填充字节数>
  printf "$2" > "$1"
  head -c "$3" /dev/zero | tr '\0' 'a' >> "$1"
}

# 一个临时目录而不是几个 mktemp 文件：这里要用到**文件名**（shell.php），
# 而 mktemp 给不出想要的后缀；#40 那一步还要让 curl 用 -o 往里面写下载回来的字节。
#
# ⚠ 必须是**纯 ASCII** 的路径。这一度是本机上一个最难自查的失败：
#   把临时目录放在仓库里（backend/.smoke-tmp）时，curl -o 写出来的文件根本不存在，
#   报的是「字节不一致」「首字节是 0x」这种和真实原因毫无关系的话。
#   原因在 Git Bash 那一层：仓库路径里有中文（失物招领系统），而 curl.exe 是原生程序，
#   它拿到的路径要按当前代码页（cp1252）换算一次 —— 和上面请求体那一条是同一个坑，
#   只不过这次挨打的是文件路径而不是 argv。mktemp -d 给的 /tmp/tmp.XXXXXX 是 ASCII 的，
#   所以它一直没事。
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir" "$tmp_headers"' EXIT
png_path="$tmp_dir/fake.png"
png_named_php_path="$tmp_dir/shell.php"
txt_path="$tmp_dir/notes.txt"

make_fake "$png_path" '\211PNG\r\n\032\n' 1024
make_fake "$png_named_php_path" '\211PNG\r\n\032\n' 1024
make_fake "$txt_path" 'this is not an image, it is a text file: ' 512

# jval <json> <带一个捕获组的 sed(ERE) 模式> —— 从一行 JSON 里抠一个值出来。
#
# 用 sed 而不是 jq：jq 既不是 Git Bash 自带的也不是 Windows 自带的，
# 而这一层脚本的定位是「随手能跑」。
#
# ⚠ 模式必须写得**足够具体**。`.*` 是最长匹配，所以 `"id":([0-9]+)` 抠到的是
#   响应里**最后一个** id，而一个 ItemView 里有 item.id、category.id、location.id、
#   author.id、images[].id 五六个 id。这里一律带上紧邻的上下文（`"item":\{"id":`），
#   宁可难读也不能抠错 —— 抠错比抠不到更糟，它会静默地测另一件事。
jval() { printf '%s' "$1" | sed -nE "s|.*$2.*|\1|p" | head -1; }

# itemIDOf <json> —— 抠出 #13 建出来那条帖子自己的 id。
#
# 为什么不直接写 jval 的模式：M3 之后同一个响应里有**好几个** `"item":{"id":`
# （matches_preview 数组里每条候选帖都是这个形状），而 `.*` 是最长匹配，
# 拿到的是最后一个 —— 也就是别人那条帖子的 id。后面所有「本人改帖」因此变成 403，
# 症状长得像权限模块坏了。锚在信封的 `"data":{` 上就只有唯一一处。
itemIDOf() { jval "$1" '"data":\{"item":\{"id":([0-9]+)'; }

# psql 可执行文件的位置。
#
# scoop 装的 PostgreSQL **不会**把它的 bin 加进 PATH（M0 那一步是手动 initdb + pg_ctl 起的），
# 所以 command -v 找不到它。这里主动认几个已知位置，找不到就退化成 SKIP。
#
# 值得专门写这一段的原因：只有能直接看数据库，才测得出
# 「接口返回了正确的错误码，但库里其实已经写进去了一行」这一类错误 ——
# 而那正是 §10 第③层相对第②层的唯一增量（第②层有 Pool，但没有 HTTP 之外的环境）。
PSQL=""
if command -v psql >/dev/null 2>&1; then
  PSQL=psql
else
  for cand in \
    /d/Scoop/apps/postgresql/current/bin/psql.exe \
    /c/Scoop/apps/postgresql/current/bin/psql.exe \
    "$HOME/scoop/apps/postgresql/current/bin/psql.exe"; do
    if [[ -x "$cand" ]]; then PSQL="$cand"; break; fi
  done
fi

# db <SQL> —— 直接查开发库，用于那些「接口看不出来越过了数据库」的断言。
# 没有 psql 或者连不上就返回空串，调用方一律走 SKIP（见上面的 skip 注释）。
HAS_PSQL=0
if [[ -n "$PSQL" ]] && "$PSQL" -w -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
  HAS_PSQL=1
fi
db() {
  [[ "$HAS_PSQL" == 1 ]] || return 0
  PGPASSWORD="$DB_PASSWORD" "$PSQL" -w -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA -c "$1" 2>/dev/null
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

# ---------------------------------------------------------------- M2 字典
section "M2 字典：#7 /api/categories、#8 /api/locations"

req GET /api/categories
check '#7 匿名返回 HTTP 200（发帖表单要能在没有登录时渲染）' '200' "$STATUS"
check '  code 是 OK'                  '"code":"OK"'  "$BODY"
check '  节点带 level'                '"level":'     "$BODY"
check '  节点带 sort_order'           '"sort_order":' "$BODY"
check '  叶子节点的 children 是 []'   '"children":[]' "$BODY"
check '  已知叶子：数码电子 → 手机(id=10,level=2)' '{"id":10,"name":"手机","level":2' "$BODY"
if [[ "$BODY" == *'"children":null'* ]]; then
  printf '  %sFAIL%s 出现了 "children":null —— 前端 data.children.map() 会直接崩\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 没有 "children":null\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi
if [[ "$BODY" == *parent_id* ]]; then
  printf '  %sFAIL%s 树形响应里出现了 parent_id —— 嵌套已经把父子关系表达完了\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 响应里没有 parent_id\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

req GET /api/locations
check '#8 匿名返回 HTTP 200'          '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"'  "$BODY"
check '  节点带 is_freeform'          '"is_freeform":' "$BODY"
check '  已知叶子：教学区（南侧）→ 场馆与公共建筑 → 图书馆(id=70,level=3)' \
      '{"id":70,"name":"图书馆","level":3' "$BODY"
check '  一级叶子「其他」也可选（§3.6 的特例：level=1 但没有子节点）' \
      '{"id":3,"name":"其他","level":1,"is_freeform":true' "$BODY"

# 发帖后面要用这两个 id。它们在 000001 迁移里是显式 INSERT 的，
# 所以写死是对的 —— 但先确认上面的树里真的有，否则迁移一改这里会静默地发到错的分类上。
CAT_ID=10; LOC_ID=70

# ---------------------------------------------------------------- M2 上传
section "M2 上传：#6 /api/uploads、#40 /uploads/*filepath"

req_upload "" "$png_path"
check '#6 不带 token 返回 HTTP 401'   '401'                 "$STATUS"
check '  code 是 UNAUTHORIZED'        '"code":"UNAUTHORIZED"' "$BODY"

req_upload "$TOKEN" "$png_path"
check '#6 传一张图返回 HTTP 200'      '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"' "$BODY"
PIC1="$(jval "$BODY" '"path":"([^"]+\.png)"')"
PIC1_URL="$(jval "$BODY" '"url":"([^"]+)"')"
if [[ -n "$PIC1" ]]; then
  printf '  %sPASS%s 拿到 path（%s）\n' "$GREEN" "$RESET" "$PIC1"; pass=$((pass+1))
else
  printf '  %sFAIL%s 没抠到 path，后面的上传检查会连带失败\n' "$RED" "$RESET"; fail=$((fail+1))
fi
# 按日期分目录 = UTC 的 YYYY/MM；文件名是 32 位十六进制（crypto/rand，猜不到）。
# ⚠ path 是**相对于 UPLOAD_DIR** 的，不带 uploads/ 前缀 —— 前缀属于 url，不属于 path。
#    这两个字段各管一件事：path 给 #13 的 image_paths 用（要落库），
#    url 给 <img src> 用（要过 HTTP）。把它们混成一个字符串的话，
#    落库的那一列就同时编码了「怎么存」和「怎么访问」，改挂载点得回来改数据。
if [[ "$PIC1" =~ ^$(date -u +%Y/%m)/[0-9a-f]{32}\.png$ ]]; then
  printf '  %sPASS%s path 形状正确（年/月/32位十六进制.png）\n' "$GREEN" "$RESET"; pass=$((pass+1))
else
  printf '  %sFAIL%s path 形状不对：%s\n' "$RED" "$RESET" "$PIC1"; fail=$((fail+1))
fi
# url 就是 /uploads/ + path —— #40 的挂载点决定了这个拼法没有别的 Possible
if [[ "$PIC1_URL" == "/uploads/$PIC1" ]]; then
  printf '  %sPASS%s url = /uploads/ + path\n' "$GREEN" "$RESET"; pass=$((pass+1))
else
  printf '  %sFAIL%s url=%s 而 path=%s，两者对不上\n' "$RED" "$RESET" "$PIC1_URL" "$PIC1"; fail=$((fail+1))
fi
[[ -f "$UPLOAD_ABS/$PIC1" ]] && \
  { printf '  %sPASS%s 文件真的落到了磁盘上\n' "$GREEN" "$RESET"; pass=$((pass+1)); } || \
  { printf '  %sFAIL%s 接口说成功了但 %s 不存在\n' "$RED" "$RESET" "$UPLOAD_ABS/$PIC1"; fail=$((fail+1)); }

# 内容嗅探，不看文件名：内容是 PNG、文件叫 shell.php，必须按 PNG 存下来。
# 这一条防的是「上传目录能被写成一个可执行文件」，以及「前端按用户给的后缀渲染」。
req_upload "$TOKEN" "$png_named_php_path"
check_re '  内容是 PNG 但文件名叫 shell.php → 仍然存成 .png' '"path":"[^"]*\.png"' "$BODY"
PIC2="$(jval "$BODY" '"path":"([^"]+\.png)"')"
if [[ "$PIC2" == *shell* ]]; then
  printf '  %sFAIL%s 存下来的文件名沿用了用户给的 shell.php\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 文件名是我们生成的，不含用户给的后缀\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# 第三张图专门留给 #42 之后的两段：「admin 也不能删图」需要一张还活着的图，
# 而那一节前面已经把前两张删干净了（一张是判据正文，一张是「重复删除不是幂等成功」）。
req_upload "$TOKEN" "$png_path"
PIC3="$(jval "$BODY" '"path":"([^"]+\.png)"')"

req_upload "$TOKEN" "$txt_path"
check '  传一个文本文件返回 HTTP 415' '415'                    "$STATUS"
check '  code 是 FILE_TYPE_UNSUPPORTED' '"code":"FILE_TYPE_UNSUPPORTED"' "$BODY"

req_upload "$TOKEN" "$png_path" image
check '  表单字段名不叫 file → HTTP 400' '400'          "$STATUS"
check '  code 是 VALIDATION'  '"code":"VALIDATION"' "$BODY"

# ---- #40 静态文件 ----
if [[ -n "$PIC1" ]]; then
  out="$(curl -s -D "$tmp_headers" -o "$tmp_dir/downloaded.bin" -w '%{http_code}' "$BASE/uploads/$PIC1")"
  check '#40 匿名 GET 上传文件返回 HTTP 200' '200' "$out"
  check '  Content-Type 是 image/png' 'image/png' "$(cat "$tmp_headers")"
  if cmp -s "$png_path" "$tmp_dir/downloaded.bin"; then
    printf '  %sPASS%s 下载回来的字节和上传的完全一致\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s 字节不一致（静态文件被改过了？）\n' "$RED" "$RESET"; fail=$((fail+1))
  fi
  # 首字节必须是 0x89 —— PNG 魔数的第一个字节。
  # 如果这里回来的是 '{'（0x7b），说明拿到的是 JSON 信封而不是图片本身。
  # cmp 已经能抓到这种情况，但那条失败信息会说「字节不一致」，
  # 而这一条会直接说「响应体不是二进制」，后者才是排查时想知道的那句话。
  first_byte="$(head -c 1 "$tmp_dir/downloaded.bin" | od -An -tx1 | tr -d ' \n')"
  if [[ "$first_byte" == "89" ]]; then
    printf '  %sPASS%s 响应体是图片二进制（首字节 0x89），不是 JSON 信封\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s 响应体首字节是 0x%s，不是 PNG 的 0x89\n' "$RED" "$RESET" "$first_byte"; fail=$((fail+1))
  fi
fi

# 目录穿越。%2e 是 URL 编码的点：gin 的 Static 会先解码，所以能不能拦住取决于实现，
# 而不是取决于 curl 有没有把 .. 送出去（curl 自己不会归一化 URL 路径）。
for trav in '../backend/.env' '..%2F..%2Fbackend%2F.env' '%2e%2e%2f%2e%2e%2fbackend%2f.env'; do
  out="$(curl -s -o "$tmp_dir/trav.bin" -w '%{http_code}' "$BASE/uploads/$trav")"
  if [[ "$out" == "200" ]] && grep -q 'JWT_SECRET' "$tmp_dir/trav.bin" 2>/dev/null; then
    printf '  %sFAIL%s 穿越到 %s 把 .env 读出来了\n' "$RED" "$RESET" "$trav"; fail=$((fail+1))
  else
    printf '  %sPASS%s 穿越 %s 没有泄漏文件（HTTP %s）\n' "$GREEN" "$RESET" "$trav" "$out"; pass=$((pass+1))
  fi
done

out="$(curl -s "$BASE/uploads/uploads/2026/01/00000000000000000000000000000000.png")"
check '#40 文件不存在也走统一信封（不是 gin 的纯文本 404）' '"code":"NOT_FOUND"' "$out"

# ---------------------------------------------------------------- M2 发帖
section "M2 发帖：#13 POST /api/items"

# 第二个用户：判据里「非本人改他人帖得 FORBIDDEN」「别人删这张图得 FORBIDDEN」都要他。
U2="smoke2$(date +%s)$RANDOM"
req POST /api/auth/register "{\"username\":\"$U2\",\"password\":\"$P\"}"
OTHER_ID="$(jval "$BODY" '"data":\{"id":([0-9]+)')"
req POST /api/auth/login "{\"username\":\"$U2\",\"password\":\"$P\"}"
TOKEN2="$(jval "$BODY" '"token":"([^"]{20,})"')"

req GET /api/auth/me '' "$TOKEN"
MY_ID="$(jval "$BODY" '"data":\{"id":([0-9]+)')"

if [[ -z "$TOKEN2" || -z "$MY_ID" || -z "$OTHER_ID" ]]; then
  printf '  %sFAIL%s 第二个冒烟用户没建起来（me.id=%s other.id=%s），FORBIDDEN 那几条测不了\n' \
    "$RED" "$RESET" "$MY_ID" "$OTHER_ID"; fail=$((fail+1))
else
  printf '  %sPASS%s 冒烟用户 %s(id=%s) 和 %s(id=%s)\n' \
    "$GREEN" "$RESET" "$U" "$MY_ID" "$U2" "$OTHER_ID"; pass=$((pass+1))
fi

lost_json="$(printf '{"item_type":"lost","title":"冒烟：黑色长款钱包","description":"在图书馆三楼丢的","category_id":%d,"location_id":%d,"location_detail":"三楼靠窗第二排","last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:30:00+08:00","contact":"13800000000","image_paths":["%s","%s","%s"]}' \
  "$CAT_ID" "$LOC_ID" "$PIC1" "$PIC2" "$PIC3")"
req POST /api/items "$lost_json" "$TOKEN"
check '建 lost（带三张图）返回 HTTP 200' '200'          "$STATUS"
LOST_ID="$(itemIDOf "$BODY")"
check '  data.item.status 是 open'    '"status":"open"' "$BODY"
check '  三张图都挂上了，从 images[0] 开始有序' '"images":[{"id":' "$BODY"
# 请求里写的是 +08:00，回来的必须是同一个时刻的 UTC 写法（§3.1「时间一律存 UTC」）
check '  last_seen_at 转成了 UTC'     '"last_seen_at":"2026-10-01T01:00:00Z"' "$BODY"
check '  lost_at 转成了 UTC'          '"lost_at":"2026-10-01T04:30:00Z"'      "$BODY"
check '  lost 帖没有 found_at'        '"found_at":""'  "$BODY"
check '  自己的帖子看得到 contact'    '"contact":"13800000000"' "$BODY"

found_json="$(printf '{"item_type":"found","title":"冒烟：捡到一个卡包","description":"已经交到前台","category_id":%d,"location_id":%d,"found_at":"2026-10-02T15:00:00+08:00","contact":"问图书馆前台"}' \
  "$CAT_ID" "$LOC_ID")"
req POST /api/items "$found_json" "$TOKEN"
check '建 found 返回 HTTP 200'        '200'          "$STATUS"
FOUND_ID="$(itemIDOf "$BODY")"
check '  found 帖没有 lost_at / last_seen_at' '"lost_at":""' "$BODY"

# ---- 判据点名的那几条拒绝 ----
items_before="$(db 'SELECT count(*) FROM items')"
req POST /api/items '{"item_type":"lost","title":"联系方式是空的","contact":"","category_id":10,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}' "$TOKEN"
check 'contact 为空 → HTTP 400'       '400'                  "$STATUS"
check '  code 是 VALIDATION'          '"code":"VALIDATION"' "$BODY"
check '  错误指向 contact 字段（前端要画红框）' '"field":"contact"' "$BODY"

req POST /api/items '{"item_type":"lost","title":"联系方式是纯空白","contact":"   ","category_id":10,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}' "$TOKEN"
check 'contact 是纯空白 → 同样是 VALIDATION' '"code":"VALIDATION"' "$BODY"
req POST /api/items '{"item_type":"lost","title":"联系方式是全角空格","contact":"　","category_id":10,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}' "$TOKEN"
check 'contact 是全角空格 U+3000 → VALIDATION' '"code":"VALIDATION"' "$BODY"

req POST /api/items '{"item_type":"lost","title":"时间填反了","contact":"13800000000","category_id":10,"location_id":70,"last_seen_at":"2026-10-05T09:00:00+08:00","lost_at":"2026-10-01T09:00:00+08:00"}' "$TOKEN"
check 'last_seen_at 晚于 lost_at → HTTP 400' '400'          "$STATUS"
check '  错误同时指向两个时间字段'    '"field":"last_seen_at"' "$BODY"

req POST /api/items '{"item_type":"found","title":"found 帖填了 last_seen_at","contact":"13800000000","category_id":10,"location_id":70,"found_at":"2026-10-02T15:00:00+08:00","last_seen_at":"2026-10-01T09:00:00+08:00"}' "$TOKEN"
check 'found 帖填 last_seen_at → HTTP 400' '400' "$STATUS"
check '  错误指向 last_seen_at'       '"field":"last_seen_at"' "$BODY"

req POST /api/items '{"item_type":"lost","title":"选了大类","contact":"13800000000","category_id":1,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}' "$TOKEN"
check 'category_id 用一级大类 → HTTP 400' '400' "$STATUS"
check '  错误指向 category_id'        '"field":"category_id"' "$BODY"
req POST /api/items '{"item_type":"lost","title":"选了有子节点的地点","contact":"13800000000","category_id":10,"location_id":9,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}' "$TOKEN"
check 'location_id 用中间层 → HTTP 400' '400'        "$STATUS"

req POST /api/items '{"item_type":"lost","title":"图片路径是编的","contact":"13800000000","category_id":10,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00","image_paths":["../../etc/passwd"]}' "$TOKEN"
check 'image_paths 不是 #6 返回的形状 → HTTP 400' '400' "$STATUS"
check '  错误指向 image_paths[0]'     '"field":"image_paths' "$BODY"

req POST /api/items '{"item_type":"lost","title":"没有登录","contact":"13800000000","category_id":10,"location_id":70,"last_seen_at":"2026-10-01T09:00:00+08:00","lost_at":"2026-10-01T12:00:00+08:00"}'
check '发帖不带 token → HTTP 401'     '401'          "$STATUS"

# 校验失败了却还是建出了帖子 —— 这一条只有直接数库能发现，接口上完全看不出来：
# 一个「先插再校验、校验不过就返回错误但忘了回滚」的实现，
# 上面每一条错误码都是对的，而库里已经堆了一堆不该存在的行。
#
# 用「这一段的 before/after 相等」而不是「按标题数某几条」：标题是中文，
# 而 psql 的 -c 参数同样会踩 Git Bash 的代码页转换（变成 ???），
# 那样这条检查会永远匹配到 0 行、永远假绿。数总数不需要任何字符串参数。
if [[ "$HAS_PSQL" == 1 ]]; then
  items_after="$(db 'SELECT count(*) FROM items')"
  if [[ "$items_before" == "$items_after" ]]; then
    printf '  %sPASS%s 上面 %s 条被拒的帖子一条都没进数据库（items 仍是 %s 行）\n' \
      "$GREEN" "$RESET" 9 "$items_before"; pass=$((pass+1))
  else
    printf '  %sFAIL%s 校验失败了却还是建出了帖子：items 从 %s 行变成 %s 行\n' \
      "$RED" "$RESET" "$items_before" "$items_after"; fail=$((fail+1))
  fi
else
  skip '被拒的帖子一条都没进数据库（没有 psql，无法直接数库）'
fi

# ⚠ 这两条是「不校验内容」这条契约的正面证据，缺了上面三条毫无意义：
#    一个「把所有 contact 都拒掉」的实现能让上面全绿。
#
# 刻意放在数库那一段**之后**：它们是真的会建出帖子来的，混在计数窗口里
# 会让上面那条 before/after 白白红一次。契约测试里「成功」和「被拒」两组
# 用例共用一个计数断言时，必须把它们隔开。
req POST /api/items '{"item_type":"found","title":"联系方式写无","contact":"无","category_id":10,"location_id":70,"found_at":"2026-10-02T15:00:00+08:00"}' "$TOKEN"
check 'contact 填「无」→ HTTP 200（平台不校验内容）' '200'          "$STATUS"
check '  code 是 OK'                  '"code":"OK"' "$BODY"
req POST /api/items '{"item_type":"found","title":"联系方式写问宿舍阿姨","contact":"问宿舍阿姨","category_id":10,"location_id":70,"found_at":"2026-10-02T15:00:00+08:00"}' "$TOKEN"
check 'contact 填「问宿舍阿姨」→ HTTP 200' '200'          "$STATUS"

# ---------------------------------------------------------------- M2 列表
section "M2 列表：#14 /api/items（公开）、#19 /api/my/items（JWT）"

req GET /api/items
check '#14 匿名返回 HTTP 200'         '200'          "$STATUS"
check '  分页形状是 {list,total,page,page_size}' '"page_size":20' "$BODY"
check '  摘要里是平铺的 category_name 而不是嵌套对象' '"category_name":"手机"' "$BODY"
# 「默认只看 open」用反面来验：结果里不该出现任何 deleted 的行。
# 正面那句（"status":"open" 出现了）证明不了这件事 —— 一条 open 和一堆 deleted 可以共存。
if [[ "$BODY" == *'"status":"deleted"'* ]]; then
  printf '  %sFAIL%s 广场默认结果里出现了 deleted 的帖子\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 默认结果里没有 deleted（软删的帖子对广场来说就是不存在）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# keyword=冒烟 → %E5%86%92%E7%83%9F（见上面 req 的注释：URL 里的中文会被代码页转换弄坏）
req GET '/api/items?keyword=%E5%86%92%E7%83%9F'
if [[ "$BODY" == *"冒烟"* ]]; then
  printf '  %sPASS%s keyword 命中标题\n' "$GREEN" "$RESET"; pass=$((pass+1))
else
  printf '  %sFAIL%s keyword=冒烟 什么都没搜到（本轮的帖子呢？）\n' "$RED" "$RESET"; fail=$((fail+1))
fi
# keyword=冒烟根本不存在
req GET '/api/items?keyword=%E5%86%92%E7%83%9F%E6%A0%B9%E6%9C%AC%E4%B8%8D%E5%AD%98%E5%9C%A8'
check 'keyword 不命中时 list 是 [] 而不是 null' '"list":[]' "$BODY"
check '  且 total 是 0'               '"total":0'    "$BODY"

req GET "/api/items?item_type=found&category_id=$CAT_ID"
check 'item_type + category_id 两个筛选同时用返回 HTTP 200' '200' "$STATUS"
req GET '/api/items?sort=lost_at'
check 'sort=lost_at 返回 HTTP 200'    '200'          "$STATUS"
req GET '/api/items?page=2&page_size=5'
check '分页参数返回 HTTP 200'         '200'          "$STATUS"
check '  回显 page/page_size'         '"page":2,"page_size":5' "$BODY"

req GET '/api/items?status=deleted'
check '#14 不许请求 deleted → HTTP 400' '400'        "$STATUS"
check '  错误指向 status'             '"field":"status"' "$BODY"
req GET '/api/items?page=0'
check 'page=0 → HTTP 400'             '400'          "$STATUS"
req GET '/api/items?page_size=101'
check 'page_size 超上限 → HTTP 400'   '400'          "$STATUS"
req GET '/api/items?sort=id'
check 'sort 不在白名单里 → HTTP 400（不是 500）' '400' "$STATUS"
# 编码过的分号/空格。裸分号会被 url.ParseQuery 整个拒掉，导致 sort 变成空串、
# 请求反而**成功**，那样的话这条检查就成了假绿；裸空格则连请求都发不出去。
req GET '/api/items?sort=created_at%3BDROP%20TABLE%20items'
check 'sort 里塞 SQL → HTTP 400 而不是 500' '400'    "$STATUS"
if [[ "$HAS_PSQL" == 1 ]]; then
  check '  items 表还在（注入没生效）' '1' "$(db 'SELECT (count(*)>0)::int FROM items')"
else
  skip '  items 表还在（没有 psql）'
fi

req GET /api/my/items
check '#19 不带 token → HTTP 401'     '401'          "$STATUS"
req GET /api/my/items '' "$TOKEN"
check '#19 带 token 返回 HTTP 200'    '200'          "$STATUS"
check '  自己的帖子一律带 contact（都是自己的）' '"contact":"13800000000"' "$BODY"
req GET '/api/my/items?status=deleted' '' "$TOKEN"
check '#19 允许显式查 deleted → HTTP 200（和 #14 相反）' '200' "$STATUS"
# 越权：把别人的 id 当查询参数塞进来。#19 的 user_id 来自 JWT，不该读这个参数。
# 匹配时补一个逗号：author_id 后面紧跟 author_name，少了定界符的话
# id=1 会匹配到 id=12 的帖子，那条检查就会因为「另一个人的 id 恰好以我的 id 开头」而假红。
if [[ -n "$MY_ID" ]]; then
  req GET "/api/my/items?user_id=$MY_ID" '' "$TOKEN2"
  # 先确认这个请求真的是「B 带着 token 发的」。少了这一步，一个 401 的空响应
  # 会让下面那条「没读到你的帖子」因为什么都没匹配到而假绿 —— 那是最坏的一种绿。
  if [[ "$STATUS" != "200" ]]; then
    printf '  %sFAIL%s ?user_id= 那条探测没带着 B 的 token 发出去（HTTP %s），判据没法成立\n' \
      "$RED" "$RESET" "$STATUS"; fail=$((fail+1))
  elif [[ "$BODY" == *"\"author_id\":$MY_ID,"* ]]; then
    printf '  %sFAIL%s ?user_id= 让别人的 token 读到了你的帖子（联系方式一起过去了）\n' "$RED" "$RESET"; fail=$((fail+1))
  else
    printf '  %sPASS%s ?user_id= 被忽略，#19 只认 JWT 里的那个人\n' "$GREEN" "$RESET"; pass=$((pass+1))
  fi
fi

# ---------------------------------------------------------------- M2 详情
section "M2 详情：#15 /api/items/:id（公开 + OptionalJWT）"

req GET "/api/items/$LOST_ID"
check '#15 匿名看 lost 帖返回 HTTP 200' '200'          "$STATUS"
check '  lost 帖的 contact 是公开的'  '"contact":"13800000000"' "$BODY"
check '  contact_locked 是 false'     '"contact_locked":false' "$BODY"

req GET "/api/items/$FOUND_ID"
check '  匿名看 found 帖 → contact 是 null' '"contact":null' "$BODY"
check '  contact_locked 是 true'      '"contact_locked":true' "$BODY"
if [[ "$BODY" == *问图书馆前台* ]]; then
  printf '  %sFAIL%s 锁着的联系方式还是出现在响应里了\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 锁着的联系方式在整个响应体里都不存在（不是靠前端隐藏）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

req GET "/api/items/$FOUND_ID" '' "$TOKEN"
check '  作者本人看自己的 found 帖 → contact 可见' '"contact":"问图书馆前台"' "$BODY"
req GET "/api/items/$FOUND_ID" '' "$TOKEN2"
check '  别人看 → 仍然锁着'           '"contact_locked":true' "$BODY"
req GET "/api/items/$FOUND_ID" '' "not-a-real-token"
check '  无效 token 当匿名处理，不报错（公开接口不该因身份问题拒绝服务）' '200' "$STATUS"

req GET '/api/items/999999999'
check '  不存在的 id → HTTP 404'      '404'                  "$STATUS"
check '  code 是 NOT_FOUND'           '"code":"NOT_FOUND"' "$BODY"
req GET '/api/items/abc'
check '  id 不是数字 → 404 而不是 500' '404'        "$STATUS"

# 摘要里不该有 description：列表接口只回标题，这是刻意的带宽和职责划分
req GET '/api/items?keyword=%E5%86%92%E7%83%9F'
if [[ "$BODY" == *'"description"'* ]]; then
  printf '  %sFAIL%s 广场摘要里出现了 description\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 广场摘要里没有 description（详情页才有）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# ---------------------------------------------------------------- M2 改·删·关帖
section "M2 改删：#16 PUT、#17 DELETE、#18 PATCH status"

req PUT "/api/items/$LOST_ID" "{\"item_type\":\"lost\",\"title\":\"被别人改过的标题\",\"contact\":\"13900000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"last_seen_at\":\"2026-10-01T09:00:00+08:00\",\"lost_at\":\"2026-10-01T12:00:00+08:00\"}" "$TOKEN2"
check '非本人改帖 → HTTP 403'         '403'                  "$STATUS"
check '  code 是 FORBIDDEN'           '"code":"FORBIDDEN"' "$BODY"
req GET "/api/items/$LOST_ID"
check '  帖子内容没被改动'            '"title":"冒烟：黑色长款钱包"' "$BODY"

# 改帖**不能**改类型，也不能改作者。请求体里塞了 item_type/user_id 也只会被忽略。
req PUT "/api/items/$LOST_ID" "{\"item_type\":\"found\",\"user_id\":$MY_ID,\"title\":\"冒烟：黑色长款钱包（改过）\",\"contact\":\"13900000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"last_seen_at\":\"2026-10-01T09:00:00+08:00\",\"lost_at\":\"2026-10-01T12:00:00+08:00\"}" "$TOKEN"
check '本人改帖 → HTTP 200'           '200'          "$STATUS"
check '  标题改过来了'                '冒烟：黑色长款钱包（改过）' "$BODY"
check '  item_type 没被改成 found'    '"item_type":"lost"' "$BODY"
check_re '  作者没被改成请求里那个人' '"author":\{"id":'"$MY_ID"',"' "$BODY"

# 判据点名：ITEM_CLOSED 只挡 deleted，closed 的帖子必须还能改
req PATCH "/api/items/$LOST_ID/status" '{"status":"closed"}' "$TOKEN"
check '#18 关帖返回 HTTP 200'         '200'          "$STATUS"
check '  data.status 是 closed'       '"status":"closed"' "$BODY"
req PUT "/api/items/$LOST_ID" "{\"item_type\":\"lost\",\"title\":\"冒烟：已经还回来了\",\"contact\":\"13900000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"last_seen_at\":\"2026-10-01T09:00:00+08:00\",\"lost_at\":\"2026-10-01T12:00:00+08:00\"}" "$TOKEN"
check '改一条 closed 的帖子 → HTTP 200（ITEM_CLOSED 只挡 deleted）' '200' "$STATUS"
check '  改帖不会顺带把状态开回去'    '"status":"closed"' "$BODY"

req PATCH "/api/items/$LOST_ID/status" '{"status":"deleted"}' "$TOKEN"
check '#18 不许把帖子改成 deleted → HTTP 400' '400' "$STATUS"
req PATCH "/api/items/$FOUND_ID/status" '{"status":"closed"}' "$TOKEN2"
check '非本人关帖 → HTTP 403'         '403'                  "$STATUS"
req PATCH "/api/items/$FOUND_ID/status" '{"status":"closed"}'
check '  不带 token → HTTP 401'       '401'                  "$STATUS"

# ---------------------------------------------------------------- M2 删图
section "M2 帖主自删单张图片：#42 DELETE /api/item-images/:id"

IMG1_ID=''; IMG2_ID=''; IMG3_ID=''
if [[ -n "$LOST_ID" ]]; then
  req GET "/api/items/$LOST_ID" '' "$TOKEN"
  # 把 images 数组整段切出来再逐个抠 id。
  # 不用 jval 抠第二个：`.*` 是最长匹配，一次只能拿到**最后一个**，
  # 而这里要的是「按顺序的第 1 / 2 / 3 个」，所以先把数组边界定住（[^]]* 到第一个 ] 为止）。
  imgs="$(printf '%s' "$BODY" | grep -oE '"images":\[[^]]*\]' | grep -oE '"id":[0-9]+' | grep -oE '[0-9]+')"
  IMG1_ID="$(printf '%s\n' "$imgs" | sed -n 1p)"
  IMG2_ID="$(printf '%s\n' "$imgs" | sed -n 2p)"
  IMG3_ID="$(printf '%s\n' "$imgs" | sed -n 3p)"
fi
if [[ -z "$IMG1_ID" || -z "$IMG2_ID" || -z "$IMG3_ID" ]]; then
  printf '  %sFAIL%s 没能从 #15 的响应里取出三张图的 id（%s / %s / %s），#42 测不了\n' \
    "$RED" "$RESET" "$IMG1_ID" "$IMG2_ID" "$IMG3_ID"; fail=$((fail+1))
else
  # 别人和 admin 都不能删 —— 先把拒绝路径验完，此时三张图都还在。
  # ⚠ admin 也不行：#42 的权限列写的是「仅帖主本人」，admin 删图是 #45（M6）。
  #   分成两个端点不是为了麻烦，是因为这两件事的**含义**不同：
  #   帖主删图是「我不想让这张照片挂在这儿」，admin 删图是一次治理动作，要填理由、要落 admin_actions。
  req DELETE "/api/item-images/$IMG1_ID" '' "$TOKEN2"
  check '别人删帖主的图 → HTTP 403'   '403'                  "$STATUS"
  req DELETE "/api/item-images/$IMG1_ID"
  check '  不带 token → HTTP 401'     '401'                  "$STATUS"
  [[ -f "$UPLOAD_ABS/$PIC1" ]] && \
    { printf '  %sPASS%s FORBIDDEN 是真的没删：文件还在\n' "$GREEN" "$RESET"; pass=$((pass+1)); } || \
    { printf '  %sFAIL%s 报了 FORBIDDEN 却把文件删了\n' "$RED" "$RESET"; fail=$((fail+1)); }

  # ---- 判据正文：删中间那张，留下前后两张 ----
  # 留一张在前、一张在后，才能同时验两件事：
  #   ① 「另一张没被牵连」（前一张还在）
  #   ② 封面是 sort_order 最小的那张，删掉它之后封面会跟着换（#14 的 LEFT JOIN LATERAL 现算）
  req DELETE "/api/item-images/$IMG2_ID" '' "$TOKEN"
  check '帖主删自己帖子里的一张图 → HTTP 200' '200'  "$STATUS"
  [[ -f "$UPLOAD_ABS/$PIC2" ]] && \
    { printf '  %sFAIL%s 磁盘文件 %s 还在，没被删\n' "$RED" "$RESET" "$PIC2"; fail=$((fail+1)); } || \
    { printf '  %sPASS%s 磁盘文件消失了\n' "$GREEN" "$RESET"; pass=$((pass+1)); }
  [[ -f "$UPLOAD_ABS/$PIC1" && -f "$UPLOAD_ABS/$PIC3" ]] && \
    { printf '  %sPASS%s 同一帖子里另外两张图的文件没被牵连\n' "$GREEN" "$RESET"; pass=$((pass+1)); } || \
    { printf '  %sFAIL%s 别的图的文件被连带删掉了\n' "$RED" "$RESET"; fail=$((fail+1)); }

  req GET "/api/items/$LOST_ID" '' "$TOKEN"
  check '  帖子本身还在'              '"item_type":"lost"' "$BODY"
  check_re '  只剩两张图'             '"images":\[\{"id":'"$IMG1_ID"'[^}]*\},\{"id":'"$IMG3_ID"'[^}]*\}\]' "$BODY"

  # 广场上的封面自动变成留下来的第一张：#14 用
  # LEFT JOIN LATERAL ... ORDER BY sort_order LIMIT 1 现算封面，
  # 所以这里不需要任何「重算封面」的代码 —— 测的就是那个 JOIN 本身。
  #
  # 必须带 status=closed：上面「改删」那一节把这条帖子关掉了，而 #14 默认只看 open。
  # 少了这个参数，帖子根本不出现在结果里，封面断言就会假红 ——
  # 而且红得像是「封面没跟着换」，指向一个完全不存在的问题。
  req GET '/api/items?status=closed&keyword=%E5%86%92%E7%83%9F'
  if [[ "$BODY" == *"\"id\":$LOST_ID,"* ]]; then
    if [[ "$BODY" == *"/uploads/$PIC1\""* ]]; then
      printf '  %sPASS%s #14 的封面跟着变成了留下来的那张\n' "$GREEN" "$RESET"; pass=$((pass+1))
    else
      printf '  %sFAIL%s 帖子在广场上是这条：\n       %s期望它的封面是: "/uploads/%s"%s\n       %s实际: %s%s\n' \
        "$RED" "$RESET" "$DIM" "$PIC1" "$RESET" "$DIM" "$(printf '%.300s' "$BODY")" "$RESET"; fail=$((fail+1))
    fi
  else
    printf '  %sFAIL%s 这条 closed 的帖子没出现在 status=closed 的结果里，封面没法验\n       %s实际: %s%s\n' \
      "$RED" "$RESET" "$DIM" "$(printf '%.300s' "$BODY")" "$RESET"; fail=$((fail+1))
  fi

  # ---- 重复删除不是幂等成功 ----
  req DELETE "/api/item-images/$IMG1_ID" '' "$TOKEN"
  check '帖主删第一张 → HTTP 200'     '200'          "$STATUS"
  req DELETE "/api/item-images/$IMG1_ID" '' "$TOKEN"
  check '  再删一次同一张 → HTTP 404（不是幂等的 200）' '404' "$STATUS"
fi

# ---------------------------------------------------------------- M2 软删
section "M2 删帖：#17 DELETE /api/items/:id（软删）"

req DELETE "/api/items/$FOUND_ID" '' "$TOKEN"
check '删自己的帖子 → HTTP 200'       '200'          "$STATUS"
req GET "/api/items/$FOUND_ID"
check '  别人/匿名都 404'             '"code":"NOT_FOUND"' "$BODY"
req GET '/api/my/items?status=deleted' '' "$TOKEN"
check_re '  本人在 #19 里还看得见（否则他会以为帖子凭空消失了）' \
  '"id":'"$FOUND_ID"',"' "$BODY"
if [[ "$HAS_PSQL" == 1 ]]; then
  check '  行还在（软删不是物理删除）' '1' "$(db "SELECT (count(*)=1)::int FROM items WHERE id=$FOUND_ID")"
  check '  status 是 deleted'         'deleted' "$(db "SELECT status FROM items WHERE id=$FOUND_ID")"
else
  skip '  行还在 / status 是 deleted（没有 psql，查不到库里的行）'
fi

# 软删之后帖主自己也改不动了 —— 这一条不需要 psql，接口上就能验
req PUT "/api/items/$FOUND_ID" "{\"item_type\":\"found\",\"title\":\"删了还能改？\",\"contact\":\"13800000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"found_at\":\"2026-10-02T15:00:00+08:00\"}" "$TOKEN"
check '  删过的帖子改不了 → HTTP 409' '409'                 "$STATUS"
check '    code 是 ITEM_CLOSED'       '"code":"ITEM_CLOSED"' "$BODY"

# ---------------------------------------------------------------- M2 admin 通道
section "M2 管理员边界：admin 能改别人的帖，但必须给理由"
if [[ "$HAS_PSQL" == 1 ]]; then
  db "UPDATE users SET role='admin', updated_at=now() WHERE username='$U2'" >/dev/null
  req POST /api/auth/login "{\"username\":\"$U2\",\"password\":\"$P\"}"
  ADMIN_TOKEN="$(jval "$BODY" '"token":"([^"]{20,})"')"

  req PUT "/api/items/$LOST_ID" "{\"item_type\":\"lost\",\"title\":\"管理员随手改的\",\"contact\":\"13800000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"last_seen_at\":\"2026-10-01T09:00:00+08:00\",\"lost_at\":\"2026-10-01T12:00:00+08:00\"}" "$ADMIN_TOKEN"
  check 'admin 改别人的帖不带理由 → HTTP 400' '400' "$STATUS"
  check '  错误指向 admin_reason'     '"field":"admin_reason"' "$BODY"

  req PUT "/api/items/$LOST_ID" "{\"item_type\":\"lost\",\"title\":\"管理员下架的违规帖\",\"contact\":\"13800000000\",\"category_id\":$CAT_ID,\"location_id\":$LOC_ID,\"last_seen_at\":\"2026-10-01T09:00:00+08:00\",\"lost_at\":\"2026-10-01T12:00:00+08:00\",\"admin_reason\":\"冒烟脚本：验一下 admin 通道\"}" "$ADMIN_TOKEN"
  check '  带上理由 → HTTP 200'       '200'          "$STATUS"
  check_re '  作者没被改动（admin 改的是内容，不是归属）' '"author":\{"id":'"$MY_ID"',"' "$BODY"

  # #42 的权限是「仅帖主本人」，admin 也不例外 —— 删图对 admin 是一次治理动作，要走 #45
  req GET "/api/items/$LOST_ID" '' "$ADMIN_TOKEN"
  admin_img="$(printf '%s' "$BODY" | grep -oE '"images":\[[^]]*\]' | grep -oE '"id":[0-9]+' | grep -oE '[0-9]+' | sed -n 1p)"
  if [[ -n "$admin_img" ]]; then
    req DELETE "/api/item-images/$admin_img" '' "$ADMIN_TOKEN"
    check 'admin 删别人的图 → HTTP 403（那是 #45，不是 #42）' '403' "$STATUS"
  fi

  db "UPDATE users SET role='user', updated_at=now() WHERE username='$U2'" >/dev/null
else
  skip 'admin 通道全套（没有 psql，无法把用户提成 admin）'
fi

# ---------------------------------------------------------------- M3 匹配
section "M3 匹配：#13 发帖时触发 + #20 查询（§12 判据①–⑤）"

# 这一节测的是「发帖之后系统在背后做了什么」，而那些事有一大半在 HTTP 响应里看不见。
# 所以每条判据都是「响应 + 直接数库」两半 —— 这正是 §10 第③层相对第②层的唯一增量。
#
# ⚠ 计数一律用 before/after 的**增量**，不写绝对值：这个脚本打的是开发库，
#   里面有上一轮、上上一轮留下的帖子。而「恰好 1 行」那种判据只有在干净库上才成立
#   （backend/smoketest/m3_match_test.go 里 TruncateAll 之后钉的就是恰好 1）。
#   本轮编号也因此进了标题和描述 —— 让上一轮的帖子尽量别也跨过 0.75 的通知线，
#   否则 notified_count 一轮比一轮大，日志里就看不出这次到底匹配上了什么。
#
# 但有三条判据是**精确**的，和库里有没有残留无关，所以下面直接按字面断言：
#   ④ lost 帖创建一行都不写；⑤ 地点「其他」的帖一行都不写；#20 查询本身一行都不写。
M3_TAG="m3$(date +%s)$RANDOM"
CAT_WALLET=36   # 衣物箱包 → 钱包，和 LOC_ID=70（图书馆）配成「同一个东西」的那一对
LOC_OTHER=3     # 「其他」：level 1 叶子、is_freeform=true、parent_id NULL —— Tier 1 的前提不成立

# 三个时刻都相对 now（UTC），这样「found_at 落在丢失窗口里 → S_time=1.0」
# 是这条链自己保证的，不依赖跑脚本的那一天：
#   last_seen 3 小时前 → found 90 分钟前 → lost_at 2 小时前
# 注意顺序：lost_at 必须**晚于** last_seen_at（M2 那条时间校验会拒反的），
# 而 found_at 夹在中间，才是 §5.3 说的「在你意识到丢之前就被捡到了」。
T_SEEN="$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ)"
T_LOST="$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ)"
T_FOUND="$(date -u -d '-90 minutes' +%Y-%m-%dT%H:%M:%SZ)"

pairs_before="$(db 'SELECT count(*) FROM match_pairs')"
notif_me_before="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")"
notif_other_before="$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")"

# ---- 判据④：建 lost 帖只算不写 ----
lost_m3="$(printf '{"item_type":"lost","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","last_seen_at":"%s","lost_at":"%s","contact":"13800000000"}' \
  "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_SEEN" "$T_LOST")"
req POST /api/items "$lost_m3" "$TOKEN"
check '④ 建 lost（钱包@图书馆）返回 HTTP 200' '200' "$STATUS"
M3_LOST_ID="$(itemIDOf "$BODY")"
check '  ④ 响应里有 matches_preview 键（空命中也必须是 []，不能整个消失）' '"matches_preview":[' "$BODY"
if [[ "$BODY" == *'"notified_count"'* ]]; then
  printf '  %sFAIL%s lost 帖的响应里出现了 notified_count —— §4：这两个键按 item_type 互斥\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s lost 帖的响应里没有 notified_count（lost 方向谁都不通知）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# ---- 判据②：建 found 帖才写台账、才发通知，而且只给 lost 作者发 ----
found_m3="$(printf '{"item_type":"found","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","found_at":"%s","contact":"wx_smoke_finder"}' \
  "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND")"
req POST /api/items "$found_m3" "$TOKEN2"
check '② 建 found（同分类同地点、时间在窗口内）返回 HTTP 200' '200' "$STATUS"
M3_FOUND_ID="$(itemIDOf "$BODY")"
check_re '  ② data.notified_count 出现了（哪怕是 0 也必须出现，那是去重的证据）' \
  '"notified_count":[0-9]+' "$BODY"
if [[ "$BODY" == *'"matches_preview"'* ]]; then
  printf '  %sFAIL%s found 帖的响应里出现了 matches_preview —— §2.3「平台不会通知 found 任何东西」\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s found 帖的响应里没有 matches_preview\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# ---- 判据①：#20 的 tier 1 形状（三个信号、权重之和 1.0、没有 attr、没有 location）----
req GET "/api/items/$M3_LOST_ID/matches" '' "$TOKEN"
check '① 本人查匹配返回 HTTP 200'   '200'          "$STATUS"
check '  code 是 OK'                '"code":"OK"' "$BODY"
check "  ① 本轮那条 found 帖出现在列表里（id=$M3_FOUND_ID）" "\"id\":$M3_FOUND_ID," "$BODY"
check '  ① tier 是 1（同地点 + 时间在窗口内，严格模式的前提成立）' '"tier":1' "$BODY"
check '  ① 每个信号都带 weight 和 score（前端要按它渲染分解表）' '"category":{"weight":' "$BODY"
if [[ "$BODY" == *'"attr"'* ]]; then
  printf '  %sFAIL%s breakdown 里有 attr —— S_attr 已经随 color/brand 两列一起删掉了（§5.4）\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s breakdown 里没有 attr 信号\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi
# Tier 1 只有三个信号：地点是**硬筛选条件**而不是打分项，所以那个键必须整个不存在。
# 「存在但 weight 为 0」是另一种实现，它会让 breakdown 的加权和对不上总分。
if [[ "$BODY" == *'"location"'* ]]; then
  printf '  %sFAIL%s Tier 1 的 breakdown 里有 location 信号\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s Tier 1 的 breakdown 里没有 location 信号（0.45/0.40/0.15 三条加起来正好 1.0）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi
if [[ "$BODY" == *'"notice"'* ]]; then
  printf '  %sFAIL%s Tier 1 带了放宽筛选的横幅文案（那是 Tier 2 才该出现的东西）\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s Tier 1 没有横幅文案\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi
# 匹配列表里 found 候选的联系方式必须是锁着的 —— 它不能成为 M4 #21 的旁路。
if [[ "$BODY" == *wx_smoke_finder* ]]; then
  printf '  %sFAIL%s 匹配列表里出现了 found 帖的 contact（wx_smoke_finder）—— 认领名单会因此不再完整\n' "$RED" "$RESET"; fail=$((fail+1))
else
  printf '  %sPASS%s 匹配列表里没有 found 帖的 contact（和 #14 同一条规则）\n' "$GREEN" "$RESET"; pass=$((pass+1))
fi

# ---- #20 鉴权与参数 ----
req GET "/api/items/$M3_LOST_ID/matches"
check '#20 不带 token → HTTP 401'   '401'                  "$STATUS"
check '  code 是 UNAUTHORIZED'      '"code":"UNAUTHORIZED"' "$BODY"
req GET "/api/items/$M3_LOST_ID/matches" '' "$TOKEN2"
check '  别人的帖子 → HTTP 403（§4：本人或 Admin）' '403' "$STATUS"
check '  code 是 FORBIDDEN'         '"code":"FORBIDDEN"' "$BODY"
# 三个查询参数都在 handler 里原样收下、在 service 里解析，所以非法值必须变成
# 带字段名的 VALIDATION，而不是「静默用默认值」—— 后者会让用户看到的列表和 URL 不一致。
req GET "/api/items/$M3_LOST_ID/matches?tier=3" '' "$TOKEN"
check '  tier=3 → HTTP 400'         '400'                  "$STATUS"
check '    错误指向 tier'           '"field":"tier"' "$BODY"
req GET "/api/items/$M3_LOST_ID/matches?top=0" '' "$TOKEN"
check '  top=0 → HTTP 400（不是悄悄变成 10）' '400' "$STATUS"
req GET "/api/items/$M3_LOST_ID/matches?min_score=1.5" '' "$TOKEN"
check '  min_score=1.5 → HTTP 400'  '400'                  "$STATUS"

# ---- 判据⑤：地点选「其他」→ Tier 2，四个信号 + 横幅，而且照样一行都不写 ----
freeform_m3="$(printf '{"item_type":"lost","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"图书馆三楼","last_seen_at":"%s","lost_at":"%s","contact":"13900000000"}' \
  "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_OTHER" "$T_SEEN" "$T_LOST")"
pairs_before_t2="$(db 'SELECT count(*) FROM match_pairs')"
req POST /api/items "$freeform_m3" "$TOKEN"
check '⑤ 建 lost（地点：其他）返回 HTTP 200' '200' "$STATUS"
M3_T2_ID="$(itemIDOf "$BODY")"
# 这条是**精确**的：#13 只跑 Tier 1，而 Tier 1 的前提在这里不成立（没有叶子可比），
# 所以预览一定是空数组 —— 库里有没有别的帖子都改不了这个结论。
check '  ⑤ 发帖时的预览是 []（#13 只做 Tier 1，绝不偷偷放宽）' '"matches_preview":[]' "$BODY"

req GET "/api/items/$M3_T2_ID/matches" '' "$TOKEN"
check '  ⑤ 查匹配时 auto 降到 Tier 2 → HTTP 200' '200' "$STATUS"
check '  ⑤ tier 是 2'               '"tier":2'     "$BODY"
check '  ⑤ 带提示文案（前端靠它显示黄色横幅）' '"notice":"' "$BODY"
check '  ⑤ 四个信号：多出 location 那一档' '"location":{"weight":' "$BODY"
check '  ⑤ 放宽了地点之后确实捞到了那条图书馆的拾物帖' "\"id\":$M3_FOUND_ID," "$BODY"
# 显式要 Tier 1 时**不**偷偷放宽：给空列表才是诚实的答案。
req GET "/api/items/$M3_T2_ID/matches?tier=1" '' "$TOKEN"
check '  ⑤ 显式 tier=1 → 仍然是 1 档、list 为空' '"tier":1,"list":[]' "$BODY"

# ---- 三处「一行都不写」，只能直接数库 ----
# ④ lost 帖创建、⑤ Tier 2 的结果、#20 查询本身。
# 判据③说的「重复不产生第二行」在这里的可执行形式就是最后这一条：
# 用户反复刷新详情页不该往台账里灌数据（§3.7）。
if [[ "$HAS_PSQL" != 1 ]]; then
  skip '台账/通知的增量（本机找不到 psql，或连不上开发库）'
else
  pairs_now="$(db 'SELECT count(*) FROM match_pairs')"
  notif_me="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")"
  notif_other="$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")"

  pairs_delta=$((pairs_now - pairs_before))
  if [[ "$pairs_delta" -ge 1 ]]; then
    printf '  %sPASS%s ② match_pairs 新增了 %d 行（found 帖创建这条路径是唯一会写的）\n' \
      "$GREEN" "$RESET" "$pairs_delta"; pass=$((pass+1))
  else
    printf '  %sFAIL%s ② 建了 matched 的 found 帖，match_pairs 却一行都没加（%s → %s）\n' \
      "$RED" "$RESET" "$pairs_before" "$pairs_now"; fail=$((fail+1))
  fi
  if [[ $((notif_me - notif_me_before)) -ge 1 ]]; then
    printf '  %sPASS%s ② lost 作者（我）收到 %d 条 new_match\n' \
      "$GREEN" "$RESET" $((notif_me - notif_me_before)); pass=$((pass+1))
  else
    printf '  %sFAIL%s ② lost 作者一条通知都没收到 —— 整个 M3 的存在理由就是这一条\n' "$RED" "$RESET"; fail=$((fail+1))
  fi
  # 这条是**精确**的：found 作者永远不该因为匹配被通知，和残留数据无关。
  if [[ "$notif_other" == "$notif_other_before" ]]; then
    printf '  %sPASS%s ② found 作者的通知数没变（§2.3：平台不会通知 found 任何东西）\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s found 作者被通知了：从 %s 条变成 %s 条\n' \
      "$RED" "$RESET" "$notif_other_before" "$notif_other"; fail=$((fail+1))
  fi

  # ⑤ 之后仍然不写：Tier 2 的结果一律不进台账（§3.7）
  if [[ "$(db 'SELECT count(*) FROM match_pairs')" == "$pairs_before_t2" ]]; then
    printf '  %sPASS%s ⑤ 地点「其他」的帖（Tier 2）一行都没写台账\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s Tier 2 的结果被写进了台账\n' "$RED" "$RESET"; fail=$((fail+1))
  fi

  # #20 查询本身：再读两次，台账和通知都必须纹丝不动
  read_only_before="$(db 'SELECT count(*) FROM match_pairs')"
  req GET "/api/items/$M3_LOST_ID/matches" '' "$TOKEN"
  req GET "/api/items/$M3_LOST_ID/matches?tier=2" '' "$TOKEN"
  if [[ "$(db 'SELECT count(*) FROM match_pairs')" == "$read_only_before" ]]; then
    printf '  %sPASS%s ③ 刷了两次 #20，match_pairs 仍是 %s 行（查询接口只读）\n' \
      "$GREEN" "$RESET" "$read_only_before"; pass=$((pass+1))
  else
    printf '  %sFAIL%s 查询接口往台账里灌了数据：%s → %s\n' \
      "$RED" "$RESET" "$read_only_before" "$(db 'SELECT count(*) FROM match_pairs')"; fail=$((fail+1))
  fi

  # 落库的那一行确实带了 breakdown（JSONB 列），这是 §5.7「调试器」的数据源。
  # 数一下本轮这一对有没有行，而不是数某一行——中文标题不能当 psql 参数（代码页转换）。
  if [[ -n "$M3_FOUND_ID" ]]; then
    check '  台账里能按 found_item_id 查到本轮那一对' '1' \
      "$(db "SELECT (count(*)>0)::int FROM match_pairs WHERE found_item_id=$M3_FOUND_ID")"
  fi
fi

# ---- 判据⑥（2026-10-07 补）：改帖重新触发匹配，同一对第二次插入不去重就重复打扰 ----
#
# 计划里判据③写的是「重复建同样的 found 帖 → ON CONFLICT 生效」，但走 HTTP 再发一次帖
# 拿到的是**新的 item id**，台账的键是 (lost_item_id, found_item_id)，永远不构成冲突。
# 真正会让同一对第二次参与匹配的动作是**改帖**（§3.7 用途① 举的正是这个例子），
# 所以 service 里补了 Match.OnUpdated，§9 的 trigger 多一个值 found_updated。
#
# 这条链同时补了一个功能洞：小王随手发「钱包」、后来改成「黑色长款钱包」，
# 以前系统不会重算，小李永远等不到通知 —— 现在会。
lost6="$(printf '{"item_type":"lost","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","last_seen_at":"%s","lost_at":"%s","contact":"13800000000"}' \
  "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_SEEN" "$T_LOST")"
req POST /api/items "$lost6" "$TOKEN"
check '⑥ 再建一条同款 lost 返回 HTTP 200' '200' "$STATUS"
M3_6_LOST_ID="$(itemIDOf "$BODY")"

# 弱文本：标题只有「钱包」、描述留空 → 分数落在通知线以下，发帖时一行都不该写。
found6="$(printf '{"item_type":"found","title":"钱包","description":"","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","found_at":"%s","contact":"wx_smoke_finder6"}' \
  "$CAT_WALLET" "$LOC_ID" "$T_FOUND")"
req POST /api/items "$found6" "$TOKEN2"
check '  ⑥ 弱文本 found 帖返回 HTTP 200' '200' "$STATUS"
M3_6_FOUND_ID="$(itemIDOf "$BODY")"

if [[ "$HAS_PSQL" != 1 ]]; then
  skip '⑥ 改帖重匹配 + 第二次不重复通知（本机没有 psql 或连不上开发库）'
elif [[ -z "$M3_6_FOUND_ID" || -z "$M3_6_LOST_ID" ]]; then
  skip '⑥ 改帖重匹配（没能取出这一轮的帖子 id）'
else
  rows6_before="$(db "SELECT count(*) FROM match_pairs WHERE found_item_id=$M3_6_FOUND_ID")"
  if [[ "$rows6_before" == "0" ]]; then
    printf '  %sPASS%s ⑥ 弱文本（分数不到 0.75）发帖时一行台账都没写\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s ⑥ 弱文本却写了 %s 行台账\n' "$RED" "$RESET" "$rows6_before"; fail=$((fail+1))
  fi

  notif_me6_before="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")"
  notif_finder6="$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")"

  # 把帖子改准 → 同一个 found_item_id 第一次够线 → 写一行、通知失主一次。
  strong6="$(printf '{"item_type":"found","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","found_at":"%s","contact":"wx_smoke_finder6"}' \
    "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND")"
  req PUT "/api/items/$M3_6_FOUND_ID" "$strong6" "$TOKEN2"
  check '  ⑥ 改帖（弱文本→强文本）返回 HTTP 200' '200' "$STATUS"
  check '  ⑥ 改准之后这一对进了台账（OnUpdated 真的跑了匹配）' '1' \
    "$(db "SELECT (count(*)>0)::int FROM match_pairs WHERE found_item_id=$M3_6_FOUND_ID AND lost_item_id=$M3_6_LOST_ID")"
  notif_me6="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")"
  rows6_strong="$(db "SELECT count(*) FROM match_pairs WHERE found_item_id=$M3_6_FOUND_ID")"
  if [[ "$notif_me6" -gt "$notif_me6_before" ]]; then
    printf '  %sPASS%s ⑥ 失主因为这次改帖收到了 new_match（%s → %s）\n' \
      "$GREEN" "$RESET" "$notif_me6_before" "$notif_me6"; pass=$((pass+1))
  else
    printf '  %sFAIL%s ⑥ 台账写了行、失主却没收到通知 —— 两者必须在同一个事务里\n' "$RED" "$RESET"; fail=$((fail+1))
  fi

  # **判据③的可执行形式**：同一对第二次参与匹配（再改一次，只动 location_detail）。
  # 少了 ON CONFLICT 的话，小王每改一个字都会把小李通知一遍。
  pairs_total6="$(db 'SELECT count(*) FROM match_pairs')"
  # 和 strong6 只差 location_detail：分数不变，仍然够通知线，于是 RecordMatches
  # 又被调用一次 —— 这次必须被那条唯一约束吃掉。
  strong6b="$(printf '{"item_type":"found","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"一楼大厅服务台","found_at":"%s","contact":"wx_smoke_finder6"}' \
    "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND")"
  req PUT "/api/items/$M3_6_FOUND_ID" "$strong6b" "$TOKEN2"
  check '  ⑥ 第二次改同一条帖返回 HTTP 200' '200' "$STATUS"
  if [[ "$(db "SELECT count(*) FROM match_pairs WHERE found_item_id=$M3_6_FOUND_ID")" == "$rows6_strong" ]] \
     && [[ "$(db 'SELECT count(*) FROM match_pairs')" == "$pairs_total6" ]]; then
    printf '  %sPASS%s ③ 同一对第二次插入被 ON CONFLICT 挡掉，match_pairs 仍是 %s 行\n' \
      "$GREEN" "$RESET" "$pairs_total6"; pass=$((pass+1))
  else
    printf '  %sFAIL%s ③ 第二次改帖多写了台账：%s → %s（重复通知就是这么来的）\n' \
      "$RED" "$RESET" "$pairs_total6" "$(db 'SELECT count(*) FROM match_pairs')"; fail=$((fail+1))
  fi
  if [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")" == "$notif_me6" ]]; then
    printf '  %sPASS%s ③ 第二次改帖没有再通知失主（仍是 %s 条）\n' \
      "$GREEN" "$RESET" "$notif_me6"; pass=$((pass+1))
  else
    printf '  %sFAIL%s ③ 第二次改帖又通知了失主\n' "$RED" "$RESET"; fail=$((fail+1))
  fi
  # found 作者在这一整段里始终一条都没被通知（不对称在改帖上同样成立）。
  if [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")" == "$notif_finder6" ]]; then
    printf '  %sPASS%s ⑥ 拾物作者改帖前后都没收到任何通知\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s 拾物作者因为改帖被通知了 —— §2.3 明确禁止\n' "$RED" "$RESET"; fail=$((fail+1))
  fi

  # 改一条 closed 的 found 帖不该再叫醒任何人（§8 允许改 closed 帖，比如改错电话）。
  req PATCH "/api/items/$M3_6_FOUND_ID/status" '{"status":"closed"}' "$TOKEN2"
  check '  ⑥ 关掉这条 found 帖返回 HTTP 200' '200' "$STATUS"
  req PUT "/api/items/$M3_6_FOUND_ID" \
    "$(printf '{"item_type":"found","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"宿管阿姨处","found_at":"%s","contact":"wx_smoke_finder6"}' \
      "$M3_TAG" "$M3_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND")" "$TOKEN2"
  check '  ⑥ 改一条 closed 的 found 帖仍然返回 HTTP 200' '200' "$STATUS"
  if [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID AND type='new_match'")" == "$notif_me6" ]]; then
    printf '  %sPASS%s ⑥ closed 的 found 帖改帖没有再通知失主（东西已经还回去了）\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s closed 的 found 帖改帖又通知了失主\n' "$RED" "$RESET"; fail=$((fail+1))
  fi
fi

# ---------------------------------------------------------------- M4 解锁 · 收件箱 · 举报
section "M4 联系方式解锁 #21·#22、收件箱 #30–#32、举报 #41"

# 这一节要三个角色，谁也合不到谁身上：
#   TOKEN   = 失主 A：发一条 lost 帖，然后去解锁别人那条 found 帖的联系方式
#   TOKEN2  = 失主 B：同样发一条 lost 帖，专门用来验「非排他」和「标记已读只影响自己」
#   TOKEN3  = 拾主  ：发那条被解锁的 found 帖，是 #22 名单唯一合法的读者
# 少了 B，「A 解锁之后 B 还解不解得开」只能靠读代码相信；少了拾主，#21 会走进
# 「作者本人不写行」那一支，名单永远只有一个名字、也就看不出它是不是倒序的。
U3="smoke3$(date +%s)$RANDOM"
M4_TAG="m4$(date +%s)$RANDOM"
M4_CONTACT="wx_smoke_finder_m4"

req POST /api/auth/register "{\"username\":\"$U3\",\"password\":\"$P\"}"
req POST /api/auth/login "{\"username\":\"$U3\",\"password\":\"$P\"}"
TOKEN3="$(jval "$BODY" '"token":"([^"]{20,})"')"
req GET /api/auth/me '' "$TOKEN3"
FINDER_ID="$(jval "$BODY" '"data":\{"id":([0-9]+)')"

if [[ -z "$TOKEN3" || -z "$FINDER_ID" || -z "$MY_ID" || -z "$OTHER_ID" ]]; then
  printf '  %sFAIL%s 第三个冒烟用户（拾主 id=%s）没建起来，M4 这一节整段测不了\n' \
    "$RED" "$RESET" "$FINDER_ID"; fail=$((fail+1))
else
  # ---- 三条帖：两条 lost（两个失主）+ 一条 found（拾主） ----
  #
  # 文本、分类、地点、时间全部照抄 M3 那一组**已经证明过「分数跨得通知线」**的参数，
  # 只把标签换成 M4 的。为什么要在 M4 里重新走一遍匹配：收件箱那一段要有
  # 真实的 new_match 可读，而 M4 自己不写任何通知 —— 唯一的写入方就是这条链。
  # 顺序也是刻意的：先两条 lost（lost 侧一行都不写），最后建 found（这时才通知两个失主）。
  m4_lost_a="$(printf '{"item_type":"lost","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","last_seen_at":"%s","lost_at":"%s","contact":"13800007777"}' \
    "$M4_TAG" "$M4_TAG" "$CAT_WALLET" "$LOC_ID" "$T_SEEN" "$T_LOST")"
  req POST /api/items "$m4_lost_a" "$TOKEN"
  check '建失主 A 的 lost 帖返回 HTTP 200' '200' "$STATUS"
  M4_LOST_A="$(itemIDOf "$BODY")"

  m4_lost_b="$(printf '{"item_type":"lost","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","last_seen_at":"%s","lost_at":"%s","contact":"13900007777"}' \
    "$M4_TAG" "$M4_TAG" "$CAT_WALLET" "$LOC_ID" "$T_SEEN" "$T_LOST")"
  req POST /api/items "$m4_lost_b" "$TOKEN2"
  check '建失主 B 的 lost 帖返回 HTTP 200' '200' "$STATUS"
  M4_LOST_B="$(itemIDOf "$BODY")"

  m4_found="$(printf '{"item_type":"found","title":"%s 黑色长款钱包","description":"%s 夹层里有一张校园卡","category_id":%d,"location_id":%d,"location_detail":"三楼自习室B区","found_at":"%s","contact":"%s"}' \
    "$M4_TAG" "$M4_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND" "$M4_CONTACT")"
  req POST /api/items "$m4_found" "$TOKEN3"
  check '建拾主的 found 帖返回 HTTP 200' '200' "$STATUS"
  M4_FOUND="$(itemIDOf "$BODY")"
  check_re '  有人被通知了（收件箱才有东西可读）' '"notified_count":[0-9]+' "$BODY"
fi

if [[ -n "$M4_FOUND" && -n "$M4_LOST_A" && -n "$M4_LOST_B" ]]; then
  # ---- 判据①②：解锁之前 #15 给两个人看到的形状 ----
  req GET "/api/items/$M4_FOUND"
  check '① 匿名看 found 帖 → contact 是 null' '"contact":null' "$BODY"
  check '   且 contact_locked 是 true'        '"contact_locked":true' "$BODY"
  req GET "/api/items/$M4_LOST_A"
  check '② 匿名看 lost 帖 → contact 直接可见（解锁这件事只属于 found 侧）' '"contact":"13800007777"' "$BODY"

  # ---- 判据③：解锁 → 拿到 contact，且 notifications 表没有新增行 ----
  # 三个当事人的通知数一起看：只盯解锁者本人的话，「平台给拾主发了一条『有人看了
  # 你的联系方式』」这种实现正好漏掉 —— 而那恰恰是 contact_unlocked 被删掉之后
  # 最不该回来的东西（§16）。
  notif_a0="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID")"
  notif_b0="$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")"
  notif_f0="$(db "SELECT count(*) FROM notifications WHERE user_id=$FINDER_ID")"

  req POST "/api/items/$M4_FOUND/unlock-contact" '' "$TOKEN"
  check '③ #21 解锁返回 HTTP 200'        '200' "$STATUS"
  check '   data.contact 就是那条联系方式' "\"contact\":\"$M4_CONTACT\"" "$BODY"
  check '   already_unlocked 是 false（第一次）' '"already_unlocked":false' "$BODY"
  M4_UNLOCKED_AT="$(jval "$BODY" '"unlocked_at":"([^"]+)"')"
  if [[ "$M4_UNLOCKED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    printf '  %sPASS%s   unlocked_at 是 UTC 的 RFC3339（%s）\n' "$GREEN" "$RESET" "$M4_UNLOCKED_AT"
    pass=$((pass+1))
  else
    printf '  %sFAIL%s   unlocked_at 的形状不对：%s\n' "$RED" "$RESET" "$M4_UNLOCKED_AT"; fail=$((fail+1))
  fi

  if [[ "$HAS_PSQL" != 1 ]]; then
    skip '③ 解锁只写一行、且一条通知都不发（本机没有 psql，数不了 contact_views / notifications）'
  else
    check '   contact_views 里正好 1 行' '1' \
      "$(db "SELECT count(*) FROM contact_views WHERE item_id=$M4_FOUND")"
    check '   那一行记的是来解锁的那个人' '1' \
      "$(db "SELECT (count(*)=1)::int FROM contact_views WHERE item_id=$M4_FOUND AND user_id=$MY_ID")"
    if [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID")"     == "$notif_a0" ]] \
    &&  [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")" == "$notif_b0" ]] \
    &&  [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$FINDER_ID")" == "$notif_f0" ]]; then
      printf '  %sPASS%s   三个人谁都没被通知（contact_unlocked 这个 type 确实不存在了）\n' \
        "$GREEN" "$RESET"; pass=$((pass+1))
    else
      printf '  %sFAIL%s   解锁发出了通知 —— A %s→%s B %s→%s 拾主 %s→%s\n' "$RED" "$RESET" \
        "$notif_a0" "$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID")" \
        "$notif_b0" "$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")" \
        "$notif_f0" "$(db "SELECT count(*) FROM notifications WHERE user_id=$FINDER_ID")"
      fail=$((fail+1))
    fi
  fi

  req GET "/api/items/$M4_FOUND" '' "$TOKEN"
  check '   同一个人再看 #15 → contact 可见了' "\"contact\":\"$M4_CONTACT\"" "$BODY"
  check '   contact_locked 跟着变成 false'    '"contact_locked":false' "$BODY"

  # ---- 判据④：同一人解锁两次只有一行 ----
  req POST "/api/items/$M4_FOUND/unlock-contact" '' "$TOKEN"
  check '④ 第二次解锁仍然返回 HTTP 200' '200' "$STATUS"
  check '   already_unlocked 变成 true'  '"already_unlocked":true' "$BODY"
  # 回的是**第一次**那个时刻：这张表记的是「他最早什么时候看过」，不是「最后一次」。
  # 一个每次 POST 都写一行的实现也能让 already_unlocked=true，所以光看响应不够，
  # 下面还要数库。
  second_at="$(jval "$BODY" '"unlocked_at":"([^"]+)"')"
  if [[ -n "$second_at" && "$second_at" == "$M4_UNLOCKED_AT" ]]; then
    printf '  %sPASS%s   返回的还是第一次解锁的时刻\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '  %sFAIL%s   第二次解锁的时刻变了：%s → %s\n' \
      "$RED" "$RESET" "$M4_UNLOCKED_AT" "$second_at"; fail=$((fail+1))
  fi
  if [[ "$HAS_PSQL" == 1 ]]; then
    check '   库里仍然只有 1 行（幂等不是「再记一次」）' '1' \
      "$(db "SELECT count(*) FROM contact_views WHERE item_id=$M4_FOUND")"
  fi

  # ---- 判据⑤：第二个人也能解锁 —— 这不是排他锁 ----
  # 计划里那句原话是「不需要设一个人认领其他人不允许查看的规则」。
  # 这一条是 M4 最容易在后续改动里被悄悄推翻的一条：只要谁给 contact_views
  # 加一个 status 列、或者在 Unlock 里加一句「已经有人认领就返回 409」，
  # 上面四条判据全都还是绿的，只有这条会红。
  req POST "/api/items/$M4_FOUND/unlock-contact" '' "$TOKEN2"
  check '⑤ 失主 B 也解锁成功（A 没能把这条帖子锁起来）' '200' "$STATUS"
  check '   同样拿到了 contact'                          "\"contact\":\"$M4_CONTACT\"" "$BODY"
  if [[ "$HAS_PSQL" == 1 ]]; then
    check '   库里现在是 2 行（一个人一行，不是两个人抢一行）' '2' \
      "$(db "SELECT count(*) FROM contact_views WHERE item_id=$M4_FOUND")"
  fi

  # ---- 判据⑥：对 lost 帖调解锁接口 → VALIDATION ----
  req POST "/api/items/$M4_LOST_B/unlock-contact" '' "$TOKEN"
  check '⑥ 对 lost 帖调解锁 → HTTP 400' '400'                  "$STATUS"
  check '   code 是 VALIDATION'         '"code":"VALIDATION"' "$BODY"
  if [[ "$HAS_PSQL" == 1 ]]; then
    check '   被拒的那次一行都没写' '0' \
      "$(db "SELECT count(*) FROM contact_views WHERE item_id=$M4_LOST_B")"
  fi

  # ---- closed 的 found 帖：不让新人解锁，但作者本人不受影响 ----
  # 东西已经还回去了，这时候再给拾主添一个「有人来要联系方式」是没有意义的骚扰。
  # 判据顺序（作者那一支排在 closed 之前）在这里正好能测出来。
  m4_closed="$(printf '{"item_type":"found","title":"%s 黑色长款钱包（已经交前台）","description":"%s 已经交到宿管处","category_id":%d,"location_id":%d,"location_detail":"一楼大厅服务台","found_at":"%s","contact":"%s"}' \
    "$M4_TAG" "$M4_TAG" "$CAT_WALLET" "$LOC_ID" "$T_FOUND" "closed_m4_contact")"
  req POST /api/items "$m4_closed" "$TOKEN3"
  check '为 closed 场景再建一条 found 帖返回 HTTP 200' '200' "$STATUS"
  M4_CLOSED="$(itemIDOf "$BODY")"
  req PATCH "/api/items/$M4_CLOSED/status" '{"status":"closed"}' "$TOKEN3"
  check '  拾主把它关掉返回 HTTP 200' '200' "$STATUS"

  req POST "/api/items/$M4_CLOSED/unlock-contact" '' "$TOKEN"
  check '  closed 的 found 帖不让新人解锁 → HTTP 409' '409' "$STATUS"
  check '    code 是 ITEM_CLOSED'                     '"code":"ITEM_CLOSED"' "$BODY"
  req POST "/api/items/$M4_CLOSED/unlock-contact" '' "$TOKEN3"
  check '  作者自己不受影响（他要核对、要改电话）'      '200' "$STATUS"
  if [[ "$HAS_PSQL" == 1 ]]; then
    check '    而作者这一支确实一行都没写' '0' \
      "$(db "SELECT count(*) FROM contact_views WHERE item_id=$M4_CLOSED")"
  fi

  # ---- 判据⑦⑧：#22 解锁名单 ----
  req GET "/api/items/$M4_FOUND/contact-views" '' "$TOKEN3"
  check '⑦ 拾主查名单返回 HTTP 200'   '200'          "$STATUS"
  check '   total 是 2（两个失主各一行）' '"total":2' "$BODY"
  check_re '   形状是 {id,user:{...},created_at} 的嵌套' '"user":\{"id":'"$MY_ID"',' "$BODY"
  check_re '   第二个人也在名单里'     '"user":\{"id":'"$OTHER_ID"',' "$BODY"
  # real_name 在 M8（SSO）之前一直是空的，但**键必须在**：前端按它渲染一行，
  # 键消失和值为空是两种不同的故障，混在一起排查时会分不清是接口漏了字段还是没数据。
  check '   real_name 这个键存在'     '"real_name":'  "$BODY"
  check '   名单一页的默认大小是 20'  '"page_size":20' "$BODY"

  req GET "/api/items/$M4_FOUND/contact-views" '' "$TOKEN"
  check '⑧ 解锁过但不是发帖人 → HTTP 403' '403'                  "$STATUS"
  check '   code 是 FORBIDDEN'            '"code":"FORBIDDEN"' "$BODY"
  req GET "/api/items/$M4_FOUND/contact-views"
  check '   匿名 → HTTP 401（不是 403，也没给出任何一个名字）' '401' "$STATUS"
  if [[ "$BODY" == *"\"user\""* ]]; then
    printf '  %sFAIL%s 401 的响应里居然带了名单\n' "$RED" "$RESET"; fail=$((fail+1))
  else
    printf '  %sPASS%s 401 的响应体里没有名单\n' "$GREEN" "$RESET"; pass=$((pass+1))
  fi
  # 作者查自己 lost 帖的名单：合法请求、空答案。#21 在 lost 上会被拒，
  # 所以这张表对一条 lost 帖永远是空的 —— 但它不该因此变成 404 或 500。
  req GET "/api/items/$M4_LOST_A/contact-views" '' "$TOKEN"
  check '   作者查自己 lost 帖的名单 → 200 且是空列表' '"list":[],"total":0' "$BODY"
  req GET "/api/items/$M4_FOUND/contact-views?page_size=99999" '' "$TOKEN3"
  check '   page_size 超上限 → HTTP 400' '400' "$STATUS"

  # ---- #30 #31 #32 收件箱：这一节读的就是上面那条链写下的通知 ----
  req GET /api/my/notifications '' "$TOKEN"
  check '#30 收件箱返回 HTTP 200'      '200'          "$STATUS"
  check '   分页形状 {list,total,page,page_size}' '"page_size":20' "$BODY"
  check '   里面就是 M3 那一跳写的 new_match' '"type":"new_match"' "$BODY"
  if [[ "$BODY" == *'"user_id"'* ]]; then
    printf '  %sFAIL%s 收件箱里出现了 user_id —— 这一列是归属，不是给用户看的数据\n' "$RED" "$RESET"; fail=$((fail+1))
  else
    printf '  %sPASS%s 响应里没有 user_id\n' "$GREEN" "$RESET"; pass=$((pass+1))
  fi
  # item_id 必须指向那条真的 found 帖：前端靠它跳转，指错了就是点开一条不存在的帖子。
  check '   通知带着能跳过去的 item_id' "\"item_id\":$M4_FOUND" "$BODY"

  # 未读列表里要取**两个** id：第一个给「本人按 id 标记」，第二个留给「别人想标记我的」
  # 那条越权探测 —— 那次探测之后还要回头看它是不是仍然未读，所以两条不能是同一条。
  # NotificationView 的键序是 id、type、title…，所以 `"id":N,"type"` 只可能出现在列表元素开头。
  req GET '/api/my/notifications?is_read=false&page_size=5' '' "$TOKEN"
  check '   is_read=false 只回未读 → HTTP 200' '200' "$STATUS"
  unread_ids="$(printf '%s' "$BODY" | grep -oE '"id":[0-9]+,"type"' | grep -oE '[0-9]+')"
  UNREAD_ID="$(printf '%s\n' "$unread_ids" | sed -n 1p)"
  UNREAD_ID2="$(printf '%s\n' "$unread_ids" | sed -n 2p)"

  req GET '/api/my/notifications/unread-count' '' "$TOKEN"
  check '#31 未读数返回 HTTP 200 且带 count' '"count":' "$BODY"
  unread0="$(jval "$BODY" '"count":([0-9]+)')"
  req GET '/api/my/notifications/unread-count'
  check '   不带 token → HTTP 401'      '401'          "$STATUS"

  if [[ -z "$UNREAD_ID" || -z "$unread0" ]]; then
    printf '  %sFAIL%s 取不到未读通知（id=%s count=%s），#32 测不了\n' \
      "$RED" "$RESET" "$UNREAD_ID" "$unread0"; fail=$((fail+1))
  else
    req PUT /api/my/notifications/read "{\"ids\":[$UNREAD_ID]}" "$TOKEN"
    check '#32 按 id 标记已读返回 HTTP 200' '200' "$STATUS"
    check '   updated_count 是 1'          '"updated_count":1' "$BODY"
    # 第二次点同一个 id：仍然是 200，但 updated_count 必须是 0。
    # 「已读」是一个状态而不是一个计数，用户重复点不该让系统以为发生了什么新事。
    req PUT /api/my/notifications/read "{\"ids\":[$UNREAD_ID]}" "$TOKEN"
    check '   再点一次同一个 id → updated_count 是 0（幂等）' '"updated_count":0' "$BODY"

    req GET '/api/my/notifications/unread-count' '' "$TOKEN"
    unread1="$(jval "$BODY" '"count":([0-9]+)')"
    if [[ "$unread1" == "$((unread0 - 1))" ]]; then
      printf '  %sPASS%s   未读数从 %s 降到 %s\n' "$GREEN" "$RESET" "$unread0" "$unread1"; pass=$((pass+1))
    else
      printf '  %sFAIL%s   标了一条已读，未读数却是 %s → %s\n' \
        "$RED" "$RESET" "$unread0" "$unread1"; fail=$((fail+1))
    fi

    # 越权：B 拿自己的 token 去标记 A 的（另一条）通知。
    # 顺序上排在 all=true 之前，因为 all 会把 A 的未读清空，那样这条判据就没东西可验了。
    if [[ -z "$UNREAD_ID2" ]]; then
      skip '   别人替我标记已读（A 本轮只捞到一条未读，没有第二条可以事后核对）'
    else
      req PUT /api/my/notifications/read "{\"ids\":[$UNREAD_ID2]}" "$TOKEN2"
      check '   别人标记我的通知 → HTTP 403' '403'                  "$STATUS"
      check '     code 是 FORBIDDEN'         '"code":"FORBIDDEN"' "$BODY"
      req GET '/api/my/notifications?is_read=false' '' "$TOKEN"
      if [[ "$BODY" == *"\"id\":$UNREAD_ID2,\"type\""* ]]; then
        printf '  %sPASS%s   被拒的那次真的没改：A 的那条还是未读\n' "$GREEN" "$RESET"; pass=$((pass+1))
      else
        printf '  %sFAIL%s 报了 FORBIDDEN 却还是把 A 的通知改成已读了\n' "$RED" "$RESET"; fail=$((fail+1))
      fi
    fi

    # all=true 的作用域：清掉 A 的所有未读，一条都不能碰到 B。
    req GET '/api/my/notifications/unread-count' '' "$TOKEN2"
    unread_b0="$(jval "$BODY" '"count":([0-9]+)')"
    req PUT /api/my/notifications/read '{"all":true}' "$TOKEN"
    check '   all=true 返回 HTTP 200'   '200'          "$STATUS"
    req GET '/api/my/notifications/unread-count' '' "$TOKEN"
    check '   A 的未读清零'             '"count":0'    "$BODY"
    req GET '/api/my/notifications/unread-count' '' "$TOKEN2"
    if [[ "$(jval "$BODY" '"count":([0-9]+)')" == "$unread_b0" ]]; then
      printf '  %sPASS%s   B 的未读数一条没动（仍是 %s）\n' "$GREEN" "$RESET" "$unread_b0"; pass=$((pass+1))
    else
      printf '  %sFAIL%s 一键已读把 B 的通知也标了：%s → %s\n' \
        "$RED" "$RESET" "$unread_b0" "$(jval "$BODY" '"count":([0-9]+)')"; fail=$((fail+1))
    fi

    # 收件人是 token 决定的，不是查询参数决定的。
    # 这条和 #19 那条同构：能读到别人的收件箱，等于把「谁联系过谁」整份交出去。
    # 判别依据只能用「同一个人带不带这个参数是不是同一份」：B 自己也解锁过这条 found 帖，
    # 他的收件箱里本来就该有一条 item_id 指向它的通知 —— 拿 item_id 当特征是错的。
    req GET /api/my/notifications '' "$TOKEN2"
    total_b_norm="$(jval "$BODY" '"total":([0-9]+)')"
    req GET "/api/my/notifications?user_id=$MY_ID" '' "$TOKEN2"
    total_b_param="$(jval "$BODY" '"total":([0-9]+)')"
    # 两次都必须真的拿到 200：一个 401 的空响应可以匹配「什么都没变」，
    # 而它什么都没证明（上面 #19 那条同构的检查踩过这个坑）。
    if [[ "$STATUS" != "200" || -z "$total_b_norm" || -z "$total_b_param" ]]; then
      printf '  %sFAIL%s 两次收件箱读取没都成功（HTTP %s，total %s→%s），这条判据没成立也没被否证\n' \
        "$RED" "$RESET" "$STATUS" "$total_b_norm" "$total_b_param"; fail=$((fail+1))
    elif [[ "$total_b_param" != "$total_b_norm" ]] || [[ "$BODY" == *"\"id\":$UNREAD_ID,\"type\""* ]]; then
      printf '  %sFAIL%s 传了 ?user_id=%s 就改变了 B 看到的内容（total %s → %s）\n' \
        "$RED" "$RESET" "$MY_ID" "$total_b_norm" "$total_b_param"; fail=$((fail+1))
    else
      printf '  %sPASS%s   ?user_id= 被忽略，B 的收件箱还是 B 的那 %s 条\n' \
        "$GREEN" "$RESET" "$total_b_norm"; pass=$((pass+1))
    fi
  fi

  # ---- 通知是「只读」的：M4 没有任何写通知的端点 ----
  # 基线必须在这里现取，不能复用解锁那一轮的 notif_a0：中间建 closed 那条 found 帖时
  # 合法地又给失主们发过通知，拿旧基线比会假红。
  notif_a_probe="$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID")"
  req POST /api/my/notifications '{"type":"new_match"}' "$TOKEN"
  check '   POST 收件箱 → HTTP 405（没有写接口）' '405' "$STATUS"
  req PUT /api/my/notifications/unread '{"all":true}' "$TOKEN"
  check '   PUT /unread（少了一段 /read 的错路径）→ HTTP 404' '404' "$STATUS"
  if [[ "$HAS_PSQL" == 1 ]]; then
    check '   这些探测一条通知都没写' "$notif_a_probe" \
      "$(db "SELECT count(*) FROM notifications WHERE user_id=$MY_ID")"
  fi

  # ---- #41 举报：本里程碑最重要的一条是「它什么都改变不了」 ----
  square_before="$(req GET '/api/items?page_size=100'; printf '%s' "$BODY" \
    | grep -oE '"id":[0-9]+,"item_type"' | tr '\n' ' ')"
  notif_b1="$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")"
  credit_b1="$(db "SELECT credit_score FROM users WHERE id=$OTHER_ID")"
  status_b1="$(db "SELECT status FROM items WHERE id=$M4_LOST_B")"

  req POST "/api/items/$M4_LOST_B/report" \
    '{"reason_code":"spam","detail":"冒烟：这个人连发了五条一模一样的广告"}' "$TOKEN"
  check '#41 举报返回 HTTP 200'        '200'          "$STATUS"
  check '   data.status 是 open（M4 只能产生 open）' '"status":"open"' "$BODY"
  check '   data 里有 created_at'      '"created_at":"' "$BODY"
  REPORT_ID="$(jval "$BODY" '"data":\{"id":([0-9]+)')"

  if [[ "$HAS_PSQL" != 1 ]]; then
    skip '举报零自动后果（没有 psql：数不了 reports / notifications / credit_score）'
  elif [[ -z "$REPORT_ID" ]]; then
    skip '举报零自动后果（没从 #41 的响应里取到 id）'
  else
    check '   库里那一行的 status 也是 open（不是只有响应里写着 open）' 'open' \
      "$(db "SELECT status FROM reports WHERE id=$REPORT_ID")"
    check '   举报人记的是 token 里那个人' '1' \
      "$(db "SELECT (count(*)=1)::int FROM reports WHERE id=$REPORT_ID AND reporter_id=$MY_ID")"

    # ②被举报人没收到通知 ③帖子状态没变 ④信用分没动 ⑤广场顺序没动。
    # 这四条合起来才是「只记录，不仲裁」（定位原则 1）。拆开看每一条都像是
    # 「大概不会有人这么写」，合起来才挡得住把举报做成武器的那三种写法：
    # 通知对方（变成骚扰）、自动下架（变成 censorship 的前置）、扣分（变成私刑）。
    if [[ "$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")" == "$notif_b1" ]] \
    &&  [[ "$(db "SELECT credit_score FROM users WHERE id=$OTHER_ID")" == "$credit_b1" ]] \
    &&  [[ "$(db "SELECT status FROM items WHERE id=$M4_LOST_B")" == "$status_b1" ]]; then
      printf '  %sPASS%s   被举报人没被通知、信用分没动、帖子状态还是 %s\n' \
        "$GREEN" "$RESET" "$status_b1"; pass=$((pass+1))
    else
      printf '  %sFAIL%s   举报产生了自动后果：通知 %s→%s 信用 %s→%s 状态 %s→%s\n' "$RED" "$RESET" \
        "$notif_b1" "$(db "SELECT count(*) FROM notifications WHERE user_id=$OTHER_ID")" \
        "$credit_b1" "$(db "SELECT credit_score FROM users WHERE id=$OTHER_ID")" \
        "$status_b1" "$(db "SELECT status FROM items WHERE id=$M4_LOST_B")"; fail=$((fail+1))
    fi
    square_after="$(req GET '/api/items?page_size=100'; printf '%s' "$BODY" \
      | grep -oE '"id":[0-9]+,"item_type"' | tr '\n' ' ')"
    if [[ "$square_after" == "$square_before" ]]; then
      printf '  %sPASS%s   广场这一页的 id 顺序一条没变（举报数不是排序信号）\n' \
        "$GREEN" "$RESET"; pass=$((pass+1))
    else
      printf '  %sFAIL%s   举报改变了广场排序\n       %s前: %s%s\n       %s后: %s%s\n' \
        "$RED" "$RESET" "$DIM" "${square_before:0:200}" "$RESET" "$DIM" "${square_after:0:200}" "$RESET"
      fail=$((fail+1))
    fi

    # ③ 同一人对同一帖的待处理举报只有一条（uq_reports_open）
    req POST "/api/items/$M4_LOST_B/report" '{"reason_code":"spam","detail":"再举报一次"}' "$TOKEN"
    check '   同一人重复举报 → HTTP 409'  '409'                     "$STATUS"
    check '     code 是 REPORT_DUPLICATE' '"code":"REPORT_DUPLICATE"' "$BODY"
    # 换个理由也算重复：那条唯一索引管的是「同人对同帖的 open 举报」，不是「同一条理由」。
    req POST "/api/items/$M4_LOST_B/report" '{"reason_code":"fraud","detail":"换个理由再举报"}' "$TOKEN"
    check '     换一个 reason_code 仍然算重复' '"code":"REPORT_DUPLICATE"' "$BODY"
    check '   被拒的两次一共没多写行（仍是 1 行）' '1' \
      "$(db "SELECT count(*) FROM reports WHERE item_id=$M4_LOST_B")"

    # ④ 换一个用户举报同一条帖子是合法的 —— 多人举报是给 admin 的处理信号
    req POST "/api/items/$M4_LOST_B/report" '{"reason_code":"harassment","detail":"我也觉得有问题"}' "$TOKEN3"
    check '   第三个人举报同一条 → HTTP 200' '200' "$STATUS"
    if [[ "$HAS_PSQL" == 1 ]]; then
      check '   库里现在是 2 行（举报不是排他的）' '2' \
        "$(db "SELECT count(*) FROM reports WHERE item_id=$M4_LOST_B")"
    fi

    # ⑤ 表外的 reason_code → VALIDATION，而且不查库、不写行
    req POST "/api/items/$M4_LOST_B/report" '{"reason_code":"inappropriate","detail":"表外的值"}' "$TOKEN"
    check '   reason_code 传表外的值 → HTTP 400' '400' "$STATUS"
    check '     code 是 VALIDATION 而不是 CHECK_VIOLATION' '"code":"VALIDATION"' "$BODY"
  fi

  # 被举报的人连「谁举报了我」都查不到：M4 没有任何读 reports 的端点。
  # 这一条在集成测试里已经无条件覆盖（m4_report_test.go），放在这里的原因是
  # 它同时也是给 M5/M6 看的告示：别为了「让前端显示举报进度」先加一个 GET。
  req GET "/api/items/$M4_LOST_B/reports" '' "$TOKEN2"
  check '   被举报人查这条帖子的举报列表 → HTTP 404（根本没有这个读接口）' '404' "$STATUS"
  req GET "/api/items/$M4_FOUND/report" '' "$TOKEN"
  check '   GET #41 那条路径 → HTTP 405（它只接受 POST）' '405' "$STATUS"
fi

# ---------------------------------------------------------------- 封禁
# 这一步必须直接改库：M6 才有封禁端点。所以它需要 psql 和开发库的凭据，
# 拿不到就 SKIP —— 这条判据在 backend/smoketest/m1_auth_test.go 里是无条件覆盖的。
if [[ "$HAS_PSQL" != 1 ]]; then
  skip '封禁后登录 → USER_BANNED（本机找不到 psql，或者连不上开发库；试试 bash scripts/setup-postgres.sh）'
else
  db "UPDATE users SET status='banned', updated_at=now() WHERE username='$U'" >/dev/null
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
