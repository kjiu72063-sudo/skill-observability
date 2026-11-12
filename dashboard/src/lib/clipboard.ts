/**
 * 剪贴板复制（M2-05 #20，M3：trace_id 一键复制）。
 *
 * 首选 `navigator.clipboard`（Chrome/Edge 在 127.0.0.1 属安全上下文）；
 * 非安全上下文/权限被拒时回退到 textarea + execCommand。返回是否成功——
 * 展示层据此给「已复制 / 复制失败」反馈，绝不假装成功。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限拒绝/浏览器策略：走回退
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
