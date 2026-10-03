/**
 * 错因判定规则（A4 轮 · task-4）
 *
 * ⚠️ 本文件是 `src/components/ReviewQuestionsView.tsx` 内 `getErrorCauses()` 的
 * **只读副本**，用于让错因筛选器与错题本列表共用同一套判定规则。
 *
 * ## 为什么是副本，而不是从 ReviewQuestionsView 提取
 *
 * 上游 `getErrorCauses` 是模块私有函数（`ReviewQuestionsView.tsx:41`，无 export），
 * `ErrorCause` 类型同样私有（`:37`）。提取需要改上游文件（加 export + 删原实现 +
 * 改调用点），会把「派生规则」的改动面扩大到生产视图，回归风险不对称——而本轮的
 * 收益只是一个筛选器。
 *
 * 复制方案的代价是**规则漂移**（两处独立演进后判定不一致）。这个代价是
 * **可检测的**：`tests/vitest/errorCauseFilter.test.tsx` 里有一条对拍测试，
 * 用同一批 Question 输入分别跑本模块与一份「转写自上游源码」的参考实现，
 * 断言两者结果逐项相同。漂移即变红。
 *
 * ## 与上游的一致性锚点（改动时务必同步核对）
 *
 * | 规则 | 本文件行 | 上游行 | 规则原文 |
 * |---|---|---|---|
 * | `STALE_DAYS = 14` | `:44` | `ReviewQuestionsView.tsx:39` | 同值 |
 * | neverCorrect | `:56` | `:48` | `attempts > 0 && correct === 0` |
 * | repeatedErrors | `:58` | `:50` | `errors >= 3`（else-if 链） |
 * | highErrorRate | `:60` | `:52` | `attempts >= 2 && errors / attempts >= 0.6` |
 * | stale | `:64` | `:58` | `lastAttemptAt` 距今 `> 14` 天 |
 * | 排序语义 | — | — | 前三个**互斥**（else-if 链），stale **独立叠加** |
 *
 * ## 语义要点（易被后来者改错）
 *
 * - 前三个错因是 **else-if 链 ⇒ 最多命中一个**：从未答对优先于反复错，
 *   反复错优先于高错误率。
 * - `stale` 是**独立 if**，可以与前三个中的任意一个同时命中
 *   ⇒ 单题最多产出 2 个错因。
 * - `errors` 可能为负（数据异常时 `correctCount > attemptCount`），
 *   此时 `errors >= 3` 为 false、`errors/attempts >= 0.6` 也为 false，
 *   自然落空，不需要额外防御分支——与上游行为一致。
 */

import type { Question } from '@/api/questionBankApi';

/**
 * 错因本体。与上游 `ReviewQuestionsView.tsx:37` 的私有类型逐字相同。
 *
 * i18n 文案已存在，复用不新建：
 * `review:questions.errorCause.{neverCorrect|repeatedErrors|highErrorRate|stale}`
 * （`src/locales/zh-CN/review.json` 与 `en-US/review.json` 同结构）
 */
export type ErrorCause = 'neverCorrect' | 'repeatedErrors' | 'highErrorRate' | 'stale';

/** 渲染顺序的单一真相源（筛选器必须按此顺序渲染，避免每次渲染顺序抖动） */
export const ERROR_CAUSE_ORDER: readonly ErrorCause[] = [
  'neverCorrect',
  'repeatedErrors',
  'highErrorRate',
  'stale',
] as const;

/** 与上游 `ReviewQuestionsView.tsx:39` 同值。改动必须两边同步。 */
export const STALE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * 判定单题的错因集合。
 *
 * @param question        题目（只用 attemptCount / correctCount / lastAttemptAt）
 * @param now             当前时间戳（ms）。显式传入而不是内部取 `Date.now()`，
 *                        使判定**纯函数化、可确定性测试**——stale 分支依赖时间，
 *                        内部取当前时间会让测试必须 mock 时钟且无法覆盖边界。
 *                        默认值是 `Date.now()`，调用方通常不传。
 */
export function getErrorCauses(question: Question, now: number = Date.now()): ErrorCause[] {
  const attempts = question.attemptCount || 0;
  const correct = question.correctCount || 0;
  const errors = attempts - correct;
  const causes: ErrorCause[] = [];

  // 前三项是 else-if 链：最多命中一个（与上游 :48-53 一致）
  if (attempts > 0 && correct === 0) {
    causes.push('neverCorrect');
  } else if (errors >= 3) {
    causes.push('repeatedErrors');
  } else if (attempts >= 2 && errors / attempts >= 0.6) {
    causes.push('highErrorRate');
  }

  // stale 是独立 if：可与上面任一项叠加（与上游 :56-60 一致）
  if (question.lastAttemptAt) {
    const diffDays = (now - new Date(question.lastAttemptAt).getTime()) / MS_PER_DAY;
    if (diffDays > STALE_DAYS) causes.push('stale');
  }

  return causes;
}

/**
 * 筛选谓词：判断某题是否命中当前选中的错因。
 *
 * ## 筛选语义：多选 OR（任一命中即通过）
 *
 * 选择理由：
 * 1. **错因是叠加标签不是互斥分类。** 单题可同时是「反复错」+「久未复习」
 *    （见 `getErrorCauses` 的 else-if + 独立 if 结构）。用户勾两个错因时，
 *    他的心智是「把这两类问题都给我看」，即并集。
 * 2. **AND 在本数据上会产出反直觉的空集。** 前三个错因互斥，任何人勾选
 *    「从未答对」+「反复错」在 AND 语义下**必然为空**——用户会以为是 bug。
 * 3. **与上游列表语义同向。** `ReviewQuestionsView` 展示的是每题的错因集合，
 *    筛选器只是在这之上做投影，OR 与「展示全部命中标签」的直觉一致。
 *
 * 空选择 = **全通过**（不是全不通过）：未勾选任何错因时视为「无筛选条件」，
 * 列表保持完整。这与 `questionBankApi.ts` 里 `by_tag` 无 tag 时的兜底思路一致。
 */
export function matchesErrorCauseFilter(
  question: Question,
  selected: ReadonlySet<ErrorCause> | readonly ErrorCause[],
  now: number = Date.now(),
): boolean {
  const selectedList = Array.isArray(selected) ? selected : [...selected];
  if (selectedList.length === 0) return true;

  const causes = getErrorCauses(question, now);
  return causes.some((cause) => selectedList.includes(cause));
}
