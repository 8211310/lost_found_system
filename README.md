# 失物招领系统

杭电校园失物招领平台。同学自愿发布「我丢了什么」（lost）和「我捡到什么」（found），
平台负责**搜索、自动匹配、通知、记录**，双方通过帖子里的联系方式**自行线下沟通和归还**。

> 完整设计文档见 `C:\Users\TestUser\.qoder-cn\plans\patient-mountain-wolf.md`（第 6 版·定稿，16 节）。
> 这份 README 只讲**怎么跑起来**。设计上的「为什么」全在计划里，别在这里重复。

---

## 技术栈

| 项 | 选择 |
|---|---|
| 后端 | Go + Gin |
| 数据库 | PostgreSQL 16（Docker Compose） |
| 认证 | 本地账号密码（bcrypt + JWT）；杭电助手 OAuth2+PKCE 为 M8 待接入 |
| 前端 | React + Vite（M7 才创建） |
| 图片 | 存本地 `backend/uploads/`，DB 只存路径 |

---

## 目录结构

```
失物招领系统/
├── docs/                        # 杭电助手 SSO 调研文档（M8 的唯一权威依据，不要覆盖）
├── docker-compose.yml           # postgres + adminer，只跑这两个
├── scripts/smoke.sh             # Git Bash + curl 手工冒烟脚本
└── backend/
    ├── cmd/server/main.go       # 唯一入口，可通读
    ├── migrations/              # golang-migrate 迁移文件，程序启动时自动应用
    ├── uploads/                 # 图片（git 忽略，只留 .gitkeep）
    ├── smoketest/               # 端到端冒烟测试（需要真实测试库）
    └── internal/
        ├── config/              # .env → Config 结构体，无全局变量
        ├── database/            # pgxpool + 自动迁移 + SQL tracer
        ├── apperr/              # 错误码 + Error 类型 + 统一响应信封
        ├── middleware/          # RequestID、访问日志、panic 恢复
        ├── handler/             # HTTP 层：只做翻译，不写 SQL、不写业务 if
        ├── service/             # 业务规则（M2 起）
        ├── repo/                # 所有 SQL 只出现在这一层（M2 起）
        ├── matcher/             # 匹配算法，纯函数（M3 起）
        ├── auth/                # Provider 接口 + local + hduhelp（M1 起）
        └── router/              # 全部路由注册在这一个文件
```

**分层规则（只有三层）**：`handler` → `service` → `repo`。
依赖全部在 `main.go` 里手工按顺序 new，**不用 wire/fx** —— 生成代码和隐式魔法对初学者是调试黑洞。

---

## 跑起来

### 1. 起数据库

两条路，选一条。**本机走 B**（Docker daemon 起不来，见下面「常见坑」）。

#### 路径 A：Docker Compose（计划 §11 定的方案）

```bash
docker compose up -d
```

会拉起两个容器：

| 服务 | 端口 | 用途 |
|---|---|---|
| `postgres:16-alpine` | 5432 | 数据库，账号密码都是 `lf`，库名 `lostfound` |
| `adminer:latest` | 8081 | 浏览器里的数据库管理界面 |

**Adminer 是看表、改数据、试 SQL 的主工具。** 打开 <http://localhost:8081>，登录时：

- 系统：PostgreSQL
- 服务器：**`postgres`**（⚠ 不是 `localhost` —— Adminer 在容器里，`localhost` 指的是它自己）
- 用户名 `lf` / 密码 `lf` / 数据库 `lostfound`

#### 路径 B：原生 Windows PostgreSQL（本机在用）

```bash
scoop install postgresql        # PG 18.6，用户级安装，不需要管理员权限
bash scripts/setup-postgres.sh  # 建 lf 角色 + lostfound 库，并预检 pg_trgm
```

原生包只带一个 `postgres` 超级用户、空密码，而 `.env` 和 compose 用的都是 `lf/lf/lostfound`
这套约定。`setup-postgres.sh` 负责把两边对齐，**幂等，重复跑没副作用**。它同时会：

