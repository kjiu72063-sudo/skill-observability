/**
 * 无损 JSON 解析基座（M2-02 #17，全段地基——M2-12 八卡统计精度全压在这）。
 *
 * #2 决议钉死：纳秒时间戳（19 位整数）超过 JS Number.MAX_SAFE_INTEGER（2^53），
 * 常规 `JSON.parse` 直接丢精度（尾数被舍入），且不可逆——reviver 钩子拿到
 * 的是已舍入的 number，救不回来。所以必须在解析**之前**对原始 JSON 文本做
 * 值级改写，让以下两类数值以字符串进组件树：
 *
 * ① 键名以 `_unix_nano` 结尾的数值 → 一律字符串承载（#17 票面① + #2 决议评论
 *   6761569028 钉死；组件树内该类字段类型统一为 string，无论值大小）；
 * ② 其他键下超出安全整数范围的整数字面量 → 同样转字符串保底（防未来新增
 *   大整数字段重踩同坑；含指数写法如 1e30；小数值与普通浮点不动）。
 *
 * 实现：手写文本扫描器而非正则——正则无法区分「字符串字面量内部的
 * `": 123...`」与真正的键值对（如 payload JSON 里恰好含 `"id": 123456...`），
 * 扫描器逐字符跳过字符串字面量（含转义），只在结构位置识别数值。
 */

/** 无损解析结果：与 JSON.parse 一样顶层可为对象或数组（改写字段的值是 string）。 */
export type LosslessParsed = Record<string, unknown> | unknown[];

/**
 * 数值字面量是否为超出安全整数范围的整数（含指数写法：1e30、1.5E22）。
 * 带小数部分的浮点（1.5、1e-3）不判超界——浮点本就近似，精度语义不同。
 */
function exceedsSafeInteger(literal: string): boolean {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return false;
  const [, intPart, fracPart, expPart] = m;
  const digits = intPart + (fracPart ?? "");
  const intExp = (expPart ? parseInt(expPart, 10) : 0) - (fracPart?.length ?? 0);
  if (intExp < 0) return false; // 缩小后带小数 → 非整数浮点
  const absDigits = digits.replace(/^0+/, "") || "0";
  if (absDigits === "0") return false;
  // 位数粗筛：整数位数 ≤ 15 必在 2^53 内，跳过精确判定
  if (absDigits.length + intExp <= 15) return false;
  return !Number.isSafeInteger(Number(literal));
}

/**
 * 把 JSON 文本中需要无损承载的数值字面量改写为字符串字面量。
 * 输入必须是合法 JSON 文本（parse 失败的行为与 JSON.parse 一致：由调用方处理）。
 */
function rewriteNumericLiterals(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  const isDigit = (c: string): boolean => c >= "0" && c <= "9";

  // 读取一个 JSON 数字字面量（-?digits(.digits)?([eE][+-]?digits)?），返回 [start, end)
  const readNumber = (start: number): number => {
    let j = start;
    if (text[j] === "-") j++;
    while (j < n && isDigit(text[j])) j++;
    if (text[j] === ".") {
      j++;
      while (j < n && isDigit(text[j])) j++;
    }
    if (text[j] === "e" || text[j] === "E") {
      j++;
      if (text[j] === "+" || text[j] === "-") j++;
      while (j < n && isDigit(text[j])) j++;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // 字符串字面量：原样复制（含内部一切内容），转义序列成对跳过
      out += c;
      i++;
      while (i < n) {
        const sc = text[i];
        out += sc;
        if (sc === "\\") {
          if (i + 1 < n) {
            out += text[i + 1];
            i += 2;
            continue;
          }
          i++; // 末尾孤立反斜杠：非法 JSON，交给最终 parse 报错
          continue;
        }
        i++;
        if (sc === '"') break;
      }
      continue;
    }

    // 数字出现在值位置（紧随 `:` 或 `[` 或 `,` 之后，且跳过空白）
    if (c === "-" || isDigit(c)) {
      // 判定前一个非空白字符，确认处于值上下文
      let p = i - 1;
      while (p >= 0 && (text[p] === " " || text[p] === "\t" || text[p] === "\n" || text[p] === "\r")) p--;
      const prev = p >= 0 ? text[p] : "";
      const inValuePosition = prev === ":" || prev === "," || prev === "[" || prev === "";
      if (!inValuePosition) {
        out += c;
        i++;
        continue;
      }

      const end = readNumber(i);
      const literal = text.slice(i, end);
      // 向前找键名：值上下文中，向前最近的非空白字符若是 `:`，其前的字符串即键
      const key = findPrecedingKey(text, i);
      const isNano = key !== null && key.endsWith("_unix_nano");

      let shouldQuote = false;
      if (isNano) {
        shouldQuote = true; // ① 纳秒键一律字符串承载
      } else {
        // ② 非纳秒键：仅当整数值超安全范围才保底改写（含指数写法，如 1e30）
        shouldQuote = exceedsSafeInteger(literal);
      }

      if (shouldQuote) {
        out += JSON.stringify(literal); // 数字字面量 → 同数字符串
      } else {
        out += literal;
      }
      i = end;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * 在 text 的位置 pos（一个值字面量起点）向前找它所属的键名。
 * 跳过空白后若紧邻 `:`，则 `:` 之前应是一个完整字符串字面量（键）；
 * 不在键值上下文（数组元素/顶层）返回 null。
 * 依赖 pos 前的文本是平衡合法 JSON 的结构前缀（调用场景=逐值改写，成立）。
 */
function findPrecedingKey(text: string, pos: number): string | null {
  let p = pos - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;
  if (p < 0 || text[p] !== ":") return null;
  p--;
  while (p >= 0 && /\s/.test(text[p])) p--;
  if (p < 0 || text[p] !== '"') return null;
  // 从该引号向回找字符串起点（键内不含转义即可按引号定位；键名是受控标识符）
  let q = p - 1;
  while (q >= 0 && text[q] !== '"') {
    if (text[q] === "\\") q--; // 跳过转义对
    q--;
  }
  if (q < 0) return null;
  return text.slice(q + 1, p);
}

/** 无损解析：`*_unix_nano` 与超安全范围整数以字符串承载，其余与 JSON.parse 一致。 */
export function parseLossless(text: string): LosslessParsed {
  return JSON.parse(rewriteNumericLiterals(text)) as LosslessParsed;
}
