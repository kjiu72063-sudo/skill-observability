/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// M2-02（#17）工程约定一次到位：
// - 开发态 dev server 跑在 5173，/api 代理到 FastAPI——同源开发，fetch 基座不用管跨域
// - 代理目标跟 demo.py 同一个 DEMO_PORT 约定（默认 8000）；8000 被占时
//   `DEMO_PORT=8010 python demo.py` + `DEMO_PORT=8010 npm run dev` 成对换端口
// - 构建产物 dist/ 由 demo.py 的 StaticFiles 托管（挂载在 demo 装配层，不进 create_app）
const apiTarget = `http://127.0.0.1:${process.env.DEMO_PORT ?? 8000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
  },
});
