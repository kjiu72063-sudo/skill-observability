/**
 * 纳秒无损解析自证单测（M2-02 #17 验收第 4 条）：
 * 伪造含 19 位纳秒时间戳的响应文本，解析后该字段必须是字符串且值无损。
 * 这是全段地基（M2-12 八卡统计精度全压在这）——红线用例，改动 losslessJson.ts 必跑。
 */

import { describe, expect, it } from "vitest";

import { parseLossless } from "./losslessJson";

// 19 位纳秒时间戳（2026 年附近，超过 2^53 = 9007199254740992，16 位即超）
const NANO_19 = "1765459200123456789";
// 对应秒级（10 位）——常规 number 无损，作为对照
const SEC_10 = 1765459200;

describe("parseLossless：纳秒字符串承载（#2 决议红线）", () => {
  it("19 位纳秒时间戳解析后为字符串且逐位无损", () => {
    const body = `{"start_time_unix_nano": ${NANO_19}, "end_time_unix_nano": null}`;
    const parsed = parseLossless(body);
    expect(typeof parsed.start_time_unix_nano).toBe("string");
    expect(parsed.start_time_unix_nano).toBe(NANO_19);
    // 对照：常规 JSON.parse 已丢精度——parse 结果转回字符串 ≠ 原串（尾数舍入 789→800）
    const lossy = JSON.parse(body) as Record<string, unknown>;
    expect(String(lossy.start_time_unix_nano)).not.toBe(NANO_19);
    expect(Number.isSafeInteger(Number(NANO_19))).toBe(false); // 19 位确超安全范围
  });

  it("同对象内小数值字段不受牵连，仍为 number", () => {
    const body = `{"start_time_unix_nano": ${NANO_19}, "span_count": 7, "blocked": true, "score": 0.25}`;
    const parsed = parseLossless(body);
    expect(parsed.span_count).toBe(7);
    expect(parsed.blocked).toBe(true);
    expect(parsed.score).toBe(0.25);
  });

  it("数组成员里的纳秒键同样转字符串（契约 items[] 形状）", () => {
    const body = `{"items": [{"trace_id": "abc", "start_time_unix_nano": ${NANO_19}}], "total": 1}`;
    const parsed = parseLossless(body) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(parsed.total).toBe(1);
    expect(typeof parsed.items[0].start_time_unix_nano).toBe("string");
    expect(parsed.items[0].start_time_unix_nano).toBe(NANO_19);
  });

  it("16 位整数值（超 2^53 的最小量级）保底转字符串；15 位安全整数不动", () => {
    const overSafe = "99999999999999999"; // 17 位，非纳秒键名——保底规则②
    const body = `{"some_id": ${overSafe}, "other_id": 999999999999999, "span_id_nano": ${NANO_19}}`;
    const parsed = parseLossless(body);
    expect(parsed.some_id).toBe(overSafe);
    expect(parsed.other_id).toBe(999999999999999); // 15 位 < 2^53，保持 number
    expect(parsed.span_id_nano).toBe(NANO_19); // 后缀规则①不受值大小影响
  });

  it("payload JSON 字符串内部的冒号+数字不被误改（扫描器跳过字符串字面量）", () => {
    const payloadJson = '{"note": "see rule: 1765459200123456789", "id": 123}';
    const body = `{"payload": ${JSON.stringify(payloadJson)}, "ts_unix_nano": ${NANO_19}}`;
    const parsed = parseLossless(body);
    expect(parsed.payload).toBe(payloadJson); // 字符串内容逐字原样
    expect(parsed.ts_unix_nano).toBe(NANO_19);
  });

  it("字符串键名含 _unix_nano 子串但非后缀结尾的不转（nano_history）", () => {
    const body = `{"nano_history": 42, "start_time_unix_nano": ${NANO_19}}`;
    const parsed = parseLossless(body);
    expect(parsed.nano_history).toBe(42); // 非后缀键不动
    expect(parsed.start_time_unix_nano).toBe(NANO_19);
  });

  it("秒级时间戳（10 位，安全整数内）在纳秒键下仍转字符串——类型统一", () => {
    const body = `{"legacy_time_unix_nano": ${SEC_10}}`;
    const parsed = parseLossless(body);
    expect(typeof parsed.legacy_time_unix_nano).toBe("string");
    expect(parsed.legacy_time_unix_nano).toBe(String(SEC_10));
  });

  it("指数写法的大整数保底转字符串；指数小数与常规浮点不误伤", () => {
    const body = `{"big_exp": 1e30, "also_big": 1.5E22, "small_exp": 1e-3, "plain": 1.5, "safe_exp": 1e5}`;
    const parsed = parseLossless(body);
    expect(parsed.big_exp).toBe("1e30"); // 10^30 超界 → 字符串
    expect(parsed.also_big).toBe("1.5E22"); // 1.5×10^22 是超界整数 → 字符串
    expect(parsed.small_exp).toBe(0.001); // 缩小为小数 → 不动
    expect(parsed.plain).toBe(1.5); // 常规浮点 → 不动
    expect(parsed.safe_exp).toBe(100000); // 10^5 在安全范围内 → 不动
  });

  it("纯数组顶层与负数、指数写法不误伤", () => {
    const body = `[-7, 1.5e3, {"start_time_unix_nano": ${NANO_19}}]`;
    const parsed = parseLossless(body) as unknown as Array<unknown>;
    expect(parsed[0]).toBe(-7);
    expect(parsed[1]).toBe(1500);
    expect((parsed[2] as Record<string, unknown>).start_time_unix_nano).toBe(NANO_19);
  });

  it("缩进/空白格式的真实响应体（FastAPI 实际输出形态）", () => {
    const body = JSON.stringify(
      { total: 2, items: [{ trace_id: "t1", start_time_unix_nano: NANO_19 }, { trace_id: "t2" }] }
    );
    const parsed = parseLossless(body) as { items: Array<Record<string, unknown>> };
    expect(parsed.items[0].start_time_unix_nano).toBe(NANO_19);
    expect(parsed.items[1]).toEqual({ trace_id: "t2" });
  });
});
