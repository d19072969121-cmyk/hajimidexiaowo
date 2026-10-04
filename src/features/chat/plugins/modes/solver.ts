/**
 * solver 模式 —— 拍题解题 agent（用户反馈 ②）
 *
 * ## 用户原话
 * 「应设定不同的 agent；拍题 agent 需增加检查——**做题前校验思路、做题后检查答案**」
 *
 * ## 与 `analysis` 模式的区别（为什么是独立模式而不是改提示词）
 * 用户明确要求「新建独立拍题 agent（大改）」，不是改提示词。两者的差别是**流程**：
 * - `analysis`：OCR → 直接把 OCR 文本喂给模型 → 一次性输出解析。
 *   问题：模型容易（a）把题目原样转录而不解题；（b）因 OCR 有错而**以错误文本为准**；
 *   （c）答案算完不做校验，错了也不知道。
 * - `solver`：在 `analysis` 之上加**三段式步骤链**（见下方 SYSTEM_PROMPT 编排）：
 *   ① **先复原题意**（以图片为准，指出 OCR 可疑处）
 *   ② **再验思路**（写清用的知识点/公式与解题路径，先不动手算）
 *   ③ **后作答**（按思路计算，给出答案）
 *   ④ **终自检**（回代/量纲/边界校验，发现矛盾要明确纠正而不是硬圆）
 *
 * ## 继承关系
 * `extends: 'analysis'` —— 复用其 OCR 前置流水线、`OcrResultHeader`、图片处理、
 * 笔记持久化等**全部既有能力**；本模式只**覆盖系统提示与步骤编排**。
 * 这样既满足「独立 agent」的语义，又不重复实现 OCR 链路（重复实现必然产生分歧）。
 *
 * ## 为什么把「自检」写成硬性要求
 * 这是用户反馈的核心诉求。实测痛点：模型算出答案后不会回头验算，
 * 而拍题场景恰恰是「用户拿着答案对错」——错答案比不答更伤。
 * 故提示词里把自检设为**必须输出的段落**，并明确「宁可承认不确定，不要硬圆」。
 */

import { modeRegistry, type ModeConfig } from '../../registry/modeRegistry';
import { OcrResultHeader } from './components/OcrResultHeader';
import { solverSystemPrompt } from './solverPrompt';

/**
 * solver 模式配置。
 *
 * 与 `analysis` 一致：串行前置 OCR、OCR 完成后自动发起首条消息。
 * （自动发起是必要的：用户拍完题就该看到解析，不该再点一次发送。）
 */
/** 模式名称常量（与 CHAT_MODE / ANALYSIS_MODE 命名习惯一致） */
export const SOLVER_MODE = 'solver';

const SOLVER_MODE_CONFIG: ModeConfig = {
  requiresOcr: true,
  ocrTiming: 'before',
  autoStartFirstMessage: true,
};

/**
 * 注册 solver 模式。
 *
 * ⚠️ 与 `chat.ts` / `analysis.ts` 同款：**导入即注册**（`modes/index.ts` 里 `import './solver'`）。
 * 若只导出对象而不调 `register`，`modeRegistry.getResolved('solver')` 会返回 undefined
 * → `createSessionWithDefaults({ mode: 'solver' })` 拿不到插件 → 会话退化成无模式的普通 chat，
 * 四步流程提示词**根本不会生效**（且无报错，属静默失效）。
 */
modeRegistry.register(SOLVER_MODE, {
  // 复用 analysis 的 OCR 流水线、Header、图片与笔记能力
  extends: 'analysis',

  name: SOLVER_MODE,

  config: SOLVER_MODE_CONFIG,

  /**
   * 系统提示：三段式步骤链编排。
   *
   * 抽到 `solverPrompt.ts` 是为了让**契约测试能直接断言提示词结构**
   * （步骤顺序、自检段必须存在等），不必挂载整个 Chat 应用。
   */
  buildSystemPrompt: solverSystemPrompt,

  /**
   * 工具集：与 analysis 保持一致。
   *
   * ⚠️ 必须包含 `memory`（E5 的教训）：`TauriAdapter` 用
   * `modeEnabledTools.includes('memory')` 决定是否传 `memory_enabled`，
   * 缺失会让自动记忆提取永远不触发 —— 而拍题恰恰是最该沉淀记忆的场景。
   * 若这里漏了，`extends: 'analysis'` 也不会帮我们兜住
   * （本字段是**覆盖**而非合并）。
   */
  getEnabledTools: () => ['rag', 'memory'],

  /** 头部显示 OCR 结果（沿用 analysis 的实现） */
  renderHeader: OcrResultHeader,
});

