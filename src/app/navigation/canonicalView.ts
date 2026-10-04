import type { CurrentView } from '@/types/navigation';

/**
 * Canonical view mapping to prevent navigation dead-ends.
 * Deprecated views are redirected to supported destinations.
 */
const DEPRECATED_VIEW_MAP: Readonly<Record<string, CurrentView>> = {
  analysis: 'chat-v2',
  chat: 'chat-v2',
  notes: 'learning-hub',
  'markdown-editor': 'learning-hub',
  'textbook-library': 'learning-hub',
  'exam-sheet': 'learning-hub',
  batch: 'chat-v2',
  review: 'chat-v2',
  'anki-generation': 'task-dashboard',
  // 2026-02: 补全所有已移除视图的重定向，防止历史记录导航到空白页
  library: 'learning-hub',
  // E6 说明：'mistake-detail' 曾在此重定向到 'chat-v2'（历史废弃视图名）。
  // 本次把它**复活**为真实视图（错题详情独立页），故必须从本表删除该键。
  // ⚠️ 若只登记 BASE_CANONICAL_VIEWS 而漏删本键，canonicalizeView 会先查
  //    DEPRECATED_VIEW_MAP 取到 'chat-v2'，把新页**静默**吞掉——表现为
  //    「点了错题回到对话页」。可达性契约对此有专门断言。
  dashboard: 'data-management',
  'llm-usage-stats': 'data-management',
  irec: 'chat-v2',
  'irec-management': 'chat-v2',
  'irec-service-switcher': 'chat-v2',
  'math-workflow': 'chat-v2',
  'bridge-to-irec': 'chat-v2',
  // 2026-09: 模板 JSON 预览页已移除，历史记录重定向回模板管理
  'template-json-preview': 'template-management',
};

const BASE_CANONICAL_VIEWS: CurrentView[] = [
  'chat-v2',
  'sandbox-workbench',
  'settings',
  'data-management',
  'task-dashboard',
  'template-management',
  'ui-lab',
  'pdf-reader',
  'learning-hub',
  'skills-management',
  'todo',
  'flashcards',
  // A3-P0：解析结果全屏视图（拍题 → 解析 → 错题 → 复习 的中间环节）
  // 必须登记在此，否则 canonicalizeView 会把 'analysis-result' 静默落回 'chat-v2'
  'analysis-result',
  // A5：复习入口页（错题本 / 单词卡片 / 易错点 / 刷题）
  // 注意命名：不能叫 'review'——DEPRECATED_VIEW_MAP 里 'review' 是历史废弃
  // 视图名，会被 canonicalizeView 静默重定向到 'chat-v2'。
  'review-hub',
  // E3：刷题入口页（温故新知 / 自己定类型）。刷题独立于卡片逻辑，故独立视图。
  'practice-hub',
  // E8：刷题会话页。必须登记，否则 canonicalizeView 会静默落回 chat-v2。
  // 命名注意：不能用 'practice'（历史废弃名）等 DEPRECATED_VIEW_MAP 里的键。
  'practice-session',
  // E4：拍题页。study Tab 的落地视图，是「拍题 → 解析 → 错题 → 复习」链路的起点。
  'capture',
  // E5：知识卡片 / 易错点。此前二者共用 flashcards 界面（用户要求分开），
  // 现各自独立成页，故须登记进 canonical，否则会被静默落回 chat-v2。
  'knowledge-cards',
  'weak-points',
  // E6：错题详情独立页。由 review-hub 推入的二级页（点开某条错题）。
  // ⚠️ 同名键曾存在于 DEPRECATED_VIEW_MAP 并重定向到 chat-v2，本次已删除该键；
  //    否则本行登记会被 canonicalizeView 里的 deprecated 分支抢先吞掉。
  'mistake-detail',
];

const DEV_ONLY_VIEWS: CurrentView[] = ['crepe-demo', 'chat-v2-test', 'llm-playground'];

export const CANONICAL_VIEWS: ReadonlySet<CurrentView> = new Set([
  ...BASE_CANONICAL_VIEWS,
  ...(import.meta.env.DEV ? DEV_ONLY_VIEWS : []),
]);

export const canonicalizeView = (view: CurrentView | string): CurrentView => {
  const mapped = DEPRECATED_VIEW_MAP[view] ?? view;
  return CANONICAL_VIEWS.has(mapped as CurrentView) ? (mapped as CurrentView) : 'chat-v2';
};

export const isSupportedView = (view: CurrentView | string): boolean => {
  return CANONICAL_VIEWS.has(canonicalizeView(view));
};
