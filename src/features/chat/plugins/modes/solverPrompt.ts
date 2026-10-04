/**
 * solver 模式的系统提示词（用户反馈 ②：「做题前校验思路、做题后检查答案」）
 *
 * ## 为什么独立成模块
 * 提示词是本模式**唯一的行为定义**（其余能力继承自 `analysis`）。
 * 抽成纯函数后，契约测试可**直接断言提示词结构**：
 * 四个步骤段的顺序、自检段必须存在、必须禁止重述原文、必须以图片为准等。
 * 不必挂载 Chat 应用 —— 与 `tabRootResetContract` 同款的源码级可测性设计。
 *
 * ## 与 analysis 提示词的三处关键差异（都是踩过坑的）
 * 1. **不再只写「不要重述」**：analysis 的教训是模型把「仔细阅读题目内容」
 *    理解成「先把题目写出来」。solver 更明确 —— **第一步是"复原题意"**（一句话，
 *    不是抄题），且**必须指出 OCR 可疑处**（公式/上下标/图表是 OCR 高错区）。
 * 2. **新增"先验思路"段**：先写知识点与解题路径，再动手算。
 *    这直接对应用户诉求「做题前校验思路」—— 让模型在算错之前先暴露思路问题。
 * 3. **新增"终自检"段**（**必须输出**）：回代/量纲/边界校验。
 *    对应用户诉求「做题后检查答案」。明确要求「发现矛盾要纠正，
 *    宁可承认不确定，不要硬圆」—— 拍题场景错答案比不答更伤。
 */

import type { SystemPromptContext } from '../../registry/modeRegistry';

/** solver 模式的 modeState 形状（继承 analysis，只用到 ocrMeta） */
interface SolverModeState {
  ocrMeta?: {
    question?: string;
    answer?: string;
    questionType?: string;
  } | null;
}

/** 步骤段标题（契约测试直接断言这些字面量 —— 改标题会被测试挡住，提醒同步文档） */
export const SOLVER_STEP_HEADINGS = {
  /** ① 复原题意 */
  restate: '【第一步：复原题意】',
  /** ② 先验思路 */
  plan: '【第二步：先验思路】',
  /** ③ 作答 */
  solve: '【第三步：作答】',
  /** ④ 终自检 */
  check: '【第四步：自检（必做）】',
} as const;

/**
 * 构建 solver 模式的系统提示。
 *
 * 四段式结构（顺序即执行顺序，测评时按此断言）：
 *   复原题意 → 先验思路 → 作答 → 自检
 */
export function solverSystemPrompt(context: SystemPromptContext): string {
  const modeState = context.modeState as SolverModeState | null;
  const ocrMeta = modeState?.ocrMeta;

  let prompt = `你是一个严谨的题目解答助手。用户会给你一张（或几张）题目照片，请按下面的**四步流程**解答。

【总则】
1. **以图片为准**，OCR 文本仅作参考。
2. **不要重述题目原文**。下面是四步流程的**固定标题**，请逐段输出，不要省略任何一段。

${SOLVER_STEP_HEADINGS.restate}
用**一两句话**说清这道题在问什么（含关键条件）。**不要抄写题目全文**。
若图片里有 OCR 文本可疑之处（公式符号、上下标、图表数据），在此明确指出"这里有识别风险"。

${SOLVER_STEP_HEADINGS.plan}
写清你打算用什么**知识点/公式**、按什么**路径**求解。**先不要计算**。
若存在多条可行路径，简述你选哪条及理由。
若题目条件不足以唯一确定答案，在此说明，并给出你的假设。

${SOLVER_STEP_HEADINGS.solve}
按上一步的思路**实际计算**，写出关键步骤。
选择题给出选项字母；填空题给出最终值（含单位）。
若图片里有多道题，**逐题解答并保留题号**（如"第1题"）。

${SOLVER_STEP_HEADINGS.check}
**这一段必须输出，不能跳过。** 至少做以下校验之一（越多越好）：
- **回代**：把答案代回原式/原条件，看是否成立
- **量纲/单位**：物理化学题检查单位是否自洽
- **边界**：取极端值看答案是否合理（如时间为 0、边长为 0）
- **粗估**：数量级是否合理
若自检**发现矛盾**：直接纠正并说明，不要强行圆场。
若自检无法完成（如题目条件不足）：**明确说明"无法验证"**，而不是假装通过。`;

  // 注入 OCR 文本（与 analysis 同款措辞：明确定位为"辅助参考"）
  //
  // ⚠️ 为什么必须强调"以图片为准"：实测 OCR 对公式、上下标、图表还原经常出错
  //    （出现过 LaTeX 转义乱码）。若不说这句，模型会照着错误文本作答，
  //    而它的"自检"又基于同一份错误文本 —— 错误会被自洽地固化。
  if (ocrMeta) {
    prompt += `\n\n【OCR 辅助文本（仅供参考，可能有识别错误）】`
      + `\n以下文字由 OCR 从图片中提取，**可能存在公式或符号错误**。`
      + `请以图片内容为准；若文字与图片不符，以图片为准。\n`
      + (ocrMeta.question ?? '');
    if (ocrMeta.answer) {
      prompt += `\n\n【参考答案（可能不完整）】\n${ocrMeta.answer}`;
    }
    if (ocrMeta.questionType) {
      prompt += `\n【题型】${ocrMeta.questionType}`;
    }
  }

  return prompt;
}

export default solverSystemPrompt;
