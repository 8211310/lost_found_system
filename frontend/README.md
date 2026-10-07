# 前端（M7）

Vite + React 19 + TypeScript，样式是手写的 `src/index.css`，没有组件库、没有 Tailwind ——
计划里定的选型，为的是每个类名都能读、改起来不用学一套约定。

## 前提

后端跑在 `8080`（`backend/` 那条命令），PostgreSQL 已经起着。
`vite.config.ts` 把 `/api` 转发到 `http://localhost:8080`，因为**后端没有开 CORS** ——
浏览器直连 8080 会被同源策略挡掉，走 dev server 转发就没有这个问题。
也因此：`npm run dev` 起来之后访问 `http://localhost:5173`，不要访问 8080。

## 四条命令的分工

```bash
cd frontend
npm run dev         # 开发，改代码即时生效
npm test            # 单元测试（vitest + jsdom + msw 假后端），不联网
npm run build       # tsc -b 先做类型检查，再产出 dist/
npm run lint        # oxlint，只有警告、不拦提交
npm run check       # lint + test + build，一条跑完
```

`npm test` 用 msw 拦请求，所以后端不用开着。
`npm run test:live` 是另一件事：**打到真实的 8080**，验证 TS 类型和 Go 的 json tag 没跑偏。
它会往开发库里写数据（注册新用户、发帖、解锁、举报），跑完那些行就留在库里。
所以后端必须先起来，否则这一条会整片红 —— 那是真的连不上，不是代码坏了。

## 目录里最该先看的三个文件

- `src/api/types.ts` —— §4 那 50 条端点的响应形状，字段名和后端 json tag 一字不差。
- `src/api/contract.live.test.ts` / `contract.write.live.test.ts` —— 上面那条链路的判据。
- `src/pages/ItemDetailPage.tsx` —— 一个页面同时挂 #15 三态联系方式、#21 解锁、#20 匹配面板、#41 举报入口。

## 片的进度

| 片 | 内容 | 端点 |
| --- | --- | --- |
| 片 1 | 注册、登录、登录态恢复、改资料、改密码 | #1–#5 |
| 片 2 | 广场筛选与分页、详情、解锁联系方式、匹配 breakdown、弱举报 | #7 #8 #14 #15 #20 #21 #41 |
| 片 3 | 发布与编辑、图片上传 | #6 #13 #16 #17 #18 #42 |
| 片 4 | 我的：我的帖子、通知、认领名单、关闭/删除 | #19 #22 #23–#29 #30–#33 |
| 片 5 | admin 五个页签 | #34–#46 #48–#50 |
