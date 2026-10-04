/**
 * Tab 壳层路由映射（A3 轮次 · 阶段 0）
 *
 * 设计依据：/root/workspace/analysis/A3_TAB_ARCHITECTURE.md（路线乙）
 *
 * 职责边界（刻意收窄，务必保持）：
 * - 本模块是**纯数据 + 纯函数**，不含任何 React / 副作用 / DOM 访问；
 * - 它只回答一个问题：「给定一个当前视图，它属于哪些 Tab」；
 * - 它**不写** currentView，**不改** CurrentView 联合类型，**不改** canonicalizeView。
 *
 * 为什么独立成模块（而不是写在 App.tsx 里）：
 * tests/vitest/appNavigationFallback.test.ts:13-16 断言 src/App.tsx 内不得出现
 * `'analysis': 'chat-v2'` 这类 tab→view 映射字面量。把映射表放这里既避开该断言，
 * 也让映射表可被单测直接 import（无需渲染 React 树）。
 *
 * ⚠️ 四个必须知道的约束：
 * 1. **不是一对一**：chat-v2 同时属于 home 与 study（见 VIEW_TO_TABS 注释），
 *    所以类型是 Record<CurrentView, readonly TabId[]> 而非 Record<CurrentView, TabId>。
 * 2. **dashboard 归属搁置**（用户 2026 决定）：它在 DEPRECATED_VIEW_MAP 被重定向到
 *    data-management（canonicalView.ts:20），但本轮不为它做独立归属决策。
 *    实现方式是：本表**刻意为它留一个键**（TS 要求 Record 穷尽），值写成与
 *    data-management 相同的 ['me']。这样做的理由——若省略该键，TS 编译即失败；
 *    若写成别的 Tab，就等于"替用户做了决定"。写成与重定向目标一致是**唯一
 *    不构成决策的选择**：无论用户最终裁定 dashboard 归谁，只要 canonicalizeView
 *    的重定向还在，这个键的值在运行时永远不会被读到（canonicalizeView 先把它
 *    变成 'data-management'）。单测对此有专门断言（见
 *    tabNavigation.test.ts 的「dashboard 键是死键」用例）。
 * 3. **只覆盖 BASE_CANONICAL_VIEWS 的 12 个视图**；DEV_ONLY_VIEWS
 *    (crepe-demo / chat-v2-test / llm-playground) 不映射（见下方注释）。
 */

import type { CurrentView } from '@/types/navigation';
import { canonicalizeView } from '@/app/navigation/canonicalView';

/**
 * 五个主 Tab。
 *
 * 刻意不使用与 CurrentView 同名的标识（如 'chat-v2'），
 * 避免路由层与 Tab 层在同一命名空间里产生歧义。
 */
export type TabId = 'home' | 'study' | 'review' | 'media' | 'me';

/** Tab 渲染顺序的单一真相源（Tab Bar 必须按此顺序渲染） */
export const TAB_IDS: readonly TabId[] = ['home', 'study', 'review', 'media', 'me'] as const;

/** 语义化别名：渲染顺序 = Tab 声明顺序 */
export const TAB_ORDER: readonly TabId[] = TAB_IDS;

/**
 * 每个 Tab 的默认落地视图。
 *
 * 取值必须落在 BASE_CANONICAL_VIEWS 内，否则 canonicalizeView 会把导航
 * 静默兜底回 'chat-v2'（canonicalView.ts:53-56）——单测对此有断言。
 */
export const TAB_ROOT_VIEW: Readonly<Record<TabId, CurrentView>> = {
  home: 'chat-v2',
  // E4：study 改为落拍题页——拍题是这一格的主语义，也是整条链的起点。
  // chat-v2 仍属 ['home','study']（见 VIEW_TO_TABS），从拍题页进对话时高亮仍正确。
  study: 'capture',
  // A5：复习 Tab 不再直接落 flashcards（那只覆盖「单词卡片」一项），
  // 改为落复习入口页，由它分发到错题本 / 单词卡片 / 易错点 / 刷题。
  review: 'review-hub',
  media: 'learning-hub',
  me: 'settings',
} as const;

