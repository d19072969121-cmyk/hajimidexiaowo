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
  'mistake-detail': 'chat-v2',
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