- `pg_ctl start` 起服务（不需要注册 Windows 服务，也就不需要管理员权限）
- 建 `lf` 角色，给 `SUPERUSER`（迁移第一句 `CREATE EXTENSION pg_trgm` 要用）
  和 `CREATEDB`（测试代码要 `CREATE DATABASE lostfound_test`）
- **预检 `pg_trgm` 是否随包提供** —— 这是 PG 18 原生包和 `postgres:16-alpine` 之间
  唯一的真实差异点，缺了的话中文子串搜索的 GIN 索引建不出来

图形界面用**自带的 pgAdmin 4**（开始菜单搜 pgAdmin），它承担的就是计划里 Adminer 的角色。
第一次打开要设一个 pgAdmin 自己的主密码（和数据库无关），然后 Register → Server：
Host 填 **`127.0.0.1`**（不是 `postgres`，那是 compose 里的服务名，只在容器网络里有意义），
用户名 `lf`，密码 `lf`。

停 / 起服务：

```bash
pg_ctl stop                                        # PGDATA 已在环境变量里
pg_ctl -l "$PGDATA/postgres.log" start
```

> **PG 18 而不是 16，有影响吗？** 没有。本项目用到的全是标准特性：`BIGSERIAL`、
> `timestamptz`、`CHECK` 约束、部分唯一索引、`JSONB`、`GIN + gin_trgm_ops`、自引用外键、`setval`。
> `docker-compose.yml` 保留在仓库里，换到有 Docker 的机器上直接可用。

### 2. 配环境变量

```bash
cd backend
cp .env.example .env
```

然后编辑 `.env`，**只需要填一个东西**：

```
JWT_SECRET=<一串随机字符>
```

Git Bash 里生成：

```bash
openssl rand -hex 32
```

`JWT_SECRET` 必填且没有默认值 —— 给个默认值等于给所有部署实例同一把钥匙。
缺了程序会立刻 fatal 并打印缺哪个变量，不会带着半残的配置继续跑。

`.env` 已在 `.gitignore` 里，不会被提交。

### 3. 起后端

```bash
go run ./cmd/server
```

启动时会**自动把数据库迁移到最新版本**（`internal/database` 用 golang-migrate 库 + `//go:embed`
把 `migrations/*.sql` 编进二进制）。所以这一条命令同时完成了建表 + 种子数据 + 起服务，
**本机不需要装 psql、createdb 或任何迁移工具**。

看到 `server.listening` 就成了。验证：

```bash
curl localhost:8080/api/health
# {"code":"OK","message":"ok","data":{"status":"ok","db":"ok",...},"request_id":"..."}
```

### 4. 跑测试

```bash
cd backend

# 纯单元测试（不需要数据库，任何机器上都能跑）
go test ./internal/...

# 集成测试（需要数据库）
TEST_DB_DSN="postgres://lf:lf@127.0.0.1:5432/postgres?sslmode=disable" \
REQUIRE_INTEGRATION=1 go test ./...
```

⚠ 用 `127.0.0.1` 而不是 `localhost`：Windows 上 `localhost` 可能先解析成 IPv6 的 `::1`，
而 PostgreSQL 不一定在监听它，报出来的错会很难往这上面想。

`TEST_DB_DSN` 指向**默认库 `postgres`**，测试代码会自己 `CREATE DATABASE lostfound_test`
（用 Go 代码建库，绕开本机没有 createdb），然后迁移 + `TRUNCATE`，测试之间零串扰。

⚠ **`REQUIRE_INTEGRATION=1` 的意义**：`TEST_DB_DSN` 为空时集成测试会打印醒目 banner 并**跳过**，
这样 `go test ./...` 在任何机器上都不会红。但「全绿」可能意味着一条集成测试都没跑 ——
所以最终验收必须带这个变量，带了之后「DSN 为空」就直接算**失败**，不是跳过。

### 5. 手工冒烟

后端跑着的时候，另开一个终端：

```bash
bash scripts/smoke.sh
```

它用 curl 打一遍全链路，只断言 `code` 字段，**从不断言 message 文本**
（message 是给人看的中文，随时可改；code 是稳定的机器码，永不改语义）。

---

## 调试

### 结构化日志

`LOG_LEVEL=debug` 重启，每条请求日志都带 `request_id`，且能看到 SQL 语句、参数、耗时、影响行数：

