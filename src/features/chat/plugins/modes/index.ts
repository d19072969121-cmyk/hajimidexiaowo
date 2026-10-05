/**
 * Chat V2 - 模式插件导出
 *
 * 导入此文件会自动注册所有内置模式插件
 */

// 导入即注册
import './chat';
import './analysis';
// E8（用户反馈 ②）：拍题解题 agent —— 四步流程（复原题意 → 先验思路 → 作答 → 自检）
// `extends: 'analysis'`，复用其 OCR 流水线与 Header，只覆盖提示词与工具集。
import './solver';

// 导出模式名称
export { CHAT_MODE } from './chat';
export { ANALYSIS_MODE } from './analysis';
export { SOLVER_MODE } from './solver';

// 族判据抽到独立文件（避免 index 与 analysis 的循环依赖）
export { ANALYSIS_FAMILY_MODES, isAnalysisFamilyMode } from './modeFamily';

// 导出 solver 的提示词编排（契约测试直接断言步骤结构）
export { solverSystemPrompt, SOLVER_STEP_HEADINGS } from './solverPrompt';

// 导出 analysis 模式类型和辅助函数
export type {
  OcrStatus,
  OcrMeta,
  AnalysisModeState,
  AnalysisInitConfig,
} from './analysis';
export {
  createInitialAnalysisModeState,
  canSendInAnalysisMode,
  getAnalysisOcrStatus,
  retryOcr,
} from './analysis';

// textbook 相关类型和函数保留导出，供教材功能使用
// 注意：textbook 不再作为独立模式，而是通过 TextbookContext 控制侧栏
export type {
  TextbookLoadingStatus,
  TextbookPage,
  TextbookModeState,
  TextbookInitConfig,
} from './textbook';
export {
  createInitialTextbookModeState,
  setCurrentPage,
  goToPreviousPage,
  goToNextPage,
  getCurrentPageImageUrl,
  isTextbookLoaded,
  reloadTextbook,
} from './textbook';

// 导出组件
export {
  OcrProgress,
  OcrResultHeader,
} from './components';
