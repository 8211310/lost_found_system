#!/usr/bin/env bash
#
# scripts/dev-admin.sh —— 把开发库里的一个**本地账号**提成 admin。
#
# 用法（Git Bash）：
#   bash scripts/dev-admin.sh                不带参数 = 只列出现有的 admin，什么都不改
#   bash scripts/dev-admin.sh ops_dev        把用户名 ops_dev 提成 admin（已经是就原样放过）
#
#   前端那条 live 契约测试要的正是这两行，提完直接填（口令是你注册时自己定的，
#   本脚本读不到它 —— users.password_hash 存的是 bcrypt 哈希，不是一句明文）：
#     LIVE_ADMIN_USER=ops_dev LIVE_ADMIN_PASS=<你注册时用那句口令> npm run test:live
#
# ---------------------------------------------------------------- 这个脚本为什么存在
# 治理身份没法从 HTTP 引导出来：把一个人提成 admin 的那条端点是 #35
# `PUT /api/admin/users/:id/role`，而它挂在 RequireAdmin 后面。所以第一个 admin
# 只能从数据库里造出来 —— 这是先有鸡还是先有蛋，不是漏做的功能。
#
# 000001 迁移里**没有种子 admin**（只种了 55 行分类 + 91 行地点），这是刻意的：
# 一个带默认口令的 admin 账号只要跟着迁移进过一次生产部署，就是整站最大的一个洞。
#
# 因此这条走的是 PRD FR-11.7「直接改数据库仍是 admin 的合法工具」和「不做清单」里
# 低频操作走数据库工具那一档（字典改名同理）。§12 的 M6 那一节早就这么干了 ——
# scripts/smoke/m6-governance.sh 开头那段「没有 psql 就整节 SKIP」说的就是同一件事，
# 区别只是那回藏在冒烟脚本里，这回单独拎出来给前端和一个手工旅程用。
#
# ---------------------------------------------------------------- ⚠ 它和 #35 的一项实质差别
# #35 的留痕和业务改动在**同一个事务**里（service/adminlog.Record 收的是 pgx.Tx，
# 编译期就拦住了「先改库再补日志」）。这个脚本只有一句 UPDATE，
# **admin_actions 里不会留下任何一行**，作者那边也不会有 #58 那条「为什么被下架」的通知链。
# 也就是说 §10 风险 8 赖以成立的那道「事后可追责」防线，在这里是失效的。
#
# 这就是下面那道 ENV 闸的全部意义：它不是防手滑，是**不让这个零留痕的动作出现在 prod**。
# 生产环境里第一次提 admin 必须走 #35（先用 Adminer 查出那个人的 id 也行，
# 但角色要由一条带 reason 的 HTTP 请求来改）。
#
# ---------------------------------------------------------------- 前置
#   1. 数据库起着：pg_isready -h 127.0.0.1 -p 5432，没起就 bash scripts/setup-postgres.sh
#   2. 本机有 psql。这个脚本**不能**像冒烟脚本那样退化成 SKIP —— 它的唯一用途就是改库，
#      没有 psql 就没有第二条路。
#   3. 那个用户名先存在，用 #1 注册一个（请求体走管道而不是命令行参数，中文用户名才不会被
#      Git Bash 按 cp1252 换算成 ??? —— 详见 scripts/smoke/lib.sh 顶部）：
#        printf '%s' '{"username":"ops_dev","password":"至少8位且别是纯数字"}' \
#          | curl -s -X POST http://localhost:8080/api/auth/register \
#                -H 'Content-Type: application/json' --data-binary @-
#      本脚本**绝不静默建号**：造出一个没人知道口令的 admin，比一个 admin 都没有更糟 ——
#      它看起来像「已经配好了」，实际要么永远闲置，要么变成一条没人负责的后门。

set -uo pipefail

# /.. 是必须的：BASH_SOURCE 给的是 scripts/，而 lib.sh 里的 envval 用的是
# $ROOT/backend/.env、db() 用的是同一个 —— 少这一层就变成 scripts/scripts/...。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${BASE:-http://localhost:8080}"

