import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发期(可选)双进程模式: vite dev server 把 /api 代理到 uvicorn 8000。
// 演示/交付路径不用 dev server: npm run build 后由 FastAPI 托管 dist/。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
