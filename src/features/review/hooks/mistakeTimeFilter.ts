/**
 * mistakeTimeFilter — 错题的「按时间分类」（E13-S）
 *
 * ## 为什么需要它
 * 错题本此前只有 `updatedAt` 的单一日期显示（`ReviewHubPage.formatDate`），
 * 没有办法「只看这个月的」或「按月份归拢」。用户明确要求
 * 「分类好时间」。
 *
 * ## 口径选择：用 createdAt 还是 updatedAt？
 * - `createdAt` = 拍下这道题的时间 → **符合用户直觉**（「我上周考的那张卷子」）。
 * - `updatedAt` = 最后一次动它的时间 → 复习一次就跳到今天，会把
 *   「考试时间」语义冲掉。
 *
 * 因此**时间筛选按 `createdAt`**（拍题时间，稳定不变）；
 * 列表默认排序仍沿用 `updatedAt` 倒序（最近碰过的在最前，见
 * `toMistakeEntries`）—— 两者语义不同，不要混用。
 *
 * ## 边界
 * 上游时间统一为 ISO 8601（`ChatSession.createdAt` 契约）。但历史数据/
 * 异常写入可能存在空串或非法值，一律**排除**在时间筛选之外（既不属于
 * 任何区间），并在 UI 用「全部」兜住，避免静默丢条目。
 *
 * ## 时区
 * 分组按**本地时区**的年月（列表上用户看到的就是本地日期）。
 * `new Date(iso)` 已按本地时区解析出本地年月，故直接用 getFullYear/getMonth。
 * 不引入时区库（Android WebView 的本地时区即用户所见）。
 */

import type { MistakeBookEntry } from './useMistakeBook';

/** 时间筛选项：相对当前时刻的区间，或全部 */
export type MistakeTimeRange = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'thisYear';

/** 时间筛选可选项（UI 按此顺序渲染） */
export const MISTAKE_TIME_RANGES: readonly MistakeTimeRange[] = [
  'all',
  'thisMonth',
  'lastMonth',
  'last3Months',
  'thisYear',
] as const;

/** 月份分组键，如 `2026-03`；无法解析时为 `''`（归入「未知时间」） */
export type MonthKey = string;

/**
 * 把 ISO 时间串解析成本地 `YYYY-MM`。
 *
 * 解析失败（空串/非法）返回 `''`。
 */
