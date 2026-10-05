/**
 * 模式「族」判据 —— 拍题/解析类模式的**单一真相源**
 *
 * ## 为什么独立成文件（而不是放 `modes/index.ts`）
 * `index.ts` 会 `import './analysis'` / `'./solver'` 做自注册，
 * 而 `analysis.ts` 本身需要这个判据 → 若把判据放 index 里就形成
 * **循环依赖**（analysis → index → analysis）。

 * ## 为什么必须有它，而不是各处写 `mode === 'analysis'`
 * 用户反馈 ② 新增了 `solver` 模式（拍题解题 agent），它 `extends: 'analysis'`，
 * **同属"解析类会话"**：有 OCR 前置、结果渲染在 `analysis-result`、
 * 会在首页冒出 `OcrResultHeader`、应计入错题本。
 *
 * 若各处仍写死 `mode === 'analysis'`，加 `solver` 后会**静默失效**：
 * - `App.tsx` 的离开收口不清 solver 会话 → 首页残留 OCR 卡片（① 症状复发）
 * - `ChatV2Page` 的三态守卫把 solver 当普通会话 → **首页渲染 OCR 卡片**
 * - `useMistakeBook` 漏掉 solver → **新拍的题不进错题本**
 * - `OcrResultCardV2` 不渲染 → OCR 卡片在解析页也消失
 * （以上四类都是「加了新模式但判族点没跟上」的典型症状）
 *
 * ## 用法
 * ```ts
 * import { isAnalysisFamilyMode, ANALYSIS_FAMILY_MODES } from './modeFamily';
 * if (isAnalysisFamilyMode(store.getState().mode)) { ... }
 * ```
 *
 * ## 新增解析类模式时
 * 只需把新 mode 加进 `ANALYSIS_FAMILY_MODES` —— 所有判族点自动跟上。
 */

/** 属于「解析类」的模式：有 OCR 前置、渲染 OcrResultHeader、应计入错题本 */
export const ANALYSIS_FAMILY_MODES: readonly string[] = ['analysis', 'solver'];

/** 该 mode 是否属于「解析类」 */
export function isAnalysisFamilyMode(mode: unknown): boolean {
  return typeof mode === 'string' && ANALYSIS_FAMILY_MODES.includes(mode);
}
