import { useEffect, useState } from "react";

// React 消费 SSE 的全部成本 = useEffect + EventSource:
// 无第三方库, 组件卸载时 es.close() 断开即可。
export default function App() {
  const [status, setStatus] = useState("connecting…");
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setStatus("connected (SSE)");
    es.onerror = () => setStatus("disconnected (自动重连中)");
    es.addEventListener("trace", (e) => {
      const evt = JSON.parse(e.data);
      setEvents((prev) => [...prev, evt]);
    });
    return () => es.close();
  }, []);

  const ok = status.startsWith("connected");
  return (
    <div style={{ margin: "2rem", fontFamily: "system-ui" }}>
      <h1>skill-observability · stack-spike (React + Vite)</h1>
      <p>
        SSE 连接状态:{" "}
        <span
          style={{
            padding: "0.2rem 0.5rem",
            borderRadius: 4,
            background: ok ? "#d1fae5" : "#fee2e2",
            color: ok ? "#065f46" : "#991b1b",
          }}
        >
          {status}
        </span>
      </p>
      <ol>
        {events.map((evt) => (
          <li key={evt.id} style={{ fontFamily: "monospace", fontSize: 13 }}>
            #{evt.id} [{evt.kind}] {JSON.stringify(evt.payload)}
          </li>
        ))}
      </ol>
    </div>
  );
}