# 复用冒烟脚本那套现成的工具：envval（从 backend/.env 读，DB 口令因此既不在本脚本里、
# 也不会被打印出来）、db()（带着 PGPASSWORD 起 psql、探过连通性、HAS_PSQL 那个开关）。
# lib.sh 需要的 $ROOT / $BASE 两个全局变量就是上面那两行，顺序不能倒。
# shellcheck source=smoke/lib.sh
source "$ROOT/scripts/smoke/lib.sh"

# ---------------------------------------------------------------- 读库的那一层壳
# db_clean <SQL> —— lib.sh 的 db() 去掉 \r。
#
# 这台机器上的 psql.exe 输出的是 **CRLF** 行尾，lib.sh 里的 db() 原样返回，
# 于是最后一列永远带一个看不见的 \r。此前没暴露，是因为冒烟脚本只拿 db() 做
# 「数字」或「子串」比较（check '库里 50 条' '50' "$(db …)"）—— 多一个 \r 不影响那两种判断。
# 而本脚本要做的是**精确等值**比较用户名，`"小李\r" == "小李"` 恒为假，
# 症状就是「明明在库里、却报请先注册」。所以所有等值比较一律走这一层。
db_clean() { db "$1" | tr -d '\r'; }

# ---------------------------------------------------------------- ENV 闸
# ⚠ 按 config.Load 的**同一套优先级**读：它调 godotenv.Load()（不是 Overload），
#   也就是「真环境变量已经在那儿了就不被 .env 覆盖」。所以判断顺序必须是
#   先看 ${ENV}，再看 backend/.env，两个都没有才落到 config.go 的那个默认值 dev。
#   反过来的话会出现「.env 写着 dev、但进程是 ENV=prod 起的」这种脚本判错方向的局面。
#
# 诚实地说清楚这条闸测到的是什么：它读的是**配置**，不是那个正在跑的进程。
# 真要核对服务是以什么身份起来的，登录后打一次 #39，看 data.env 那一格。
ENV_FROM_SHELL="${ENV:-}"
ENV_FROM_FILE="$(envval ENV)"
ENV_NAME="${ENV_FROM_SHELL:-${ENV_FROM_FILE:-dev}}"

if [[ "$ENV_NAME" == "prod" ]]; then
  printf '%s拒绝执行：这套配置是 prod%s\n' "$RED" "$RESET"
  printf '  读到的 ENV 来源：%s（真环境变量）/ %s（backend/.env）\n' \
    "${ENV_FROM_SHELL:-（未设）}" "${ENV_FROM_FILE:-（未设）}"
  printf '  提 admin 请走 #35 PUT /api/admin/users/:id/role，它会把这一动作写进 admin_actions。\n'
  printf '  本脚本没有那句留痕（见文件顶部「它和 #35 的一项实质差别」）。\n'
  exit 2
fi

# 只拦 prod，其余值照跑 —— config.go 里也只有 IsProd() 这一个判断，
# ENV=staging 之类的值在后端那边和 dev 同形（#39 照样注册）。但要说一句，
# 免得有人以为「不是 dev 就被拦了」或者「拦 prod 是靠这个脚本而不是靠 #39」。
section "dev-admin：ENV=$ENV_NAME（不是 prod，允许改开发库）"

if [[ "$HAS_PSQL" != 1 ]]; then
  printf '%s没有可用的 psql，这个脚本干不了活%s\n' "$RED" "$RESET"
  printf '  lib.sh 探过 PATH 和三个 scoop 位置（D:/C:/\$HOME）。装好或改 PATH 再跑。\n'
  printf '  顺手核对 backend/.env 里的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME。\n'
  exit 2
fi