/**
 * 视图 → 所属 Tab（多对一；数组首项为「无记忆时的默认归属」）。
 *
 * 类型用 Record<CurrentView, ...> 强制穷尽：CurrentView 增删成员时 TS 会立刻报错，
 * 逼迫同步本表（这是有意为之，不要改成 Partial<Record<...>>）。
 *
 * 分组依据见 A3_TAB_ARCHITECTURE.md §3：
 * - home  首页/今日    ：chat-v2（会话）、todo
 * - study 拍题/答疑    ：chat-v2（同一宿主的答题态）
 * - review 错题/复习   ：flashcards、task-dashboard
 * - media 视频/知识    ：learning-hub、sandbox-workbench、pdf-reader
 * - me    我的         ：settings、data-management、skills-management、template-management、ui-lab
 *
 * ⚠️ chat-v2 同时属 home 与 study —— 这正是不能做成一对一映射的原因。
 *    消歧靠「当前 activeTab 记忆」：resolveTab() 的 preferred 参数。
 */
export const VIEW_TO_TABS: Readonly<Record<CurrentView, readonly TabId[]>> = {
  // home：默认落地会话，可切到待办
  'chat-v2': ['home', 'study'],

  // study：拍摄/答疑与 home 共用 chat-v2 宿主，靠 preferred 消歧
  // （此处不再重复 chat-v2 键——一个 view 只登记一行）

  // dashboard：归属搁置（用户决定）。值刻意与它的重定向目标 data-management 一致，
  // 从而不构成任何独立归属决策；canonicalizeView 会在查表前把它折叠成
  // 'data-management'，因此本键在运行时是死键（单测断言了这一点）。
  'dashboard': ['me'],

  // study：拍题页（E4）。旧注释「拍摄/答疑与 home 共用 chat-v2 宿主」在
  // study 改落 capture 后不再适用于本键本身，但 chat-v2 的双归属保留。
  'capture': ['study'],

  // review：知识卡片与易错点（E5 起分开）。二者都是 review Tab 的二级页。
  'knowledge-cards': ['review'],
  'weak-points': ['review'],
  // E6：错题详情独立页。由 review-hub 推入的二级页，同属 review Tab。
  'mistake-detail': ['review'],

  // review：制卡产出 → 闪卡消化
  'flashcards': ['review'],
  'task-dashboard': ['review'],
  // A5：复习入口页（错题本 / 单词卡片 / 易错点 / 刷题）
  'review-hub': ['review'],
  // E3：刷题入口页（温故新知 / 自己定类型）。刷题归 review Tab。
  'practice-hub': ['review'],

  // media：知识资源与文档阅读
  'learning-hub': ['media'],
  'sandbox-workbench': ['media'],
  'pdf-reader': ['media'],

  // home 的待办
  'todo': ['home'],

  // analysis-result（A3-P0，由 ui-recon 于本轮新增的 CurrentView 成员）：
  // 拍题 → 解析 → 错题 → 复习 链路的**中间环节**，是 study Tab 内发起
  // 拍题后的产物，故归属 study。
  // 注意它是**全屏任务页**语义（A3_TAB_ARCHITECTURE.md §4.1 的 F1），
  // 运行时应由宿主用 tabbar-hide: claim 隐藏 TabBar；此处登记 Tab 归属，
  // 是为了保证「用户从解析结果返回时」TabBar 能正确高亮回 study。
  'analysis-result': ['study'],

  // me：设置与治理
  'settings': ['me'],
  'data-management': ['me'],
  'skills-management': ['me'],
  'template-management': ['me'],
  'ui-lab': ['me'],

  // DEV_ONLY_VIEWS（约束 3：不映射）。
  // 它们仍在 CurrentView 联合里（Record 要求穷尽），但生产构建下
  // import.meta.env.DEV 为 false → CANONICAL_VIEWS 不含它们 →
  // canonicalizeView 会把它们折叠成 'chat-v2'，因此以下三个键在运行时不可达。
  // 值统一为 ['me']，与 resolveTab 的实际返回（chat-v2 → home）无关。
  'crepe-demo': ['me'],
  'chat-v2-test': ['me'],
  'llm-playground': ['me'],
};