```json
{"time":"...","level":"DEBUG","msg":"sql.query","request_id":"20261007-3f2a...","sql":"SELECT ...","args":[7],"command_tag":"SELECT 1","rows":1,"duration_ms":2}
```

**报 bug 时给一个 `request_id`，就能在日志里捞出完整链路。** 这是整套日志设计的全部目的。

日志字段固定为：`time, level, msg, request_id, user_id, method, path, status, duration_ms, err`。

### 其他调试入口

| 入口 | 用途 |
|---|---|
| `GET /api/health` | 服务和数据库是否活着 |
| `GET /api/debug/config` | 当前生效的配置（仅 `ENV=dev` + admin，敏感值打码）（M6） |
| `GET /api/items/:id/matches` 的 `breakdown` | 匹配调试器：每个信号的分数和权重都能验算（M3） |
| Adminer <http://localhost:8081>（路径 A）<br>pgAdmin 4（路径 B，开始菜单搜）<br>`psql -h 127.0.0.1 -U lf -d lostfound` | 直接看表、改数据、试 SQL |

> 计划 §13 的验收步骤写的是「在 Adminer 里跑 SQL」，指的其实就是这一行里的任意一个 ——
> 关键是**能手工执行 SQL 并看到结果**，用哪个工具无所谓。

### 错误响应

所有 JSON 响应都是同一个信封：

```json
{"code": "OK", "message": "ok", "data": { ... }, "request_id": "20261007-3f2a..."}
```

`code` 是稳定的机器码（定义在 `internal/apperr/codes.go`），`message` 是给人看的中文。
**前端和测试只允许 match `code`。** 未预期的错误一律返回 `INTERNAL`，原始错误只进日志、
不进响应体 —— 因为 pgx 的错误信息里可能带 SQL 片段和连接串。

---

## 迁移纪律

**已发布的迁移文件永远不改内容，只加新序号文件。**

`migrations/` 下是 `000001_xxx.up.sql` / `.down.sql`。改了已发布的文件会让
`schema_migrations` 里的校验和对不上，之后所有环境都迁移不了。

要回退（⚠ 会删数据）：`internal/database` 里有 `MigrateDown`，但 `main.go` **从不调用它** ——
它只给测试和「开发库被搞坏了」这种情况用。

---

## 当前进度

- **M0 地基 —— 已完成并验收（2026-10-07）**
  骨架、docker-compose、config、pgxpool、自动迁移、slog、RequestID/访问日志/恢复
  中间件、apperr + 信封、`/api/health`、路由注册测试。
  验收实测：迁移 version 1；12 张业务表 + `schema_migrations`；`categories` 55 行、
  `locations` 91 行；`pg_trgm` 1.6 + 13 个索引；`/api/health` 返回 `"code":"OK"`
  且 `"db":"ok"`；集成测试 18 项全绿、`scripts/smoke.sh` 16 项全绿。
- **M1 认证 —— 已完成并验收（2026-10-07）**
  §4 的 #1–#5 五个端点（注册 / 登录 / `GET,PUT /api/auth/me` / 改密码）、
  `model.User` + `repo.User`、`internal/auth`（Provider 接缝 + bcrypt 密码策略 +
  HS256 TokenSigner）、`middleware.JWT`（每请求回库读 role/status，封号即时生效）。
  验收实测：路由 6 条；纯单测（不连库）auth 59 + middleware 15 + router 7 +
  service 49 = 130 项全绿；集成测试 66 项全绿（含 M0 的 18 项）；
  `scripts/smoke.sh` **60 项全绿、0 跳过**，打的是真 dev server + 真开发库。
  判据链逐条走通：注册 → 登录 → 带 token 访问
  `/api/auth/me` → 错 token 得 `UNAUTHORIZED` → 重名得 `USER_ALREADY_EXISTS`
  → 弱密码得 `WEAK_PASSWORD` → banned 用户登录得 `USER_BANNED`；
  `fakeProvider` 注入单测证明「JWT 签发与 Provider 无关」。
  另外实测了两条安全性质：账号枚举的**计时**侧信道已抹平（用户名不存在 48.0ms
  vs 密码错 48.0ms，靠 dummy bcrypt 比对补齐），**响应与日志**两条路径也同形
  （同 code、同 message、访问日志里同样不带 `err` 字段）。
