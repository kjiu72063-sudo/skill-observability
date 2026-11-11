# skill-observability

Agent Skill 合规可观测平台

## 快速开始

```bash
# 后端演示（起 API/SSE + 自动跑一遍客服场景三拍；进程不退出，回车重跑）
pip install -r requirements.txt
python demo.py

# 看板页面（M2 起内嵌于同一服务）：构建一次后由 demo.py 静态托管
# （Node >= 20；浏览器开 http://127.0.0.1:8000/ 即壳页）
cd dashboard && npm install && npm run build

# 看板开发态（改前端热更新；/api 自动代理到 FastAPI，端口跟 DEMO_PORT 约定）
cd dashboard && npm run dev
```
