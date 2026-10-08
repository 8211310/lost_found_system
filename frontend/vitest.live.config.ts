import { defineConfig } from 'vitest/config'

// npm run test:live 专用配置。存在的理由不是「换个 include」，而是 **不能带 setupFiles**：
// 基础配置里的 src/test/setup.ts 会启动 MSW 并接管这个 worker 的所有网络请求，
// 于是 contract.live.test.ts 发给真实 8080 的请求会被 MSW 当成「没有 handler 的请求」拦掉，
// 表现为 NETWORK_ERROR —— 一个「后端明明在跑却连不上」的假故障。
// 这份配置里没有 setupFiles，也就没有 MSW，请求是真的出网。
export default defineConfig({
  test: {
    // node 而不是 jsdom：这里测的是 HTTP 契约，不该有 DOM。
    // 顺带也验证了 client.ts 在无浏览器环境下能跑（session.ts 的内存兜底那条路径）。
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    // 七个文件打的是**同一个开发库**，所以必须串行。有一条判据就是这么红的：
    // contract.admin.live 里那条「读完四条只读端点，留痕总数一点没变」，
    // 并行时会被 contract.dict.live 那两条写字典（各留一行 admin_actions）踩过去，
    // 报出「112 != 110」—— 后端没错，是两个文件在同一张表上互相 interference。
    // 同理还有统计里的那些计数。串行跑完全程也就几秒，不值得为它冒假红的险。
    fileParallelism: false,
  },
})
