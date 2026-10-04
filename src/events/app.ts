/**
 * App 壳层事件：导航 / settings / chat·workbench 桥接。
 *
 * Owner 约定：
 * - 监听：优先 App.tsx（壳层）或明确的 feature bridge（如 WorkbenchEventBridge）
 * - 派发：通过 dispatchAppEvent；禁止在业务组件里手写裸 CustomEvent 字符串（逐步迁移）
 * - 生命周期：React 侧用 useAppEvent / useEventRegistry，保证 add/remove 成对
 */

import {
  addTypedEventListener,
  dispatchTypedEvent,
  toTypedEventListener,
  type EventTargetKind,
} from './registry';
import type { CurrentView } from '@/types/navigation';

export const APP_EVENTS = {
  SYSTEM_SETTINGS_CHANGED: 'systemSettingsChanged',
  WORKBENCH_MODE_CHANGED: 'workbench:mode-changed',
  VIEW_SWITCHED: 'app:view-switched',
  /**
   * 用户点了底部 Tab 栏的某一格 → 请求该 Tab 的**根页面**复位到自身根状态。
   *
   * 为什么需要独立事件（而非复用 VIEW_SWITCHED）：
   * 部分页面的「二级面」是**页面内部 state**（不在 CurrentView 层级上），
   * 典型如 `learning-hub` 的 `screenPosition`（left/center/right）。此时
   * `TAB_ROOT_VIEW[tab] === currentView`，`setCurrentView` 是同值写入、
   * React 不重渲染、`VIEW_SWITCHED` 也不派发（它只在 view 真变时发），
   * 于是页面停在二级面不动 —— 用户感受就是「点底栏没回到那个 Tab 的根 UI」。
   *
   * 语义：**无论视图是否变化都要广播**。有内部层级的页面监听它并把自身
   * 复位到根态；无内部层级的页面可忽略。
   *
   * 约束：页面复位必须**幂等**（已在根态时重复收到不得报错/回退过度）。
   */
  TAB_ROOT_RESET: 'app:tab-root-reset',
  NAVIGATE_TO_TAB: 'navigate-to-tab',
  NAVIGATE_TO_VIEW: 'NAVIGATE_TO_VIEW',
  SETTINGS_NAVIGATE_TAB: 'SETTINGS_NAVIGATE_TAB',
  OPEN_IMPORT_CONVERSATION: 'DSTU_OPEN_IMPORT_CONVERSATION',
  OPEN_CLOUD_STORAGE_SETTINGS: 'DSTU_OPEN_CLOUD_STORAGE_SETTINGS',
  OPEN_MARKDOWN_EDITOR: 'OPEN_MARKDOWN_EDITOR',
  OPEN_NOTES: 'OPEN_NOTES',
  OPEN_CREPE_DEMO: 'OPEN_CREPE_DEMO',
  OPEN_CHAT_V2_TEST: 'OPEN_CHAT_V2_TEST',
  NAVIGATE_TO_KNOWLEDGE_BASE: 'DSTU_NAVIGATE_TO_KNOWLEDGE_BASE',
  LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE: 'learningHubNavigateToKnowledge',
  LEARNING_HUB_OPEN_RESOURCE: 'learningHubOpenResource',
  LEARNING_HUB_OPEN_EXAM: 'learningHubOpenExam',
  LEARNING_HUB_OPEN_TRANSLATION: 'learningHubOpenTranslation',
  LEARNING_HUB_OPEN_ESSAY: 'learningHubOpenEssay',
  LEARNING_HUB_OPEN_NOTE: 'learningHubOpenNote',
  PREFILL_CHAT_INPUT: 'PREFILL_CHAT_INPUT',
  CHAT_V2_SET_INPUT: 'CHAT_V2_SET_INPUT',
  CHAT_GROUPS_UPDATED: 'chat-v2:groups-updated',
  NAVIGATE_TO_SESSION: 'navigate-to-session',
  MODERN_SIDEBAR_GROUP_ACTION: 'modern-sidebar:group-action',
  MOBILE_APP_NAVIGATE: 'deepstudent:mobile-sidebar-navigate',
  CHAT_NEW_SESSION: 'CHAT_NEW_SESSION',
  /**
   * A3-P0：解析会话创建完成。由 chat 层 dispatch（载荷 { sessionId, imageCount }），
   * App 层监听后把视图切到 'analysis-result'（解析结果全屏视图）。
   * 为什么走事件而不是 props 透传：视图状态归 App 层，chat 层不持有导航能力，
   * 与既有 MOBILE_APP_NAVIGATE / OPEN_* 系列同一模式。
   */
  ANALYSIS_SESSION_CREATED: 'chat-v2:analysis-session-created',
  NOTES_CREATE_NEW: 'NOTES_CREATE_NEW',
  NAVIGATE_TO_EXAM_SHEET: 'navigateToExamSheet',
  NAVIGATE_TO_TRANSLATION: 'navigateToTranslation',
  NAVIGATE_TO_ESSAY: 'navigateToEssay',
  NAVIGATE_TO_NOTE: 'navigateToNote',
  WB_PREVIEW_QUICK_LOOK: 'wb-preview:quick-look',
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

/** settings 广播：字段为可选，监听方按 settingKey / 语义字段过滤 */
export interface SystemSettingsChangedDetail {
  settingKey?: string;
  value?: unknown;
  topbarTopMargin?: boolean;
  macosFontSmoothing?: boolean;
  pointerCursor?: boolean;
  mcpReloaded?: boolean;
  [key: string]: unknown;
}

export interface WorkbenchModeChangedDetail {
  enabled: boolean;
}

export interface ViewSwitchedDetail {
  from: CurrentView;
  to: CurrentView;
}

/**
 * `TAB_ROOT_RESET` 载荷：用户点了哪个 Tab，以及该 Tab 的根视图是哪个。
 *
 * 页面据此判断「被要求复位的是不是我」——比对 `view` 与自身视图 id 即可，
 * 从而不必各自 import tabNavigation（保持事件解耦）。
 */
export interface TabRootResetDetail {
  /** 被点击的 Tab */
  tab: string;
  /** 该 Tab 的根视图（TAB_ROOT_VIEW[tab]） */
  view: CurrentView;
}

export interface NavigateToTabDetail {
  tabName: string;
}

export interface NavigateToViewDetail {
  view?: string;
  returnTo?: string;
  returnPayload?: unknown;
  openResource?: string;
}

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'apis'
  | 'models'
  | 'params'
  | 'search'
  | 'mcp'
  | 'statistics'
  | 'automation'
  | 'data-governance'
  | 'shortcuts'
  | 'about'
  | 'voice-input'
  | 'memory'
  | 'workbench'
  | 'document-processing';

export interface SettingsNavigateTabDetail {
  tab: SettingsTabId;
  dataGovernanceTab?: string;
}

export interface KnowledgeNavigateDetail {
  preferTab?: 'manage' | 'memory';
  locator?: {
    sourceId?: string;
    resourceId?: string;
    resourceType?: string;
    title?: string;
    path?: string;
  };
}

export interface LearningHubOpenResourceDetail {
  dstuPath: string;
}

export interface LearningHubOpenExamDetail {
  sessionId: string;
  cardId?: string | null;
  mistakeId?: string | null;
}

export interface LearningHubOpenTranslationDetail {
  translationId: string;
  title?: string;
}

export interface LearningHubOpenEssayDetail {
  essayId: string;
  title?: string;
}

export interface LearningHubOpenNoteDetail {
  noteId: string;
  source?: string;
}

export interface PrefillChatInputDetail {
  content: string;
  autoSend?: boolean;
}

export interface ChatV2SetInputDetail {
  content: string;
  autoSend?: boolean;
}

export interface NavigateToSessionDetail {
  sessionId: string;
}

export interface ModernSidebarGroupActionDetail {
  action?: string;
}

export interface MobileAppNavigateDetail {
  view?: CurrentView;
}

export interface NavigateToExamSheetDetail {
  sessionId: string;
  cardId?: string;
  mistakeId?: string;
}

export interface NavigateToTranslationDetail {
  translationId: string;
  title?: string;
}

export interface NavigateToEssayDetail {
  essayId: string;
  title?: string;
}

export interface NavigateToNoteDetail {
  noteId: string;
  source?: string;
}

/** preview 壳 Quick Look 浮层（宿主见 workbench/apps/preview/quickLook.tsx） */
export interface WbPreviewQuickLookDetail {
  /** 目标资源 id；null 表示关闭 */
  resourceId: string | null;
  /**
   * 再次请求当前已打开的资源时是否关闭（空格 Quick Look 的开关语义）。
   * 默认 true；传 false 表示"确保打开"（如方向键切换选中项时跟随刷新）。
   */
  toggle?: boolean;
}

/** A3-P0：解析会话创建完成的载荷 */
export interface AnalysisSessionCreatedDetail {
  sessionId: string;
  imageCount: number;
}

export interface AppEventPayloads {
  [APP_EVENTS.SYSTEM_SETTINGS_CHANGED]: SystemSettingsChangedDetail;
  [APP_EVENTS.WORKBENCH_MODE_CHANGED]: WorkbenchModeChangedDetail;
  [APP_EVENTS.VIEW_SWITCHED]: ViewSwitchedDetail;
  [APP_EVENTS.TAB_ROOT_RESET]: TabRootResetDetail;
  [APP_EVENTS.NAVIGATE_TO_TAB]: NavigateToTabDetail;
  [APP_EVENTS.NAVIGATE_TO_VIEW]: NavigateToViewDetail;
  [APP_EVENTS.SETTINGS_NAVIGATE_TAB]: SettingsNavigateTabDetail;
  [APP_EVENTS.OPEN_IMPORT_CONVERSATION]: void;
  [APP_EVENTS.OPEN_CLOUD_STORAGE_SETTINGS]: void;
  [APP_EVENTS.OPEN_MARKDOWN_EDITOR]: void;
  [APP_EVENTS.OPEN_NOTES]: void;
  [APP_EVENTS.OPEN_CREPE_DEMO]: void;
  [APP_EVENTS.OPEN_CHAT_V2_TEST]: void;
  [APP_EVENTS.NAVIGATE_TO_KNOWLEDGE_BASE]: KnowledgeNavigateDetail;
  [APP_EVENTS.LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE]: KnowledgeNavigateDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE]: LearningHubOpenResourceDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_EXAM]: LearningHubOpenExamDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_TRANSLATION]: LearningHubOpenTranslationDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_ESSAY]: LearningHubOpenEssayDetail;
  [APP_EVENTS.LEARNING_HUB_OPEN_NOTE]: LearningHubOpenNoteDetail;
  [APP_EVENTS.PREFILL_CHAT_INPUT]: PrefillChatInputDetail;
  [APP_EVENTS.CHAT_V2_SET_INPUT]: ChatV2SetInputDetail;
  [APP_EVENTS.CHAT_GROUPS_UPDATED]: void;
  [APP_EVENTS.NAVIGATE_TO_SESSION]: NavigateToSessionDetail;
  [APP_EVENTS.MODERN_SIDEBAR_GROUP_ACTION]: ModernSidebarGroupActionDetail;
  [APP_EVENTS.MOBILE_APP_NAVIGATE]: MobileAppNavigateDetail;
  /** 命令面板新建会话；侧栏 group-action 复用时可带 action */
  [APP_EVENTS.CHAT_NEW_SESSION]: ModernSidebarGroupActionDetail | undefined;
  /** A3-P0：拍题解析会话创建完成（App 层据此切到 analysis-result 视图） */
  [APP_EVENTS.ANALYSIS_SESSION_CREATED]: AnalysisSessionCreatedDetail;
  [APP_EVENTS.NOTES_CREATE_NEW]: void;
  [APP_EVENTS.NAVIGATE_TO_EXAM_SHEET]: NavigateToExamSheetDetail;
  [APP_EVENTS.NAVIGATE_TO_TRANSLATION]: NavigateToTranslationDetail;
  [APP_EVENTS.NAVIGATE_TO_ESSAY]: NavigateToEssayDetail;
  [APP_EVENTS.NAVIGATE_TO_NOTE]: NavigateToNoteDetail;
  [APP_EVENTS.WB_PREVIEW_QUICK_LOOK]: WbPreviewQuickLookDetail;
}

type DetailArgs<K extends AppEventName> = [AppEventPayloads[K]] extends [void]
  ? []
  : undefined extends AppEventPayloads[K]
    ? [detail?: Exclude<AppEventPayloads[K], undefined>]
    : [detail: AppEventPayloads[K]];

export function dispatchAppEvent<K extends AppEventName>(
  type: K,
  ...args: DetailArgs<K>
): void {
  if (args.length === 0) {
    dispatchTypedEvent(type);
    return;
  }
  dispatchTypedEvent(type, args[0]);
}

export function addAppEventListener<K extends AppEventName>(
  type: K,
  handler: (detail: AppEventPayloads[K], event: CustomEvent<AppEventPayloads[K]>) => void,
  options?: boolean | AddEventListenerOptions,
  target: EventTargetKind = 'window',
): () => void {
  return addTypedEventListener<AppEventPayloads[K]>(type, handler, options, target);
}

export function toAppEventListener<K extends AppEventName>(
  handler: (detail: AppEventPayloads[K], event: CustomEvent<AppEventPayloads[K]>) => void,
): EventListener {
  return toTypedEventListener<AppEventPayloads[K]>(handler);
}
