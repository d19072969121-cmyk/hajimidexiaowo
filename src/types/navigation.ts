/**
 * 导航历史类型定义
 * 支持参数化历史、状态恢复、中转页过滤
 *
 * 清理说明（2026-02）：
 * - 已彻底移除废弃视图类型：analysis、chat、notes、markdown-editor、
 *   textbook-library、exam-sheet、batch、review
 * - 历史兼容入口统一在 canonicalizeView(string) 做字符串级重定向
 */

export type CurrentView =
  | 'chat-v2'           // Chat V2 正式入口（主入口）
  | 'sandbox-workbench' // Sandbox 工作台（HTML / Preview workbench）
  | 'settings'
  | 'dashboard'
  | 'data-management'
  | 'task-dashboard'     // 制卡任务管理页面
  | 'template-management'
  | 'ui-lab'            // UI 样式调试与 primitive 校对页面
  | 'crepe-demo'
  | 'pdf-reader'
  | 'learning-hub'      // Learning Hub 学习资源全屏模式
  | 'skills-management' // 技能管理页面
  | 'todo'              // 待办事项独立页面
  | 'flashcards'        // 闪卡复习（传统壳入口；OS 模式仍走学习桌面应用）
  | 'chat-v2-test'      // Chat V2 集成测试页面（开发用）
  | 'llm-playground'    // LLM 输出模拟游乐场（开发用）
  | 'analysis-result'   // A3-P0：解析结果全屏视图（拍题 → 解析 → 错题 → 复习 中间环节）
  | 'review-hub'        // A5：复习入口页（错题本 / 单词卡片 / 易错点 / 刷题 四入口）
  | 'practice-hub'      // E3：刷题入口页（温故新知 / 自己定类型），独立于卡片逻辑
  | 'practice-session'  // E8：刷题会话页（温故新知搜同类题 / 自己定类型选范围）——用户反馈 ③
  | 'capture'           // E4：拍题页（study Tab 落地页，链路的起点）
  | 'knowledge-cards'   // E5：知识卡片页（原「单词卡片」改名，与小知识点速查对应）
  | 'weak-points'       // E5：易错点页（独立于知识卡片，含 AI 自动沉淀 + 手动添加）
  // E6：错题详情独立页。用户在 review-hub 点开某条错题后进入。
  // 此前复用解析结果页（刚拍完的即时结果），语义不对——本页是
  // 「历史错题回顾」，故独立成视图。
  // ⚠️ 不要在本联合体内用引号写其它 view id 字面量：契约测试解析本联合体时
  //    会连同注释一起扫（`/'([a-z0-9-]+)'/g`），写进注释会被当成重复成员。
  | 'mistake-detail';

/**
 * 导航历史项：包含视图、参数和状态恢复函数
 */
export interface NavigationHistoryEntry {
  /** 视图标识 */
  view: CurrentView;
  /** 可选参数：如 cardId 等 */
  params?: Record<string, unknown>;
  /** 状态恢复函数（滚动位置、筛选条件等） */
  restore?: () => void | Promise<void>;
  /** 创建时间戳（用于去重和调试） */
  timestamp: number;
}

/**
 * 中转视图：不应进入历史栈的临时页面
 */
export const SKIP_IN_HISTORY: Set<CurrentView> = new Set([]);

/**
 * 历史栈最大长度
 */
export const MAX_HISTORY_LENGTH = 200;