- **未开工**：M2 字典·物品·上传 · M3 匹配 · M4 解锁·通知·举报 ·
  M5 归还确认·积分 · M6 治理与管理后台 · M7 前端 · M8 杭电助手 SSO（外部阻塞中）

路由清单见 `internal/router/router.go` —— 那是 §4 全部 50 条路由的唯一注册点，
每个里程碑的占位注释都标了对应的端点编号。

---

## 常见坑

**`proxy.golang.org` 连不上。** 国内网络环境常见，报
`dial tcp ...: connectex: A connection attempt failed`。设成 goproxy：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
```

**`docker compose up -d` 起不来。** 需要 Docker Desktop 或可用的 WSL2 发行版在跑。
`docker version` 只输出 Client 段、并报
`failed to connect to the docker API at npipe:////./pipe/docker_engine`，说明 daemon 没起来。
**本机就是这个状态**：装了 docker CLI 29.3.0（scoop），但没有 Docker Desktop，
`wsl -l -v` 也显示没有任何发行版，所以 daemon 无处可跑 —— 因此走上面的路径 B。

**Adminer / pgAdmin 连不上数据库。** 两边要填的 host 不一样，这是最容易搞混的一点：

| 工具 | Host 填 | 为什么 |
|---|---|---|
| Adminer（路径 A） | `postgres` | Adminer 自己在容器里，`localhost` 指的是它自己；`postgres` 是 compose 的服务名 |
| pgAdmin 4（路径 B） | `127.0.0.1` | pgAdmin 跑在 Windows 上，直接连本机端口 |

**scoop 装完东西，当前终端里找不到命令。** scoop 改的是**用户环境变量**，
只对「安装之后新开的终端」生效。装完 `postgresql` 却发现没有 `pg_ctl`，
关掉终端重开一个就行，不用怀疑安装失败。

**Git Bash 里用 curl 发中文，服务端收到的是问号。** 这条坑长得很像后端编码坏了，
所以值得单写一段。现象：

```bash
curl -X POST .../api/auth/register -d '{"nickname":"冒烟"}'   # 库里存成了 "??"
```

原因不在后端，也不在 curl，而在 **Git Bash 把参数交给 Windows 原生 exe 的那一刻**：
argv 要按当前代码页转换一次，本机是 `cp1252`，汉字不在里面，于是每个字变成一个 `?`。
请求在离开 shell 时就已经烂了。

改成从 stdin 喂给 curl 就没事了 —— 管道里的字节由 bash 直接写，不经过这次转换：

```bash
printf '%s' '{"nickname":"冒烟"}' | curl -X POST .../api/auth/register --data-binary @-
```

`scripts/smoke.sh` 里的 `req()` 函数统一走 stdin，就是这个原因。
以后手写 curl 命令测中文时记得这一点，否则会误判成「后端不支持 UTF-8」。
顺带一个判据：**响应里的**中文一直是好的（stdout 不做这次转换），
所以「发出去变问号、收回来正常」这个组合就是 argv 的锅，不是数据库编码的锅。

**Go 版本是 1.26.0，计划 §1.2 写的是 1.25.4。** 这是 `GOTOOLCHAIN=auto` 的正常行为：
scoop 装的是 go 1.25.4，但依赖里 `golang.org/x/text v0.42.0` 要求 `go >= 1.26.0`，
于是 Go 自己下载了 1.26.0 的工具链来编译。`go.mod` 里因此写的是 `go 1.26.0`。
**不要「修回」1.25.4**，会直接编译失败。

**`CREATE EXTENSION pg_trgm` 报权限不足。** 两条路径建出来的 `lf` 都是超级用户，正常情况下不会遇到。
`scripts/setup-postgres.sh` 会在建库之前先查 `pg_available_extensions`，扩展不存在就提前报错退出。
将来换托管库受限时，退路是去掉 trgm 索引，`ILIKE` 在小数据量下依然可用（只是慢）。
