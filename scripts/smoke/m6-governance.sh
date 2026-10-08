# ---------------------------------------------------------------- M6 治理与管理后台
# deps:
section "M6 治理 #34–#37、#39、#43–#50（§12 spam 主线 + §13 第 8、9、10 步）"

# ⚠ 这一节和 m5 一样是**自包含**的：自己注册四个用户、自己发五十条帖、自己造 admin，
#   不读前面任何一节留下的 $TOKEN / $MY_ID。
#
# ⚠⚠ 但它是全脚本里**唯一一节没有 psql 就整节跑不了**的：
#   本机没有种子 admin 账号（迁移里那一段只种了字典数据），而「把一个人提成 admin」
#   这件事本身要 admin（#35）—— 治理身份没法从 HTTP 引导出来，只能直接改库。
#   所以本节开头判 HAS_PSQL，缺了就一条 SKIP 然后 return 0。
#   这不是偷懒：§10 第③层的定位是「环境活着吗」，而这里缺的是**造出被测身份的能力**，
#   报 FAIL 会把「本机没装 psql」说成「治理接口坏了」。
#
# 四个用户各自只承担一个角色：
#   M6_chen  小陈 —— 刷屏的人，50 条 found 帖的作者（§12 那条主线就是他）
#   M6_rep1  小张 —— 举报人 A（处置之后他该收到回执）
#   M6_rep2  小刘 —— 举报人 B（同一条帖第二个人举报，验证 also_closed 和「回执一人一条」）
#   M6_ad    —— 被提成 admin 的账号；他的 token 是**提角色之前**拿到的，
#              正好用来验「role 不进 JWT claims、每请求回库读一次」这条设计从治理侧也成立
#
# 本节判据（§12 M6 那一行的四条是硬性，其余是 §13 第 8、9、10 步）：
#   ① 50 条帖子全部 status='deleted'，广场上按同一关键词一条都搜不到
#   ② 小陈只收到 **1** 条 admin_action 通知（不是 50 条），内容里有理由原文
#   ③ admin_actions 恰好 1 行，detail.ids 长度 50
#   ④ 不带 reason 调用 → VALIDATION，且**一条帖子都没被删、一行留痕都没写**（同事务回滚）
#   ⑤ #44 恢复回 open 且不发通知；#36 封号立刻生效、旧 token 当场作废；#47 警告零自动后果
#   ⑥ #49 的留痕按**动作**数：takedown 2 行、dismiss 1 行；两个举报人各收一条回执；
#      被举报人收到的是「帖子被下架」而不是「有人举报了你」
#   ⑦ §13 第 10 步那两条收尾自检 SQL 在我们的数据上都是 0 行
#   ⑧ #58 作者侧的说法：批量下架的那 50 条**每条**都带着同一句理由
#      （page=1 和 page=50 分别取自 detail.ids 和 target_id 那两支，action_id 必须相同），
#      #44 恢复之后这句跟着消失，帖主自删的那条压根没有这句

M6_P="correct-horse-battery"
M6_TAG="m6$(date +%s)$RANDOM"

# 六条理由都是**要出现在别人的屏幕上**的字符串（通知内容、台账 detail），
# 所以本节真的在意它们原样走完全程 —— 这正是第③层相对第②层的增量：
# 第②层用的是 Go 源码里的字面量，第③层用的是「从 shell 打出去的那串字节」。
#
# ⚠ 它们一律只进**请求体**（走 stdin，UTF-8 干净）和**响应体的子串匹配**（curl 的输出
#   方向不经过代码页转换），绝不当成 psql 的参数 —— 那条坑写在 lib.sh 顶部。
#   要数库里的中文，就改成数行数、数键出现的次数（下面全程这么写）。
M6_REASON="刷屏广告"
M6_BAN_REASON="连续刷屏，先冻结账号"
M6_UNBAN_REASON="本人已清理其余广告帖"
M6_RESTORE_REASON="误删，恢复展示"
M6_WARN_REASON="发帖前请先读社区约定"
M6_RT_REASON="同一物品重复发布"          # ⚠ 故意不含「举报」二字，见下面那条「被举报人不该知道被举报」
M6_RT_NOTE="已核对两张凭证图"
M6_DISMISS_REASON="描述与实物一致，不下架"

# 36=衣物箱包→钱包，70=图书馆，都是迁移里种好的叶子（和 m3/m5 同一对）。
M6_CAT=36
M6_LOC=70
M6_T_FOUND="$(date -u -d '-90 minutes' +%Y-%m-%dT%H:%M:%SZ)"