export function toMonthKey(iso: string): MonthKey {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.getTime();
  if (!Number.isFinite(time)) return '';
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 当前时刻的本地 `YYYY-MM` */
function currentMonthKey(now: Date): MonthKey {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 把 `YYYY-MM` 平移 n 个月（n 可为负） */
function shiftMonthKey(monthKey: MonthKey, delta: number): MonthKey {
  const [y, m] = monthKey.split('-').map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return monthKey;
  // 用 Date 做跨年进位（month 为 0-based）
  const d = new Date(y, m - 1 + delta, 1);
  return currentMonthKey(d);
}

/**
 * 判断某条错题是否落在时间区间内。
 *
 * 用 `createdAt`（拍题时间）。无法解析时间的条目在非 'all' 区间下**一律排除**；
 * 'all' 区间包含一切。
 */
export function isWithinTimeRange(
  entry: Pick<MistakeBookEntry, 'createdAt'>,
  range: MistakeTimeRange,
  now: Date = new Date(),
): boolean {
  if (range === 'all') return true;

  const monthKey = toMonthKey(entry.createdAt);
  if (!monthKey) return false; // 无有效时间 → 不属于任何具体区间

  const thisMonth = currentMonthKey(now);
  switch (range) {
    case 'thisMonth':
      return monthKey === thisMonth;
    case 'lastMonth':
      return monthKey === shiftMonthKey(thisMonth, -1);
    case 'last3Months': {
      // 含本月在内往前数 3 个月（本月、上月、上上月）
      const oldest = shiftMonthKey(thisMonth, -2);
      return monthKey >= oldest && monthKey <= thisMonth;
    }
    case 'thisYear':
      return monthKey.slice(0, 4) === String(now.getFullYear());
    default:
      return true;
  }
}

/** 按时间区间筛选（纯函数，便于单测） */
export function filterByTimeRange<T extends Pick<MistakeBookEntry, 'createdAt'>>(
  entries: readonly T[],
  range: MistakeTimeRange,
  now: Date = new Date(),
): T[] {
  if (range === 'all') return [...entries];
  return entries.filter((e) => isWithinTimeRange(e, range, now));
}

export interface MonthGroup<T> {
  /** `YYYY-MM`；无法解析时间的条目落在 `''` 组 */
  monthKey: MonthKey;
  entries: T[];
}

/**
 * 按「本地年月」分组，**月份倒序**（新月份在前），组内保持传入顺序
 * （调用方已按 updatedAt 倒序）。
 *
 * 无法解析时间的条目统一归入 `''` 组，并**排在最后**（而不是混进最新月）。
 */
export function groupByMonth<T extends Pick<MistakeBookEntry, 'createdAt'>>(
  entries: readonly T[],
): MonthGroup<T>[] {
  const buckets = new Map<MonthKey, T[]>();
  for (const e of entries) {
    const key = toMonthKey(e.createdAt);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }

  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === '') return 1; // 未知时间恒在最后
    if (b === '') return -1;
    return b.localeCompare(a); // `YYYY-MM` 字典序 = 时间倒序
  });

  return keys.map((monthKey) => ({ monthKey, entries: buckets.get(monthKey) ?? [] }));
}

/** 把 `YYYY-MM` 格式化成展示文案；`''` 返回空串（由调用方给 i18n 兜底文案） */
export function formatMonthLabel(monthKey: MonthKey): string {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-');
  if (!y || !m) return '';
  return `${y}-${m}`;
}

// ============================================================================
// ⚠️ 已知精度边界：纯前端过滤 + 500 条上限
// ============================================================================
//
// 本模块**纯前端计算**，不向后端传任何时间参数（`chat_v2_list_sessions`
// 没有 createdAt 区间过滤能力，只有 status / groupId / excludeModes /
// limit / offset）。
//
// 因此存在一个**真实但有限**的失真：
//
// - 后端取数是 `ORDER BY updated_at DESC LIMIT 500`
//   （repo.rs:621，`MISTAKE_FETCH_LIMIT = 500`，见 useMistakeBook.ts:49）。
// - 本模块按 **createdAt** 筛选/分组。
//
// 两个字段的排序口径**不同**，于是当 analysis 族会话总数 > 500 时：
// 「很久以前拍的、但最近被复习过」的题反而会留在 500 条里，
// 而「拍得早、此后从未再动」的题会被挤出窗口 —— 后者恰恰更可能落在
// 「去年」「上月」这类历史区间里。
//
// **失真表现**：历史时间区间（lastMonth / thisYear 等）的结果可能偏少，
// 而 'all' 区间（以及本月）不受影响（因为 500 条是「最近更新」的，
// 本月拍的题必然在其中）。
//
// **当前是否会发生**：单用户达到 500 条 analysis 会话前不会。错题本按
// 「最近更新」展示，绝大多数用户远达不到。故本模块**不引入后端改动**
// （改 Rust 查询属 task-12 那一侧的高风险区，且需新增命令）。
//
// **将来要修的话**：给 `chat_v2_list_sessions` 加可选 `createdAfter`/
// `createdBefore` 参数（SQL 侧加 `AND created_at >= ?`），由本模块把
// 区间下推。届时 `filterByTimeRange` 仍保留作 UI 侧兜底（双保险），
// 不要删。
//
// 该边界在报告 `analysis/E13S_错题本分类备注.md` 的「已知限制」一节
// 有对应条目，**不要在未确认的前提下声称时间筛选「总是准确」**。

