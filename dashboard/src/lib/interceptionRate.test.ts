import { describe, expect, it } from "vitest";

import { calculateInterceptionRate, formatInterceptionRate } from "./interceptionRate";

describe("interceptionRate", () => {
  it("分母为 0 返回空值并显示破折号", () => {
    expect(calculateInterceptionRate(0, 0)).toBeNull();
    expect(formatInterceptionRate(0, 0)).toBe("—");
  });

  it("按一位小数显示卡 4 ÷ 卡 3", () => {
    expect(calculateInterceptionRate(2, 3)).toBe(66.7);
    expect(formatInterceptionRate(2, 3)).toBe("66.7%");
  });

  it("覆盖 0%、100% 和非有限输入边界", () => {
    expect(formatInterceptionRate(0, 4)).toBe("0.0%");
    expect(formatInterceptionRate(4, 4)).toBe("100.0%");
    expect(formatInterceptionRate(Number.POSITIVE_INFINITY, 4)).toBe("—");
  });
});
