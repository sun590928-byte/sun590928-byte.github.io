// 傳票列印版面（11/20 需求 10）：每張傳票固定佔 A4 的一半（148.5 mm），一頁上下各一張、中間印裁切虛線；
// 分錄太多、半頁放不下的傳票單獨佔一整頁。排法固定：依傳票順序兩張一頁；遇到整頁傳票時，
// 前面落單的半頁傳票自己一頁（下半頁留白），整頁傳票之後重新從上半頁開始排。

// 半頁最多幾行分錄：依傳票列印的字級（app.css「傳票列印」）實測——半頁扣掉上下留白、表頭、日期摘要列、
// 合計、附件、簽章欄後可放 13 行；保留 1 行給換行的摘要或較長的附件清單，取 12 行。
// 改了傳票字級或留白要重量（tests/e2e.mjs 的「11/20 需求 10」會檢查上限那張剛好放得下）。
export const HALF_MAX_LINES = 12;

/** 這張傳票印半頁還是整頁；forceFull：畫面實際排版時半頁放不下（摘要換很多行等）的傳票 id */
export function voucherSize(e, { maxLines = HALF_MAX_LINES, forceFull = null } = {}) {
  if (forceFull?.has(e.id)) return 'full';
  return (e.lines || []).length <= maxLines ? 'half' : 'full';
}

/**
 * 依序把傳票排進 A4 頁面。
 * @returns {{ kind: 'half'|'full', items: object[] }[]} 每一頁：half 頁有 1～2 張（上、下）；full 頁只有 1 張
 */
export function layoutVoucherSheets(entries, opts = {}) {
  const sheets = [];
  let open = null; // 只排了上半頁、還沒排下半頁的頁面
  for (const e of entries) {
    if (voucherSize(e, opts) === 'full') {
      open = null;
      sheets.push({ kind: 'full', items: [e] });
    } else if (open) {
      open.items.push(e);
      open = null;
    } else {
      open = { kind: 'half', items: [e] };
      sheets.push(open);
    }
  }
  return sheets;
}