/**
 * 兜底 Tab：视图无法归类时落到这里。
 *
 * 用 'home' 而非抛错，与本项目既有的「安静兜底」风格一致
 * （canonicalView.ts:55 的 `: 'chat-v2'`）。
 */
export const FALLBACK_TAB: TabId = 'home';

/**
 * canonicalizeView 的兜底视图（canonicalView.ts:55 的 `: 'chat-v2'`）。
 *
 * 用于区分「本来就是 chat-v2」与「未知字符串被兜底成 chat-v2」——
 * 见 viewBelongsToTab 的注释。
 */
const FALLBACK_VIEW: CurrentView = 'chat-v2';

/**
 * 判断字符串是否是合法 TabId。
 */
export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}

/**
 * 解析「当前视图 + 当前 Tab 记忆」→ 应高亮的 Tab。
 *
 * 输入会先经 canonicalizeView() 规范化：
 * - 传入 'dashboard' → 先变成 'data-management' → 得到 'me'
 *   （dashboard 因此自然「跳过」，本表不需要为它建键）
 * - 传入 'analysis' / 'notes' 等历史别名 → 同上
 * - 传入任意非法字符串 → canonicalizeView 兜底 'chat-v2' → 'home'
 *
 * @param view      当前视图（可以是任意字符串，方法内部负责规范化）
 * @param preferred 当前 activeTab 记忆；若该视图确实属于 preferred，则保持不跳
 */
export function resolveTab(view: CurrentView | string, preferred?: TabId | null): TabId {
  const canonical = canonicalizeView(view);
  const candidates = VIEW_TO_TABS[canonical];

  if (!candidates || candidates.length === 0) {
    return FALLBACK_TAB;
  }

  if (preferred && candidates.includes(preferred)) {
    return preferred;
  }

  return candidates[0];
}

/**
 * 该视图是否属于某一组 Tab（用于 Tab Bar 的「本 Tab 是否含此视图」判断）。
 *
 * ⚠️ 与 resolveTab 的语义差异（重要，不要合并这两个函数）：
 * - resolveTab() 是**导航决策**：永远要给出一个 Tab（用 FALLBACK_TAB 兜底），
 *   因为 Tab Bar 必须高亮某一格；
 * - viewBelongsToTab() 是**成员判断**：未知视图返回 false，因为它回答的是
 *   「这个 view 是不是登记在这一格下」，而 canonicalizeView 会把未知字符串
 *   兜底成 'chat-v2'（canonicalView.ts:55），若不额外校验，问任何垃圾字符串
 *   都会得到 true，使这个判断失去意义。
 *
 * 因此这里必须区分「本来就是 chat-v2」与「被兜底成 chat-v2」。
 */
export function viewBelongsToTab(view: CurrentView | string, tab: TabId): boolean {
  const canonical = canonicalizeView(view);
  // 兜底命中：原字符串既不是合法视图，也不在废弃映射表里，
  // 是 canonicalizeView 的静默 fallback 产物，不构成真实归属。
  if (canonical === FALLBACK_VIEW && view !== FALLBACK_VIEW) {
    return false;
  }
  return VIEW_TO_TABS[canonical]?.includes(tab) ?? false;
}

/**
 * 该视图是否是「多 Tab 共享」的（需要 activeTab 记忆消歧）。
 * 供测试与调试使用，渲染路径不需要它。
 */
export function isAmbiguousView(view: CurrentView | string): boolean {
  const canonical = canonicalizeView(view);
  return (VIEW_TO_TABS[canonical]?.length ?? 0) > 1;
}
