export function calculateInterceptionRate(blockedCount: number, totalCount: number): number | null {
  if (!Number.isFinite(blockedCount) || !Number.isFinite(totalCount) || totalCount <= 0 || blockedCount < 0) {
    return null;
  }
  const rate = (blockedCount / totalCount) * 100;
  return Number.isFinite(rate) ? Number(rate.toFixed(1)) : null;
}

export function formatInterceptionRate(blockedCount: number, totalCount: number): string {
  const rate = calculateInterceptionRate(blockedCount, totalCount);
  return rate === null ? "—" : String(rate.toFixed(1)) + "%";
}
