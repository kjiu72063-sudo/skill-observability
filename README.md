# skill-observability

Agent Skill 合规可观测平台

## M2 看板走查

### 启动

```powershell
cd dashboard
npm install
npm run build
cd ..
$env:DEMO_PORT = "8010"
python demo.py
```

demo.py 会托管 dashboard/dist/ 并自动跑一遍客服场景。浏览器打开 http://127.0.0.1:8010/#/trace；若只做开发态联调，可在另一个终端运行 cd dashboard; $env:DEMO_PORT="8010"; npm run dev。

### 完整路径

1. 从 /#/trace 观察 Trace 生长，进入 /#/audit 使用全部、拦截、放行、观察期四段筛选。
2. 从审计行跳转 Trace，再从 Trace span 详情跳回审计行，核对双跳转闭环。
3. 进入 /#/rules 创建、编辑、toggle 或删除规则；保存成功后确认「规则已热生效」横幅。
4. 进入 /#/stats 查看 01 调用链、02 拦截、03 规则三组八卡；统计页是 REST 快照，不自动轮询。
5. 回车重跑场景后，手动刷新统计页，核对进行中 Trace、审计总数、拦截率、Top 命中规则和启用中规则的变化。

统计卡片不提供近 7 天窗口、导出、自动轮询或告警状态灯；各卡的数字来源以 policy-and-audit.md §3.3/§3.4 为准。
