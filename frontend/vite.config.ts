import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 后端在 8080，但 backend/ 里没有任何 CORS 中间件（grep -rn -i "cors|origin" 零命中），
// 所以 5173 直连 8080 会被浏览器同源策略全部拦掉。这里用 dev proxy 把两个前缀转过去，
// 前端代码里因此一律写相对路径（/api/... 和 /uploads/...），一个端口号都不出现。
const BACKEND = 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/uploads': { target: BACKEND, changeOrigin: true },
    },
  },
  test: {
    // 测试里组件走的是 src/api/client.ts 那个模块级单例 http，它的 baseURL 默认是 '/'。
    // '/' 在生产和本机 dev 都对（dev 有上面的 proxy），但在 jsdom 里会被解析成
    // http://localhost:3000，而 MSW 的 handler 一律注册在 BASE=http://backend.test 上，
    // 于是每一个请求都变成「no matching handler」。这里把单例的 baseURL 钉到同一个 origin，
    // 测试文件就只需要关心路径，不用各写各的绝对地址。
    env: { VITE_API_BASE: 'http://backend.test' },
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // *.live.test.ts 需要打通着的真实后端，不属于 npm test 的默认范围（用 npm run test:live）。
    // 这条排除**写在 package.json 的 test 脚本里**，不能写在这里：
    // vitest 的 CLI 只有 `--exclude`（追加），没有任何「覆盖/取消 config 里的 exclude」的选项，
    // 写在这里就会让 test:live 变成「No test files found, exiting with code 1」。
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
