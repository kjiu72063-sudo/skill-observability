"""SQLite 存储层：五表 DDL + 播种 + 查询。

DDL 逐字取自两份契约：
- ``docs/contracts/trace-data-model.md`` §1.2 span / §1.3 event_log
- ``docs/contracts/policy-and-audit.md`` §2 rule / meta、§3.1 audit

并发模型（#8 决议 4「agent 与 FastAPI 同进程、共用实例」）：demo 场景跑在主线程、
uvicorn 事件循环跑在后台线程，共用一个 ``sqlite3`` 连接
（``check_same_thread=False``），所有读写经同一把 ``RLock`` 串行——
演示规模下最简的正确解。写入者唯一（SDK 拦截点），查询 API 只读。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

# ---------------------------------------------------------------- DDL（契约原文）

_SPAN_DDL = """
CREATE TABLE span (
  trace_id             TEXT NOT NULL
                       CHECK (length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*'),
  span_id              TEXT PRIMARY KEY
                       CHECK (length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*'),
  parent_span_id       TEXT,                        -- NULL = 根 span
  name                 TEXT NOT NULL,               -- 低基数类别级，规则见 §3.3
  kind                 TEXT NOT NULL DEFAULT 'INTERNAL'
                       CHECK (kind IN ('INTERNAL','SERVER','CLIENT','PRODUCER','CONSUMER')),
  start_time_unix_nano INTEGER NOT NULL,
  end_time_unix_nano   INTEGER,                     -- NULL = 进行中
  status_code          TEXT NOT NULL DEFAULT 'UNSET'
                       CHECK (status_code IN ('UNSET','OK','ERROR')),
  status_message       TEXT,                        -- 仅 ERROR 时有值
  attributes           TEXT NOT NULL DEFAULT '{}',  -- JSON 对象
  events               TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  agent_id             TEXT NOT NULL,               -- 本项目自定义列（≈ OTel Resource 拍平）
  CHECK (end_time_unix_nano IS NULL
         OR end_time_unix_nano >= start_time_unix_nano)
);
CREATE INDEX idx_span_trace       ON span (trace_id);
CREATE INDEX idx_span_agent_start ON span (agent_id, start_time_unix_nano);
"""

_EVENT_LOG_DDL = """
CREATE TABLE event_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,  -- 即 SSE 的 event id（Last-Event-ID 键）
  kind    TEXT NOT NULL CHECK (kind IN ('span.start','span.end')),
  ts      INTEGER NOT NULL,                   -- unix nano，调试/排序辅助
  payload TEXT NOT NULL                       -- 发出时的 JSON 快照，原样重放
);
"""

_RULE_META_DDL = """
CREATE TABLE rule (
  id            TEXT PRIMARY KEY,   -- 完整 slug 校验在 API 层（422），DDL 只做粗检
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('pii','dangerous_command','tool_denylist','custom')),
  action        TEXT NOT NULL CHECK (action IN ('block','audit')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  priority      INTEGER NOT NULL DEFAULT 100,
  agent_ids     TEXT,               -- JSON 数组或 NULL
  tool_names    TEXT,               -- JSON 数组或 NULL
  args_regex    TEXT,               -- JSON 对象或 NULL
  description   TEXT,
  created_at_unix_nano  INTEGER NOT NULL,
  updated_at_unix_nano  INTEGER NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- key='rules_version'，value=递增整数
"""

_AUDIT_DDL = """
CREATE TABLE audit (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id              TEXT NOT NULL,   -- 32 hex，逻辑引用（trace 契约 §4，无 FK）
  span_id               TEXT NOT NULL,   -- 16 hex
  agent_id              TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  verdict               TEXT NOT NULL CHECK (verdict IN ('allow','block')),
  rule_id               TEXT,            -- 命中规则 id（含 audit 动作命中）；NULL = 未命中任何规则
  rule_name             TEXT,            -- 冗余快照：规则改名/删除后审计仍可读
  action                TEXT CHECK (action IN ('block','audit')),  -- 命中规则的动作
  reason                TEXT,
  payload               TEXT NOT NULL,   -- args JSON 快照（ensure_ascii=False）
  payload_truncated     INTEGER NOT NULL DEFAULT 0,
  created_at_unix_nano  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit (created_at_unix_nano);
CREATE INDEX idx_audit_verdict ON audit (verdict, created_at_unix_nano);
CREATE INDEX idx_audit_trace   ON audit (trace_id);
CREATE INDEX idx_audit_rule    ON audit (rule_id);
"""

_SPAN_COLUMNS = (
    "trace_id", "span_id", "parent_span_id", "name", "kind",
    "start_time_unix_nano", "end_time_unix_nano", "status_code",
    "status_message", "attributes", "events", "agent_id",
)


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


class Storage:
    """五表存储 + 幂等播种 + 查询。单连接单锁，见模块 docstring。"""

    def __init__(self, db_path: str | Any):
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SPAN_DDL)
            self._conn.executescript(_EVENT_LOG_DDL)
            self._conn.executescript(_RULE_META_DDL)
            self._conn.executescript(_AUDIT_DDL)
            self._conn.commit()

    # ---------------------------------------------------------------- 播种（policy §1.6）

    def seed_rules_if_empty(self, rules: list[dict], now_unix_nano: int) -> int:
        """rule 表为空 → 播种并置 rules_version=1；非空即跳过（幂等）。返回播种条数。"""
        with self._lock:
            n = self._conn.execute("SELECT COUNT(*) AS c FROM rule").fetchone()["c"]
            if n:
                return 0
            for r in rules:
                self._conn.execute(
                    "INSERT INTO rule (id, name, category, action, enabled, priority,"
                    " agent_ids, tool_names, args_regex, description,"
                    " created_at_unix_nano, updated_at_unix_nano)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        r["id"], r["name"], r["category"], r["action"],
                        1 if r.get("enabled", True) else 0,
                        r.get("priority", 100),
                        _json_dumps(r["agent_ids"]) if r.get("agent_ids") is not None else None,
                        _json_dumps(r["tool_names"]) if r.get("tool_names") is not None else None,
                        _json_dumps(r["args_regex"]) if r.get("args_regex") is not None else None,
                        r.get("description"),
                        now_unix_nano, now_unix_nano,
                    ),
                )
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('rules_version', '1')"
            )
            self._conn.commit()
            return len(rules)

    def get_rules_version(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = 'rules_version'"
            ).fetchone()
            return int(row["value"]) if row else 0

    def load_rule_rows(self) -> list[dict]:
        """引擎快照加载用：解析 JSON 列后的原始规则行。"""
        with self._lock:
            rows = self._conn.execute("SELECT * FROM rule ORDER BY priority, id").fetchall()
        out = []
        for row in rows:
            out.append({
                "id": row["id"],
                "name": row["name"],
                "category": row["category"],
                "action": row["action"],
                "enabled": bool(row["enabled"]),
                "priority": row["priority"],
                "agent_ids": json.loads(row["agent_ids"]) if row["agent_ids"] else None,
                "tool_names": json.loads(row["tool_names"]) if row["tool_names"] else None,
                "args_regex": json.loads(row["args_regex"]) if row["args_regex"] else None,
                "description": row["description"],
            })
        return out

    # ---------------------------------------------------------------- SDK 写路径（唯一写入者）

    def start_span(
        self, trace_id: str, span_id: str, parent_span_id: str | None,
        name: str, kind: str, start_time_unix_nano: int,
        attributes: dict, agent_id: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO span (trace_id, span_id, parent_span_id, name, kind,"
                " start_time_unix_nano, attributes, agent_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (trace_id, span_id, parent_span_id, name, kind,
                 start_time_unix_nano, _json_dumps(attributes), agent_id),
            )
            self._conn.commit()

    def end_span(
        self, span_id: str, end_time_unix_nano: int, status_code: str,
        status_message: str | None, attributes: dict, events: list[dict],
    ) -> dict:
        """UPDATE 补时长与状态（契约 §1.2），返回 end 后整行（JSON 列已解析）供 span.end 快照。"""
        with self._lock:
            self._conn.execute(
                "UPDATE span SET end_time_unix_nano = ?, status_code = ?,"
                " status_message = ?, attributes = ?, events = ? WHERE span_id = ?",
                (end_time_unix_nano, status_code, status_message,
                 _json_dumps(attributes), _json_dumps(events), span_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                f"SELECT {', '.join(_SPAN_COLUMNS)} FROM span WHERE span_id = ?",
                (span_id,),
            ).fetchone()
        return self._span_row_to_dict(row)

    def insert_event(self, kind: str, ts_unix_nano: int, payload_json: str) -> int:
        """event_log 落库，返回自增 id（= SSE 的 event id，契约 §1.3）。"""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO event_log (kind, ts, payload) VALUES (?, ?, ?)",
                (kind, ts_unix_nano, payload_json),
            )
            self._conn.commit()
            return cur.lastrowid

    def insert_audit(
        self, trace_id: str, span_id: str, agent_id: str, tool_name: str,
        verdict: str, rule_id: str | None, rule_name: str | None,
        action: str | None, reason: str | None, payload_json: str,
        payload_truncated: bool, created_at_unix_nano: int,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO audit (trace_id, span_id, agent_id, tool_name, verdict,"
                " rule_id, rule_name, action, reason, payload, payload_truncated,"
                " created_at_unix_nano)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (trace_id, span_id, agent_id, tool_name, verdict, rule_id,
                 rule_name, action, reason, payload_json,
                 1 if payload_truncated else 0, created_at_unix_nano),
            )
            self._conn.commit()
            return cur.lastrowid

    def replay_events(self, after_id: int = 0) -> list[dict]:
        """SSE 回放源：id 升序的 (id, kind, payload) 原样快照（契约 §3.1）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, kind, payload FROM event_log WHERE id > ? ORDER BY id",
                (after_id,),
            ).fetchall()
        return [{"id": r["id"], "kind": r["kind"], "payload": r["payload"]} for r in rows]

    # ---------------------------------------------------------------- 查询 API（trace §2、policy §3.2）

    def list_traces(
        self, agent_id: str | None, from_ns: int | None, to_ns: int | None,
        page: int, page_size: int,
    ) -> tuple[list[dict], int]:
        where = ["s.parent_span_id IS NULL"]
        params: list[Any] = []
        if agent_id is not None:
            where.append("s.agent_id = ?")
            params.append(agent_id)
        if from_ns is not None:
            where.append("s.start_time_unix_nano >= ?")
            params.append(from_ns)
        if to_ns is not None:
            where.append("s.start_time_unix_nano <= ?")
            params.append(to_ns)
        where_sql = " AND ".join(where)
        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) AS c FROM span s WHERE {where_sql}", params
            ).fetchone()["c"]
            rows = self._conn.execute(
                "SELECT s.trace_id, s.name, s.agent_id, s.start_time_unix_nano,"
                " s.end_time_unix_nano, s.status_code,"
                " (SELECT COUNT(*) FROM span c WHERE c.trace_id = s.trace_id) AS span_count,"
                " EXISTS(SELECT 1 FROM span b WHERE b.trace_id = s.trace_id"
                "        AND json_extract(b.attributes, '$.\"skill_observability.verdict\"')"
                "            = 'block')"
                "   AS blocked"
                f" FROM span s WHERE {where_sql}"
                " ORDER BY s.start_time_unix_nano DESC LIMIT ? OFFSET ?",
                [*params, page_size, (page - 1) * page_size],
            ).fetchall()
        items = [
            {
                "trace_id": r["trace_id"],
                "name": r["name"],
                "agent_id": r["agent_id"],
                "start_time_unix_nano": r["start_time_unix_nano"],
                "end_time_unix_nano": r["end_time_unix_nano"],
                "status_code": r["status_code"],
                "span_count": r["span_count"],
                "blocked": bool(r["blocked"]),
            }
            for r in rows
        ]
        return items, total

    def get_trace_spans(self, trace_id: str) -> list[dict] | None:
        """trace 详情：平铺数组按 start 升序（契约 §2.2）；trace 不存在 → None。"""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {', '.join(_SPAN_COLUMNS)} FROM span WHERE trace_id = ?"
                " ORDER BY start_time_unix_nano ASC",
                (trace_id,),
            ).fetchall()
        if not rows:
            return None
        return [self._span_row_to_dict(r) for r in rows]

    def list_audits(
        self, verdict: str | None, agent_id: str | None, tool_name: str | None,
        rule_id: str | None, from_ns: int | None, to_ns: int | None,
        page: int, page_size: int, action: str | None = None,
    ) -> tuple[list[dict], int]:
        where: list[str] = []
        params: list[Any] = []
        if verdict is not None:
            where.append("verdict = ?")
            params.append(verdict)
        if action is not None:
            # 契约 policy §3.2：#22 新增参数。action=audit ≙ 观察期命中口径
            # （verdict='allow' AND action='audit'，与 §3.4 卡 5 同源）；action=block
            # 的行本就必须 verdict=block。未命中行 action 为 NULL，两个值都不匹配。
            where.append("action = ?")
            params.append(action)
            if action == "audit":
                where.append("verdict = 'allow'")
        if agent_id is not None:
            where.append("agent_id = ?")
            params.append(agent_id)
        if tool_name is not None:
            where.append("tool_name = ?")
            params.append(tool_name)
        if rule_id is not None:
            where.append("rule_id = ?")
            params.append(rule_id)
        if from_ns is not None:
            where.append("created_at_unix_nano >= ?")
            params.append(from_ns)
        if to_ns is not None:
            where.append("created_at_unix_nano <= ?")
            params.append(to_ns)
        where_sql = " AND ".join(where) if where else "1=1"
        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) AS c FROM audit WHERE {where_sql}", params
            ).fetchone()["c"]
            rows = self._conn.execute(
                f"SELECT * FROM audit WHERE {where_sql}"
                " ORDER BY created_at_unix_nano DESC, id DESC LIMIT ? OFFSET ?",
                [*params, page_size, (page - 1) * page_size],
            ).fetchall()
        items = []
        for r in rows:
            items.append({
                "id": r["id"],
                "trace_id": r["trace_id"],
                "span_id": r["span_id"],
                "agent_id": r["agent_id"],
                "tool_name": r["tool_name"],
                "verdict": r["verdict"],
                "rule_id": r["rule_id"],
                "rule_name": r["rule_name"],
                "action": r["action"],
                "reason": r["reason"],
                "payload": json.loads(r["payload"]),
                "payload_truncated": bool(r["payload_truncated"]),
                "created_at_unix_nano": r["created_at_unix_nano"],
            })
        return items, total

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _span_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "trace_id": row["trace_id"],
            "span_id": row["span_id"],
            "parent_span_id": row["parent_span_id"],
            "name": row["name"],
            "kind": row["kind"],
            "start_time_unix_nano": row["start_time_unix_nano"],
            "end_time_unix_nano": row["end_time_unix_nano"],
            "status_code": row["status_code"],
            "status_message": row["status_message"],
            "attributes": json.loads(row["attributes"]),
            "events": json.loads(row["events"]),
            "agent_id": row["agent_id"],
        }