# m6_new <后缀> <变量前缀> —— 注册 + 登录 + 取 id，写进 $<前缀>_TOK / $<前缀>_ID。
# 和 m5 那份同形：一次注册要同时给出 token 和 id，bash 函数只能从 stdout 返回一个字符串，
# 所以走 printf -v 写全局，而不是把两样拼在一起再解析一遍。
m6_new() {
  local suffix="$1" pfx="$2" tk
  local name="${M6_TAG}$suffix"
  req POST /api/auth/register "{\"username\":\"$name\",\"password\":\"$M6_P\"}"
  req POST /api/auth/login "{\"username\":\"$name\",\"password\":\"$M6_P\"}"
  tk="${pfx}_TOK"; printf -v "$tk" '%s' "$(jval "$BODY" '"token":"([^"]{20,})"')"
  req GET /api/auth/me '' "${!tk}"
  tk="${pfx}_ID"; printf -v "$tk" '%s' "$(jval "$BODY" '"data":\{"id":([0-9]+)')"
}

# 数 BODY 里某个固定字符串出现了几次。
#
# 为什么不用 grep -c：它数的是**行数**，而整个响应体是一行 —— 一条通知和五十条通知
# 都会返回 1。必须 grep -o 之后再 wc -l。
# 为什么这么数而不是「把 data 剥出来再搜键名」：信封自己就有 "message" 这个键，
# 手剥信封（${BODY#*'"data":}）在 ${} 里放单引号会让 bash 从那一行起整份文件解析错位，
# 报出来的是「某某: unbound variable」这种和真实原因毫无关系的话。数次数是安全的写法。
count_in_body() {
  local n
  n="$(printf '%s' "$BODY" | grep -o "$1" | wc -l | tr -d '[:space:]')"
  printf '%s' "${n:-0}"
}

notif_type()  { db "SELECT count(*) FROM notifications WHERE user_id=$1 AND type='$2'"; }
notif_total() { db "SELECT count(*) FROM notifications WHERE user_id=$1"; }
# 留痕按 (这次运行的 admin, 动作) 数：admin_actions 是全库累积的，
# 上一轮冒烟、别人的手工操作都在里面，不带 admin_id 的计数没有意义。
m6_log() { db "SELECT count(*) FROM admin_actions WHERE admin_id=$M6_ad_ID AND action='$1'"; }
m6_log_total() { db "SELECT count(*) FROM admin_actions WHERE admin_id=$M6_ad_ID"; }
# 广场上的条数：#14 默认只给 open/closed，deleted 永远不出现 ——
# 所以「total 变 0」本身就是「下架生效了」的证据，不需要额外传 status 参数。
plaza_total() { req GET "/api/items?keyword=$M6_TAG&page_size=100"; jval "$BODY" '"total":([0-9]+)'; }
item_status() { db "SELECT status FROM items WHERE id=$1"; }

# ---------------------------------------------------------------- 前置：治理身份造得出来吗
if [[ "$HAS_PSQL" != 1 ]]; then
  skip 'M6 整节（本机没有 psql：没有种子 admin，而提角色这件事本身要 admin，造不出被测身份）'
  return 0
fi

m6_new chen M6_chen
m6_new r1  M6_rep1
m6_new r2  M6_rep2
m6_new ad  M6_ad

if [[ -z "$M6_chen_TOK" || -z "$M6_rep1_TOK" || -z "$M6_ad_ID" ]]; then
  printf '  %sFAIL%s 这一节要的四个用户没建齐（小陈=%s 举报人=%s admin=%s），M6 整段测不了\n' \
    "$RED" "$RESET" "$M6_chen_ID" "$M6_rep1_ID" "$M6_ad_ID"
  fail=$((fail+1))
  return 0
fi

db "UPDATE users SET role='admin', updated_at=now() WHERE id=$M6_ad_ID" >/dev/null

# ---------- 屏障本身：RequireAdmin 挂在那 16 条路由上 ----------
# ⚠ 这里用的是**提角色之前**登录拿到的那个 token，中间没有再登录一次。
# 它 200 就说明 role 真的不是从 claims 里读的（计划 §7：status/role 都每请求回库读），
# 于是「封号立刻生效」那一类判断有了一条同源的、从治理侧的正面前提。
req GET /api/admin/stats '' "$M6_ad_TOK"
check '#37 刚被提角色的账号用**旧 token** 就能进管理端（role 不在 JWT 里）' '200' "$STATUS"
check '   code 是 OK' '"code":"OK"' "$BODY"
req GET /api/admin/stats '' "$M6_chen_TOK"
check '   非 admin 打同一条 → HTTP 403' '403' "$STATUS"
check '     code 是 FORBIDDEN' '"code":"FORBIDDEN"' "$BODY"
req GET /api/admin/stats
check '   匿名 → HTTP 401' '401' "$STATUS"

# ---------- #39 debug/config：全系统唯一吐运行时配置的端点 ----------
req GET /api/debug/config '' "$M6_chen_TOK"
check '#39 非 admin → HTTP 403' '403' "$STATUS"
req GET /api/debug/config '' "$M6_ad_TOK"
check '   admin 且 ENV=dev → HTTP 200（生产环境这条路由压根不注册）' '200' "$STATUS"
check '   env 这一格是 dev' '"env":"dev"' "$BODY"
check '   jwt_secret 打码成 ***（config.Redacted 是唯一的脱敏出口）' '"jwt_secret":"***"' "$BODY"
# ---------- 匹配参数：四个键一个都不能少 ----------
# §9 造这个端点的唯一理由就是「调参之前先问一句现在生效的是多少」。
# 少吐一个键，那个参数就又只能靠猜 —— 而 MatchConfig 有四个字段，
# Redacted 漏掉其中一个时，测试里数一下 `"match_` 的次数就能当场发现（时间容差以前就是漏的那个）。
check_re '   匹配参数一共四个键（少一个就是 Redacted 和 MatchConfig 脱节了）' '^4$' "$(count_in_body '"match_')"
# 拿 .env 里的值和响应里的值对一遍，证明这个键不是硬编码在 Redacted 里的装饰。
# 兜底 24 必须和 config.Load 里 getInt("MATCH_TIME_TOLERANCE_HOURS", 24) 那句同值 ——
# 两边各写一份默认值，是这类断言最容易悄悄失效的方式（.env 没这个键时尤其明显）。
# ⚠ 和上面那条 jwt_secret 检查一样的已知局限：envval 读的是 backend/.env，
#   而如果服务是用真环境变量 MATCH_TIME_TOLERANCE_HOURS 起的，那边的优先级更高，
#   这条会比出一个假红。dev 用 .env 启动，所以这里不额外处理。
M6_TOL="$(envval MATCH_TIME_TOLERANCE_HOURS)"; M6_TOL="${M6_TOL:-24}"
check_re "   match_time_tolerance_hours 是个数字，且等于 .env 里的取值（$M6_TOL）" \
  "\"match_time_tolerance_hours\":$M6_TOL([,}])" "$BODY"
# ⚠ 这一段故意不打印 BODY：它检查的正是「响应里有没有泄漏密钥」，
#   泄漏的时候把响应贴出来等于二次泄漏。只打印长度，长度足够排除「空值」这种巧合。
M6_SECRET="$(envval JWT_SECRET)"
if [[ -z "$M6_SECRET" ]]; then
  skip '   真实 JWT_SECRET 没有从 #39 漏出去（backend/.env 里没读到这个变量）'
elif [[ "$BODY" == *"$M6_SECRET"* ]]; then
  printf '  %sFAIL%s   真实 JWT_SECRET 出现在 #39 的响应里（响应体 %d 字节，值本身不打印）\n' \
    "$RED" "$RESET" "${#BODY}"
  fail=$((fail+1))
else
  printf '  %sPASS%s   真实 JWT_SECRET 没有从 #39 漏出去\n' "$GREEN" "$RESET"
  pass=$((pass+1))
fi

# ---------- 判据①②③④的主角：五十条刷屏帖 ----------
section "M6 spam 主线：50 条广告帖 → #43 批量下架"

M6_IDS=()
for i in $(seq 1 50); do
  req POST /api/items "{\"item_type\":\"found\",\"title\":\"$M6_TAG ad item $i\",\"description\":\"$M6_TAG duplicate posting $i\",\"category_id\":$M6_CAT,\"location_id\":$M6_LOC,\"found_at\":\"$M6_T_FOUND\",\"contact\":\"wx_m6_spam\"}" "$M6_chen_TOK"
  id="$(itemIDOf "$BODY")"
  [[ -n "$id" ]] && M6_IDS+=("$id")
done
if [[ ${#M6_IDS[@]} -ne 50 ]]; then
  printf '  %sFAIL%s 小陈只建出 %d 条帖（要 50 条），后面的判据全部失去前提\n' "$RED" "$RESET" "${#M6_IDS[@]}"
  fail=$((fail+1))
  return 0
fi
printf '  %sPASS%s 小陈连发 50 条 found 帖全部成功\n' "$GREEN" "$RESET"; pass=$((pass+1))

M6_FIRST="${M6_IDS[0]}"
M6_IDCSV="$(IFS=,; printf '%s' "${M6_IDS[*]}")"

# 这一条是后面那条「广场搜不到」的**正面前提**。没有它，
# 「库里其实一条都没建出来」和「下架真的生效了」在响应上长得一模一样。
check '下架前：广场按本轮关键词能搜到 50 条（total=50）' '50' "$(plaza_total)"
check '   库里这 50 条都是 open' '50' \
  "$(db "SELECT count(*) FROM items WHERE user_id=$M6_chen_ID AND status='open'")"
check '   小陈一条通知都没收到（found 方向不通知作者自己，§5.8）' '0' "$(notif_total "$M6_chen_ID")"

# ---------- 判据④：先验「不给理由就什么都不会发生」 ----------
# 顺序是刻意的：这一小段跑完，admin_actions 对本轮 admin 来说必须是**空**的，
# 于是它同时是「留痕只由成功动作写」这条判据的唯一前提。
# 它测的是那条不变式（§6：adminlog.Record 的第二参数是 pgx.Tx，留痕和业务改动同事务）
# 唯一能从 HTTP 外面看见的样子 —— 第②层验的是「出错就回滚」，
# 这里验的是「回滚之后开发库里真的什么都没多」。
req POST /api/admin/items/takedown "{\"ids\":[$M6_IDCSV]}" "$M6_ad_TOK"
check '④ #43 不带 reason → HTTP 400' '400' "$STATUS"
check '   code 是 VALIDATION' '"code":"VALIDATION"' "$BODY"
check '   错误指向 reason' '"field":"reason"' "$BODY"

req POST /api/admin/items/takedown "{\"ids\":[],\"reason\":\"$M6_REASON\"}" "$M6_ad_TOK"
check '   ids 是空数组 → HTTP 400（「没选」和「选了 0 条」是同一件事）' '400' "$STATUS"
check '   错误指向 ids' '"field":"ids"' "$BODY"

req POST /api/admin/items/takedown "{\"ids\":[0,-3],\"reason\":\"$M6_REASON\"}" "$M6_ad_TOK"
check '   ids 里有非正整数 → HTTP 400' '400' "$STATUS"
check '   同样指向 ids' '"field":"ids"' "$BODY"

check '   被拒的三次一条帖子都没删（还是 50 条 open）' '50' \
  "$(db "SELECT count(*) FROM items WHERE user_id=$M6_chen_ID AND status='open'")"
check '   deleted 一条都没有' '0' \
  "$(db "SELECT count(*) FROM items WHERE user_id=$M6_chen_ID AND status='deleted'")"
check '   留痕一行都没写（同事务回滚最直接的样子）' '0' "$(m6_log_total)"
check '   小陈也一条通知都没收到' '0' "$(notif_total "$M6_chen_ID")"

# ---------- 判据①②③：带上理由，一次下架 ----------
req POST /api/admin/items/takedown "{\"ids\":[$M6_IDCSV],\"reason\":\"$M6_REASON\"}" "$M6_ad_TOK"
check '① 带上理由批量下架 50 条 → HTTP 200' '200' "$STATUS"
check '   taken_down=50' '"taken_down":50' "$BODY"
check '② notified_users=1，不是 50（按作者合并）' '"notified_users":1' "$BODY"
check '   库里 50 条全部 status=deleted' '50' \
  "$(db "SELECT count(*) FROM items WHERE user_id=$M6_chen_ID AND status='deleted'")"

req GET "/api/items?keyword=$M6_TAG&page_size=100"
check '   广场上按同一关键词一条都搜不到（total=0）' '0' "$(jval "$BODY" '"total":([0-9]+)')"
check_re '   返回的是空 list，不是「有数据但 total 算错了」' '"list":\[\]' "$BODY"

# ---------- 判据③：留痕是 1 行，不是 50 行 ----------
check '③ 留痕恰好 1 行 item_takedown' '1' "$(m6_log item_takedown)"
check '   detail.ids 长度 50' '50' \
  "$(db "SELECT jsonb_array_length(detail->'ids') FROM admin_actions WHERE admin_id=$M6_ad_ID AND action='item_takedown'")"
check '   同一行里的 count 与 ids 长度一致（RecordBatch 写死的那两个键）' '50' \
  "$(db "SELECT (detail->>'count')::int FROM admin_actions WHERE admin_id=$M6_ad_ID AND action='item_takedown'")"
check '   target_id 是这批里的第一条' "$M6_FIRST" \
  "$(db "SELECT target_id FROM admin_actions WHERE admin_id=$M6_ad_ID AND action='item_takedown'")"
check '   target_type 是 item' 'item' \
  "$(db "SELECT target_type FROM admin_actions WHERE admin_id=$M6_ad_ID AND action='item_takedown'")"
# 理由的往返走 #50 的响应来断言，不走 SQL：中文当 psql 的 -c 参数会被 Git Bash 按代码页
# 换算成 ???（lib.sh 顶部那条坑），那样「原样入库」这一条测的就不是产品而是 shell。
# 方向换成「从库里读出来、经接口吐回来」之后，比对的是两端都是干净的 UTF-8。
req GET "/api/admin/actions?admin_id=$M6_ad_ID&action=item_takedown&page_size=100" '' "$M6_ad_TOK"
check '   理由原文能在 #50 台账里读回来' "$M6_REASON" "$BODY"

# ---------- 判据②：通知合并，而且理由要能读回去 ----------
check '② 小陈只收到 1 条 admin_action（不是 50 条）' '1' "$(notif_type "$M6_chen_ID" admin_action)"
req GET '/api/my/notifications?page_size=100' '' "$M6_chen_TOK"
check '   接口口径也是 1 条（数 "content": 出现的次数，信封没这个键）' '1' "$(count_in_body '"content":')"
check '   通知内容里有理由原文' "$M6_REASON" "$BODY"
check '   也有「50 条」这个数字（合并的那条必须说清范围）' '你的 50 条帖子' "$BODY"
check '   item_id 是 null：一批帖子没有单一对应的帖子页' '"item_id":null' "$BODY"

# ---------- #58：作者侧「为什么不见了」，第 1 条和第 50 条都得有同一句 ----------
#
# 判据③ 刚钉过「一次批量下架只写 1 行台账」。那 50 个 id 里只有第一个住在 target_id
# 这一列，其余 49 个藏在 detail->'ids' 那个 JSONB 数组里 ——
# 「每个帖子都有说法」要求读的那份 SQL 把数组摊平回一行一个 id。
#
# 为什么非要按页取**首尾两条**，而不是数一遍 removal 在这页出现了几次：
# 数次数分辨不出两种完全相反的错误 ——
#   ① 只 JOIN target_id → removal 出现 1 次，另外 49 条无声消失；
#   ② 给整页挂同一个对象（把「这条的理由」写成「这批的理由」）→ 正好出现 50 次，看着最像对的。
# 这 50 条的 created_at 是循环里一条条插进去的，所以 page=50 是最早那一条
# （= ids[0] = 台账的 target_id，走第一支）、page=1 是最新那一条（只能从 detail.ids 找回，
# 走第二支）。两条**分别**取到理由、而且 action_id 相同，才同时排除 ① 和 ②。
#
# ⚠ 数值断言一律走 check_re 加 ^...$ 锚，不用 check：check 是子串匹配，
#   「期望 1 实际 10」「期望 50 实际 500」都会假绿，而这里数的正是这些数字。
req GET '/api/my/items?status=deleted&page_size=100' '' "$M6_chen_TOK"
check_re '#58 作者侧 #19 能看到 50 条 deleted' '"total":50,' "$BODY"
check_re '   整页 removal 出现 50 次（一条不落）' '^50$' "$(count_in_body '"removal":')"
check_re '   理由原文也各出现 50 次' '^50$' "$(count_in_body "$M6_REASON")"
check_re '   响应里没有 admin_id / real_name / report_id 这三个键（各 0 次）' '^0$' \
  "$(printf '%s' "$BODY" | grep -oE '"(admin_id|real_name|report_id)"' | wc -l | tr -d '[:space:]')"

M6_REM_IDS=()
for M6_PAGE in 1 50; do
  req GET "/api/my/items?status=deleted&page_size=1&page=$M6_PAGE" '' "$M6_chen_TOK"
  check "#58 page=$M6_PAGE（$([[ $M6_PAGE == 1 ]] && echo '最新那条，只能走 detail.ids' || echo '最早那条，走 target_id')）→ HTTP 200" '200' "$STATUS"
  check_re '   这一条带 removal，且只带 1 次' '^1$' "$(count_in_body '"removal":')"
  check '   理由原文逐字在这一条里' "$M6_REASON" "$BODY"
  check_re '   removal 里恰好三个键' '"action_id":[0-9]+,"reason":"'"$M6_REASON"'","created_at":"[^"]+"' "$BODY"
  M6_REM_IDS+=("$(jval "$BODY" '"action_id":([0-9]+)')")
done
# 两个 action_id 必须相同、且必须是数字（jval 抠不到时是空串，空串 == 空串也会「相同」）。
if [[ "${M6_REM_IDS[0]}" =~ ^[0-9]+$ && "${M6_REM_IDS[0]}" == "${M6_REM_IDS[1]}" ]]; then
  printf '  %sPASS%s 首尾两条挂的是同一行台账（action_id=%s —— 那一次批量动作）\n' \
    "$GREEN" "$RESET" "${M6_REM_IDS[0]}"
  pass=$((pass+1))
else
  printf '  %sFAIL%s 首尾两条的 action_id 是 [%s] 和 [%s]，期望同一个数字\n' \
    "$RED" "$RESET" "${M6_REM_IDS[0]}" "${M6_REM_IDS[1]}"
  fail=$((fail+1))
fi

# ---------- #34 用户列表：治理侧的入口 ----------
# 四个用户的用户名都以 $M6_TAG 开头，所以 ?q= 这一条能给出一个**精确**的 4，
# 不受开发库里其他轮次的残留影响。
req GET "/api/admin/users?q=$M6_TAG&page_size=100" '' "$M6_ad_TOK"
check '#34 按用户名前缀筛到本轮 4 个用户（total=4）' '4' "$(jval "$BODY" '"total":([0-9]+)')"
check '   列表里没有 phone / email / password_hash 这三个键（各出现 0 次）' '0' \
  "$(( $(count_in_body '"phone"') + $(count_in_body '"email"') + $(count_in_body '"password_hash"') ))"
req GET "/api/admin/users?q=$M6_TAG&status=ghost" '' "$M6_ad_TOK"
check '   ?status= 传表外的值 → HTTP 400（不能当成「没筛选」）' '400' "$STATUS"
check '     错误指向 status' '"field":"status"' "$BODY"

# ---------- 判据⑤ 之一：#44 恢复 ----------
req POST "/api/admin/items/$M6_FIRST/restore" "{\"reason\":\"$M6_RESTORE_REASON\"}" "$M6_ad_TOK"
check '#44 恢复那条被误删的 → HTTP 200' '200' "$STATUS"
check '   status 回到 open（不是「回到下架之前」，库里没存那个快照）' '"status":"open"' "$BODY"
check '   广场上又能搜到 1 条' '1' "$(plaza_total)"
req POST "/api/admin/items/$M6_FIRST/restore" "{\"reason\":\"$M6_RESTORE_REASON\"}" "$M6_ad_TOK"
check '   再恢复一次 → HTTP 400（只有 deleted 的帖子能被恢复，幂等不该假装成功）' '400' "$STATUS"
check '     错误指向 id' '"field":"id"' "$BODY"
check '   留痕 1 行 item_restore' '1' "$(m6_log item_restore)"
check '   恢复**不发**通知（§3.7 那四种触发里没有它）' '1' "$(notif_type "$M6_chen_ID" admin_action)"

# ---------- #58 的另一半：恢复之后那句理由跟着消失 ----------
#
# 台账里那行 item_takedown **仍然在**（恢复抹不掉治理历史，上面刚数过 1 行 item_restore），
# 所以「removal 不见了」只能是因为这一行不再是 deleted，而不是因为历史被删了。
# 这一步测的是 service 里那道 `status == deleted` 的门槛 ——
# 少了它，一条已经重新公开的帖子会一直挂着「因为广告被下架过」的标签。
req GET '/api/my/items?page_size=100' '' "$M6_chen_TOK"
check '#58 恢复的那条回到默认页（open 也看得见）' '"status":"open"' "$BODY"
check_re '   整页 removal 出现 0 次' '^0$' "$(count_in_body '"removal":')"
req GET "/api/items/$M6_FIRST" '' "$M6_chen_TOK"
check '   #15 详情同样是 open' '"status":"open"' "$BODY"
check_re '   详情里也没有 removal（正面前提：这条响应不是错误信封）' '"id":'"$M6_FIRST" "$BODY"
check_re '   removal 出现 0 次' '^0$' "$(count_in_body '"removal":')"

# ---------- §13 第 8 步的封号那一半：#36 ----------
# 正面前提：封之前他的小屋接口是通的。
req GET '/api/my/items?page_size=1' '' "$M6_chen_TOK"
check '封之前小陈的 /api/my/items 是 200（下面那条 403 的前提）' '200' "$STATUS"

req PUT "/api/admin/users/$M6_chen_ID/status" "{\"status\":\"banned\",\"reason\":\"$M6_BAN_REASON\"}" "$M6_ad_TOK"
check '#36 封号 → HTTP 200，data 里回显新状态' '"status":"banned"' "$BODY"
req GET '/api/my/items?page_size=1' '' "$M6_chen_TOK"
check '   他手上**同一个 token** 下一次请求就作废 → HTTP 403' '403' "$STATUS"
check '     code 是 USER_BANNED' '"code":"USER_BANNED"' "$BODY"
req GET "/api/admin/users?q=$M6_TAG&status=banned&page_size=100" '' "$M6_ad_TOK"
check '   待办页按 ?status=banned 筛得到他（total=1，AND 语义）' '1' "$(jval "$BODY" '"total":([0-9]+)')"
check '   留痕 1 行 user_ban' '1' "$(m6_log user_ban)"
check '   小陈收到第 2 条 admin_action' '2' "$(notif_type "$M6_chen_ID" admin_action)"
# ⚠ 这里**不**去读他的收件箱：他正被封着，任何带他 token 的请求都是上面那个 403，
#   收件箱读出来的会是错误信封（第一版就是栽在这里，报的失败长得像文案坏了）。
#   理由原文的断言挪到解封之后 —— 那也正好是 service 那段注释说的事实：
#   「他看到的是一句『你因为『刷屏』被封过』，而不是莫名其妙的一段空窗期」，
#   前提是解封之后他能把整条链读回来。

# 不可恢复动作必须当场拒：被封的账号自己解不开，旧 token 也进不来，
# 「封掉自己」一旦发生就只能改库。这是 service 层那道 if userID == adminID 的从 HTTP 侧的样子。
req PUT "/api/admin/users/$M6_ad_ID/status" "{\"status\":\"banned\",\"reason\":\"$M6_BAN_REASON\"}" "$M6_ad_TOK"
check '   admin 封自己 → HTTP 403（不可恢复的动作不在权限范围内）' '403' "$STATUS"
req PUT "/api/admin/users/999999999/status" "{\"status\":\"banned\",\"reason\":\"$M6_BAN_REASON\"}" "$M6_ad_TOK"
check '   封一个不存在的用户 → HTTP 404' '404' "$STATUS"

req PUT "/api/admin/users/$M6_chen_ID/status" "{\"status\":\"active\",\"reason\":\"$M6_UNBAN_REASON\"}" "$M6_ad_TOK"
check '   解封 → HTTP 200' '200' "$STATUS"
req GET '/api/auth/me' '' "$M6_chen_TOK"
check '   旧 token 当场又能用了（不需要重新登录）' '200' "$STATUS"
check '   解封也发通知：他该知道现在是谁解封的、为什么' '3' "$(notif_type "$M6_chen_ID" admin_action)"
check '   留痕 1 行 user_unban（和 user_ban 是两个可分别追责的事实）' '1' "$(m6_log user_unban)"
req GET '/api/my/notifications?page_size=100' '' "$M6_chen_TOK"
check '   现在他能读回整条链：封号那条写着当初的理由' "因『$M6_BAN_REASON』被封禁" "$BODY"
check '   解封这条写着解封的说明' "已解除封禁。管理员留下的说明：『$M6_UNBAN_REASON』" "$BODY"

# ---------- #47 警告：唯一的后果就是「那句话被送到了」 ----------
# 计划 §12：「警告要真的送到」。它的判据反过来更好查：除了 notifications 一行
# 和 admin_actions 一行之外**什么都不许变** —— 不扣分、不改状态、不开关任何帖子。
# 这一组「什么都没变」只有能直接读库才测得出来，正是第③层相对第②层的增量。
M6_CHEN_CREDIT="$(db "SELECT credit_score FROM users WHERE id=$M6_chen_ID")"
check '小陈的积分读得到，且还是出厂的 100（下面那条「没动」的正面前提）' '100' "$M6_CHEN_CREDIT"
req POST "/api/admin/users/$M6_chen_ID/warn" "{\"reason\":\"$M6_WARN_REASON\"}" "$M6_ad_TOK"
check '#47 警告 → HTTP 200，notified=true' '"notified":true' "$BODY"
check '   收到第 4 条 admin_action' '4' "$(notif_type "$M6_chen_ID" admin_action)"
req GET '/api/my/notifications?page_size=100' '' "$M6_chen_TOK"
check '   通知内容就是那句理由' "$M6_WARN_REASON" "$BODY"
check '   积分一分没动' "$M6_CHEN_CREDIT" "$(db "SELECT credit_score FROM users WHERE id=$M6_chen_ID")"
check '   账号状态还是 active' 'active' "$(db "SELECT status FROM users WHERE id=$M6_chen_ID")"
check '   他名下没有任何帖子被顺带改动（open 还是那 1 条）' '1' \
  "$(db "SELECT count(*) FROM items WHERE user_id=$M6_chen_ID AND status='open'")"
check '   留痕 1 行 warning_sent' '1' "$(m6_log warning_sent)"

# ---------- §13 第 9 步：举报全链路的后半段（处置） ----------
section "M6 举报处置 #48/#49：留痕按动作数，回执一人一条"

# 先立「举报本身什么都不会发生」这条前提（M4 从举报人侧验过，这里从被举报人侧再验一次，
# 因为它紧接着要被 #49 的行为拿来对比）。
req POST "/api/items/$M6_FIRST/report" '{"reason_code":"spam","detail":"同一条广告刷了两遍"}' "$M6_rep1_TOK"
check '#41 小张举报那条恢复出来的帖 → HTTP 200' '200' "$STATUS"
req POST "/api/items/$M6_FIRST/report" '{"reason_code":"fraud","detail":"我也看到了"}' "$M6_rep2_TOK"
check '   小刘举报同一条也成功（认领非排他，多人举报是优先信号）' '200' "$STATUS"
check '   两个人举报之后这条帖在库里是 2 行 open' '2' \
  "$(db "SELECT count(*) FROM reports WHERE item_id=$M6_FIRST AND status='open'")"
check '   小陈的通知数没变（举报不通知被举报人）' '4' "$(notif_total "$M6_chen_ID")"
check '   帖子还是 open（平台只记录，不裁决）' 'open' "$(item_status "$M6_FIRST")"

req GET '/api/admin/reports?status=open&page_size=100' '' "$M6_ad_TOK"
check '#48 待办页能看到这条帖被举报了 2 次（排序信号）' '"report_count_on_item":2' "$BODY"
# 锚在 item.id 上取 report.id：`.*` 是最长匹配，拿到的是这一页里**最后**那条同帖举报，
# 两条都是 open、处置哪一条都会连带关掉另一条，所以「哪一条」不影响判据，
# 但模式必须精确到 item —— 否则抠到的是别的举报。
M6_RPT="$(jval "$BODY" '"id":([0-9]+),"item":\{"id":'"$M6_FIRST"'')"
if [[ -z "$M6_RPT" ]]; then
  printf '  %sFAIL%s 没能从 #48 的响应里取出举报 id，#49 测不了\n' "$RED" "$RESET"
  fail=$((fail+1))
else
  printf '  %sPASS%s 从 #48 待办页取到了那条举报的 id=%s\n' "$GREEN" "$RESET" "$M6_RPT"
  pass=$((pass+1))

  req POST "/api/admin/reports/$M6_RPT/resolve" '{"resolution":"takedown"}' "$M6_ad_TOK"
  check '⑥ #49 不带 reason → HTTP 400' '400' "$STATUS"
  check '   错误指向 reason' '"field":"reason"' "$BODY"
  check '   被拒的这次什么都没发生（两条举报仍是 open）' '2' \
    "$(db "SELECT count(*) FROM reports WHERE item_id=$M6_FIRST AND status='open'")"
  check '     留痕一行都没多（report_resolved 还是 0）' '0' "$(m6_log report_resolved)"

  req POST "/api/admin/reports/$M6_RPT/resolve" "{\"resolution\":\"delete\",\"reason\":\"$M6_RT_REASON\"}" "$M6_ad_TOK"
  check '   resolution 传表外的值 → HTTP 400' '400' "$STATUS"
  check '     错误指向 resolution' '"field":"resolution"' "$BODY"

  req POST "/api/admin/reports/$M6_RPT/resolve" \
    "{\"resolution\":\"takedown\",\"reason\":\"$M6_RT_REASON\",\"note\":\"$M6_RT_NOTE\"}" "$M6_ad_TOK"
  check '   带理由选「下架」→ HTTP 200，status=resolved' '"status":"resolved"' "$BODY"
  check '   同帖另一条 open 举报被连带关掉（open 归零）' '0' \
    "$(db "SELECT count(*) FROM reports WHERE item_id=$M6_FIRST AND status='open'")"
  check '⑥ 留痕按动作数：report_resolved 1 行' '1' "$(m6_log report_resolved)"
  check '   item_takedown 变成 2 行（批量那次 + 这次连带）—— 两件事各自可追责' '2' "$(m6_log item_takedown)"
  check '   那条帖子确实又被下架了' 'deleted' "$(item_status "$M6_FIRST")"

  check '   小张收到 1 条 report_resolved 回执' '1' "$(notif_type "$M6_rep1_ID" report_resolved)"
  check '   小刘也收到 1 条（被连带关掉的那个同样要回话）' '1' "$(notif_type "$M6_rep2_ID" report_resolved)"
  req GET '/api/my/notifications?page_size=100' '' "$M6_rep1_TOK"
  check '   回执说了结论' '已下架相关内容' "$BODY"
  check '   回执说了管理员的处置说明' "$M6_RT_NOTE" "$BODY"
  if [[ "$BODY" == *"${M6_TAG}chen"* ]]; then
    printf '  %sFAIL%s 回执里出现了被举报人的账号名 —— 举报会变成互相攻击的工具\n' "$RED" "$RESET"
    fail=$((fail+1))
  else
    printf '  %sPASS%s 回执里没有被举报人的账号信息（前提：上面那条 200 和内容断言都成立）\n' "$GREEN" "$RESET"
    pass=$((pass+1))
  fi
  check '   小陈只多了一条「帖子被下架」，不是「有人举报了你」' '5' "$(notif_type "$M6_chen_ID" admin_action)"
  req GET '/api/my/notifications?page_size=100' '' "$M6_chen_TOK"
  check '     最后那条说的是 1 条帖子被下架（正面前提：内容确实到了）' '你的 1 条帖子' "$BODY"
  if [[ "$BODY" == *举报* ]]; then
    printf '  %sFAIL%s 小陈的通知里出现了「举报」字样，被举报人知道自己被举报了\n' "$RED" "$RESET"
    fail=$((fail+1))
  else
    printf '  %sPASS%s 小陈收到的通知里没有「举报」二字（他只看到帖子被下架）\n' "$GREEN" "$RESET"
    pass=$((pass+1))
  fi
fi

# ---------- 驳回分支：1 行留痕 + 照样回话 ----------
req POST "/api/admin/items/${M6_IDS[1]}/restore" "{\"reason\":\"$M6_RESTORE_REASON\"}" "$M6_ad_TOK"
check '#44 再恢复一条，用来走驳回分支 → HTTP 200' '200' "$STATUS"
req POST "/api/items/${M6_IDS[1]}/report" '{"reason_code":"other","detail":"看着不太对"}' "$M6_rep1_TOK"
check '#41 小张举报这条 → HTTP 200' '200' "$STATUS"
M6_RPT2="$(jval "$BODY" '"data":\{"id":([0-9]+)')"
req POST "/api/admin/reports/$M6_RPT2/resolve" "{\"resolution\":\"dismiss\",\"reason\":\"$M6_DISMISS_REASON\"}" "$M6_ad_TOK"
check '   选「驳回」→ HTTP 200，status=dismissed（不是 resolved）' '"status":"dismissed"' "$BODY"
check '⑥ 驳回只写 1 行留痕：report_resolved 现在 2 行' '2' "$(m6_log report_resolved)"
check '   item_takedown 没有跟着变成 3（驳回不动内容）' '2' "$(m6_log item_takedown)"
check '   帖子还是 open（驳回的结论是「没问题」）' 'open' "$(item_status "${M6_IDS[1]}")"
check '   举报人照样收到回执（哪怕结论是没采纳）' '2' "$(notif_type "$M6_rep1_ID" report_resolved)"
req GET '/api/my/notifications?page_size=100' '' "$M6_rep1_TOK"
check '     回执里那句结论是「未采纳」' '未采纳' "$BODY"
check '   被举报人一条都没多（驳回不发 admin_action）' '5' "$(notif_total "$M6_chen_ID")"

# ---------- #50 操作日志：风险 14 的唯一防线是事后可追责 ----------
req GET "/api/admin/actions?admin_id=$M6_ad_ID&page_size=100" '' "$M6_ad_TOK"
check '#50 台账页 → HTTP 200' '200' "$STATUS"
# 九个动作、九行留痕：下架 2（批量 + 连带）、恢复 2、封号 1、解封 1、警告 1、处置举报 2。
# ⚠ 这里带 admin_id 筛：admin_actions 是全库累积的，不带就是「本轮 + 上一轮 + 手工操作」。
check '   total=9，和 §12 那张「按动作数」的表一致' '"total":9' "$BODY"
for act in item_takedown item_restore user_ban user_unban warning_sent report_resolved; do
  req GET "/api/admin/actions?admin_id=$M6_ad_ID&action=$act&page_size=100" '' "$M6_ad_TOK"
  check "   ?action=$act 筛得出来（$(jval "$BODY" '"total":([0-9]+)') 行）" '"code":"OK"' "$BODY"
done
req GET "/api/admin/actions?admin_id=$M6_ad_ID&action=ghost" '' "$M6_ad_TOK"
check '   ?action= 传表外的值 → HTTP 400' '400' "$STATUS"
req GET "/api/admin/actions?page_size=100" '' "$M6_rep1_TOK"
check '   非 admin 看台账 → HTTP 403' '403' "$STATUS"

# ---------- §13 第 10 步：收尾自检（两条 SQL 都必须 0 行）----------
section "M6 收尾自检（§13 第 10 步，两条都必须 0 行）"

# ① 任何一行命中，都证明那条归还确认是在 service 层之外被写出来的（§3.4）。
# 这一条刻意**不带用户范围**：它查的是整库的历史账，包括前面几节（m5）留下的数据 ——
# 这正是它作为「收尾」自检的意义，也是它必须放在最后一节的原因。
check '① 没有一行 confirmed/rejected 的归还确认缺 review_kind' '0' \
  "$(db "SELECT count(*) FROM item_returns WHERE status IN ('confirmed','rejected') AND review_kind IS NULL")"

# ② 每一条 deleted 的帖子都能追溯到一次留痕。
# 计划里注明了这条在有「帖主自删」时会误报，所以这里把范围收到本节这四个用户名下：
# 本节里所有 deleted 都出自 #43 和 #49 的连带下架，一处误报都没有，「0 行」是硬判据。
check '② 本轮用户名下没有一条 deleted 的帖子查不到留痕' '0' \
  "$(db "SELECT count(*) FROM items i WHERE i.status='deleted'
          AND i.user_id IN ($M6_chen_ID,$M6_rep1_ID,$M6_rep2_ID,$M6_ad_ID)
          AND NOT EXISTS (
            SELECT 1 FROM admin_actions a
            WHERE a.target_type='item'
              AND (a.target_id=i.id OR a.detail->'ids' @> to_jsonb(i.id)))")"

# ③ 顺手把 §12 那条「留痕和业务改动同事务」再钉一次：admin 的每一次写都落在同一批里，
#    不存在「帖子删了但台账没写」的反向情况（它和 ② 是对称的两条路）。
check '③ 有留痕但没有对象的批量下架不存在（detail.ids 里每个 id 都能查到行）' '0' \
  "$(db "SELECT count(*) FROM admin_actions a
          WHERE a.admin_id=$M6_ad_ID AND a.action='item_takedown'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(a.detail->'ids') AS e(id)
              WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = (e.id)::bigint))")"

# ---------- #58 补：帖主自己删的那条，没有理由可给 ----------
#
# 这一段放在两条收尾自检**之后**，不是随手：它会新造一条 deleted 的帖子，
# 而自检② 「本轮用户名下每条 deleted 都要查得到留痕」对帖主自删天生误报
# （自删不写台账，那是他在处理自己的东西，不是被治理）。
# 所以要么让它最后跑，要么给自检 SQL 加例外 —— 后者是把产品判据改去迁就测试。
#
# 它测的是「查不到」和「不该查」的分界：如果实现是「凡是 deleted 就编一句解释」，
# 上面所有断言都还是绿的，而这里会红 —— 因为作者会看到一句系统自己造出来的话。
req POST /api/items "{\"item_type\":\"found\",\"title\":\"$M6_TAG self delete\",\"description\":\"$M6_TAG my own post\",\"category_id\":$M6_CAT,\"location_id\":$M6_LOC,\"found_at\":\"$M6_T_FOUND\",\"contact\":\"wx_m6_spam\"}" "$M6_chen_TOK"
M6_SELF="$(itemIDOf "$BODY")"
if [[ ! "$M6_SELF" =~ ^[0-9]+$ ]]; then
  printf '  %sFAIL%s 没能建出小陈自己那条待自删的帖（取到的 id 是 [%s]），#58 自删段测不了\n' "$RED" "$RESET" "$M6_SELF"
  fail=$((fail+1))
  return 0
fi
req DELETE "/api/items/$M6_SELF" '' "$M6_chen_TOK"
check '#18 帖主自删自己刚发的那条 → HTTP 200' '200' "$STATUS"
check '   库里是 deleted' 'deleted' "$(item_status "$M6_SELF")"
check_re '   没有为它写任何一行留痕（自删不是治理动作）' '^0$' \
  "$(db "SELECT count(*) FROM admin_actions a WHERE a.target_type='item'
          AND (a.target_id=$M6_SELF OR a.detail->'ids' @> to_jsonb(${M6_SELF}::bigint))")"
req GET "/api/items/$M6_SELF" '' "$M6_chen_TOK"
check_re '   #15 本人读得到这条（正面前提：响应是那条帖子本身，不是错误信封）' '"id":'"$M6_SELF" "$BODY"
check '   状态是 deleted' '"status":"deleted"' "$BODY"
check_re '   但 removal 一次都没出现（没有台账行，就没有可给的说法）' '^0$' "$(count_in_body '"removal":')"

printf '%s开发库里留下了本轮的治理冒烟数据（用户名都以 %s 开头，小陈名下 50 条帖、9 行留痕）。%s\n' \
  "$DIM" "$M6_TAG" "$RESET"