# ---------------------------------------------------------------- 收尾必打印的那张表
# 无论走到哪个分支（成功、已经是 admin、什么都没改），最后都要让人看清
# 「现在库里有几个 admin、分别是谁」—— 这个脚本改的就是全站权限最高的那一列，
# 改完不给这一眼，等于让人凭印象信任自己的开发库。
print_admins() {
  local sql="SELECT id, username, role, status FROM users WHERE role='admin' ORDER BY id;"
  printf '\n%s%s%s\n' "$DIM" "$sql" "$RESET"
  local rows
  rows="$(db_clean "SELECT id, username, role, status FROM users WHERE role='admin' ORDER BY id")"
  if [[ -z "$rows" ]]; then
    printf '  %s（一个 admin 都没有）%s\n' "$YELLOW" "$RESET"
    return
  fi
  printf '%s\n' "$rows" | while IFS= read -r line; do
    [[ -n "$line" ]] && printf '  %s\n' "$line"
  done
}

# ---------------------------------------------------------------- 参数
# 用户名按 service.Register 的同一套规范化先 trim 一次：#1 存进去的就是 trim 过的值，
# 命令行上多敲的那个空格如果不抹掉，会在库里查不到这个人，
# 而报出来的话是「请先注册」—— 一句指错方向的谎。
target="$(printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

if [[ -z "$target" ]]; then
  section "没给用户名：只报告现状，什么都不改"
  print_admins
  printf '\n%s用法：bash scripts/dev-admin.sh <用户名>%s\n' "$DIM" "$RESET"
  exit 0
fi

# ---------------------------------------------------------------- 找到那个人
# ⚠ 用户名**不进 SQL**，而是在 shell 里比对，改的时候只用一个整数 id。
#
# 这不是多余的洁癖，是两条实测过的坑：
#   1. 代码页。Git Bash 把 -c 的参数交给原生 psql.exe 时要按 cp1252 换算一次，
#      中文全部变成 ???（lib.sh 顶部记的那条）。用户名是用户自己填的，
#      「小李」「小王」是完全合法的注册名 —— 如果它进了 SQL，查不到人，
#      而这个脚本会报「请先注册」，又是一句指错方向的谎。
#   2. 引号。#1 对用户名只校验长度和非空，所以 o'brien 这种名字也合法，
#      直接拼进 '...' 就是把一句 SQL 交给了用户输入。
# 换成「把候选行列出来、在 bash 里比字符串、按 id 改」，两条坑同时不存在：
# 读回来的字节是干净的 UTF-8（管道不经过代码页），比较是精确等值，
# 而唯一进 SQL 的那个值是下面断言过的纯数字。
#
# 列顺序是刻意的：username 放**最后一列**。psql 的 -A 模式用 | 分隔，
# 而 `IFS='|' read -r a b c d` 会把多出来的分隔符之后的全部内容塞进最后一个变量 ——
# 用户名里含 | 的话（同样合法），放中间会让后面几列整体错位。
found_id=""; found_role=""; found_status=""
rows="$(db_clean "SELECT id, role, status, username FROM users WHERE username IS NOT NULL ORDER BY id")"
while IFS='|' read -r rid rrole rstatus runame; do
  [[ -n "$rid" ]] || continue
  if [[ "$runame" == "$target" ]]; then
    found_id="$rid"; found_role="$rrole"; found_status="$rstatus"
    break
  fi
done <<< "$rows"

if [[ -z "$found_id" ]]; then
  printf '%s库里查不到用户名为 %s 的本地账号%s\n' "$RED" "$target" "$RESET"
  printf '  先注册一个（口令你自己定、自己留着，脚本既不读也不写它）：\n'
  printf '  ⚠ 请求体走管道，别走命令行参数：用户名可以是中文，而 Git Bash 交给 curl.exe 前\n'
  printf '     会按 cp1252 换算一次，中文全变成 ???（scripts/smoke/lib.sh 顶部记的那条坑）。\n'
  printf '     管道里的字节不经过这次换算。\n'
  printf "    printf %%s '{\"username\":\"%s\",\"password\":\"<至少8位且别是纯数字>\"}' | \\\\\n" "$target"
  printf '      curl -s -X POST %s/api/auth/register -H "Content-Type: application/json" --data-binary @-\n' "$BASE"
  printf '  如果服务没在跑（连不上 %s），本脚本不会替你建号：\n' "$BASE"
  printf '  %s刻意不静默新建 admin%s —— 见文件开头那段「前置 3」。\n' "$DIM" "$RESET"
  printf '  也有可能这个账号确实存在但连不上库：db() 读不到行时给的是空串，两者分不开。\n'
  print_admins
  exit 1
fi

# id 必须是纯数字才能拼进 SQL（它来自 psql 的输出而不是用户输入，
# 但「来自库」不等于「可信」：这一句拦的是查询本身被改写，代价是一个正则）。
if [[ ! "$found_id" =~ ^[0-9]+$ ]]; then
  printf '%s读回来的 id 不是数字（%s），不敢拼进 SQL，停在这里%s\n' "$RED" "$found_id" "$RESET"
  exit 1
fi

# ---------------------------------------------------------------- 改（或者不改）
if [[ "$found_role" == "admin" ]]; then
  section "id=$found_id $target 已经是 admin，幂等放过（这一轮什么都没改）"
  if [[ "$found_status" == "banned" ]]; then
    printf '  %s⚠ 但这个账号现在是 banned：%s\n' "$YELLOW" "$RESET"
    printf '    middleware.JWT 每个请求都回库读那一行，先判封禁再判 role，\n'
    printf '    所以这个 admin 现在**用不了**任何 /api/admin/* —— 先解封（#36，或者 Adminer 里改 status）。\n'
  fi
  print_admins
  exit 0
fi

section "把 id=$found_id（$target）的 role 从 $found_role 提成 admin"
# psql -tA 对一条 UPDATE 回的是命令标签（UPDATE 1 / UPDATE 0）。
# 看这一眼而不是只看后面的读回：读回为空还可能是连接断了，而 UPDATE 0 明确是
# 「语句跑了、但那一行不在了」—— 两种失败要报不同的话。
tag="$(db_clean "UPDATE users SET role='admin', updated_at=now() WHERE id=$found_id")"
if [[ "$tag" != "UPDATE 1" ]]; then
  printf '%sUPDATE affected 行数不是 1（psql 回的是「%s」）%s\n' \
    "$RED" "${tag:-空——连接大概断了，去 backend/.env 核对 DB_*}" "$RESET"
  exit 1
fi

# 改完**读回来核对**而不是相信 UPDATE 成功过：db() 把 psql 的 stderr 吞掉了
# （冒烟脚本那边需要「连不上就返回空串」这个行为），所以一句失败的 SQL
# 在这里是无声的。读回来的 role 是不是 admin，是唯一能证明那行真的变了的方式。
now_role="$(db_clean "SELECT role FROM users WHERE id=$found_id")"
if [[ -z "$now_role" ]]; then
  printf '%s改完之后读不回这一行：连接大概是断了，去 backend/.env 核对 DB_*%s\n' "$RED" "$RESET"
  exit 1
fi
if [[ "$now_role" != "admin" ]]; then
  printf '%s期望 role=admin，读回来的是 %s —— UPDATE 没生效%s\n' "$RED" "$now_role" "$RESET"
  exit 1
fi
printf '  %sPASS%s id=%s %s 现在是 admin（updated_at 已写 now()）\n' "$GREEN" "$RESET" "$found_id" "$target"

if [[ "$found_status" == "banned" ]]; then
  printf '  %s⚠ 注意：这个账号还是 banned，旧 token 和新 token 都进不了 /api/admin/*。%s\n' "$YELLOW" "$RESET"
  printf '    解封走 #36（PUT /api/admin/users/:id/status，需要另一个 admin），或 Adminer 里改 status。\n'
else
  printf '\n  前端 live 契约那两行：\n'
  printf '    LIVE_ADMIN_USER=%s LIVE_ADMIN_PASS=<你注册时用那句口令> npm run test:live\n' "$target"
  printf '    其中 LIVE_ADMIN_PASS 就是你注册 %s 时自己定的一句口令（脚本无法代填、也无法读回）。\n' "$target"
fi

print_admins
exit 0
