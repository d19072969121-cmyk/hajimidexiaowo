/**
 * MobileTabBar — 移动端底部 5 Tab 导航（A3 轮次 · 阶段 1）
 *
 * 设计依据：/root/workspace/analysis/A3_TAB_ARCHITECTURE.md（路线乙）
 *
 * 职责（刻意收窄）：
 * - 只做「显示 5 格 + 高亮当前格 + 点击发出导航请求」三件事；
 * - **不写 currentView 本身**：点击通过 onSelectTab 回调交给宿主（App 层），
 *   由宿主决定落到哪个 view。本组件不 import viewStore，不 import App。
 * - **不做路由映射决策**：映射一律经 @/config/tabNavigation 的 resolveTab()。
 *
 * ⚠️ 全屏显隐的 claimId 前缀约定（本组件最重要的不变量）
 *
 * MobileLayoutContext 的 isFullscreenContent 的**原语义是「抑制输入栏底部 inset」**
 * （MobileLayoutContext.tsx:17-21 注释明示），当前唯一消费方是
 * InputBarUI.tsx:2341。若 TabBar 直接复用 isFullscreenContent 做显隐开关，
 * 会把两类互不相干的 claim 混成一个布尔：
 *   ① 「内容占满纵向空间」的 claim（MobileSlidingLayout 抽屉展开/拖拽，
 *      MobileSlidingLayout.tsx:342）—— 这类**应该**隐藏 TabBar；
 *   ② 未来可能的其他用途 —— 不一定应该隐藏 TabBar。
 * 混用会表现为「某些页面底部栏莫名消失」的幽灵 bug。
 *
 * 因此本组件**不使用 isFullscreenContent**，而是用 claimId 前缀自行判定：
 * - 只在 claimId 以 `tabbar-hide:` 开头时才隐藏（唯一受认可的全屏信号）；
 * - 同时导出 `TABBAR_HIDE_CLAIM_PREFIX` 供宿主登记 claim 时引用，
 *   避免各处手抄字符串。
 *
 * ⚠️ 依赖缺口（需 Lead 决策，见交接说明）
 * MobileLayoutContext 当前**只暴露聚合布尔** `isFullscreenContent`，
 * 不暴露 claimId 集合，因此本组件拿不到带前缀的 claim 列表。
 * 在不修改 MobileLayoutContext（该文件不在本任务写区）的前提下，
 * 本组件采取如下过渡方案：
 * - `hidden` prop 由宿主显式传入（宿主才是有能力判定全屏的层）；
 * - 本组件自带 `useTabBarHideClaim()` hook，**通过 context 同源登记**，
 *   并自行维护一个本地前缀过滤集合，从而在「不改 MobileLayoutContext」
 *   的前提下实现前缀语义。宿主登记 `tabbar-hide:` claim 后，
 *   本组件的 hook 会读到它。
 * 若 Lead 后续决定扩写 MobileLayoutContext（暴露 claims 集合），
 * 只需替换 useTabBarHideClaim 的实现，本组件的渲染契约不变。
 */

import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import {
  StudyBooksIcon,
  StudyCardsIcon,
  StudyChatIcon,
  StudyMagicWandIcon,
  StudySettingsIcon,
} from '@/components/icons/StudySidebarIcons';
import { TAB_IDS, type TabId } from '@/config/tabNavigation';
import { Z_INDEX } from '@/config/zIndex';

/**
 * 受认可的「隐藏 TabBar」claim 前缀。
 *
 * 宿主在需要全屏隐藏底部栏时，用 `${TABBAR_HIDE_CLAIM_PREFIX}<reason>` 登记；
 * 其他前缀的 claim 一律不影响 TabBar 显隐（这正是本前缀存在的意义）。
 */
export const TABBAR_HIDE_CLAIM_PREFIX = 'tabbar-hide:';

/**
 * TabBar 内部的前缀过滤 claim 集合。
 *
 * 该 context 只承载「以 tabbar-hide: 开头的 claim」，与
 * MobileLayoutContext.isFullscreenContent（全局聚合）互不干扰。
 *
 * ⚠️ 前缀不变量由 **Provider 的 enter() 在代码层强制**（见下方 guard），
 * 而不是靠调用方自觉或命名约定。这条不变量是 A3_TAB_ARCHITECTURE.md §4.1
 * 识别的最大风险点：MobileLayoutContext.isFullscreenContent 的原语义是
 * 「抑制输入栏底部 inset」（唯一消费方 InputBarUI.tsx:2341），若 TabBar 的
 * 显隐被任意 claim 影响，就会出现「某些页面底部栏莫名消失」的幽灵 bug。
 */
const TabBarHideClaimContext = createContext<{
  claims: ReadonlySet<string>;
  enter: (claimId: string) => void;
  exit: (claimId: string) => void;
} | null>(null);

/**
 * 前缀判定的**唯一实现**（纯函数，无 React / 无副作用）。
 *
 * 抽成纯函数的目的：这是本模块最重要的不变量（「只有 tabbar-hide: 前缀的
 * claim 才能影响 TabBar 显隐」），纯函数形态让它能被直接单测——覆盖合规前缀 /
 * 非前缀 / 缺冒号 / 相似非法写法等边界，而无需渲染 React 树或暴露测试专用入口。
 *
 * Provider 的 enter() 与下面所有调用方都走这里，不存在第二份判定逻辑。
 */
export const isHideClaimId = (claimId: string): boolean =>
  claimId.startsWith(TABBAR_HIDE_CLAIM_PREFIX);

/**
 * 把一批 claimId 过滤成「合法的 hide claim」。
 *
 * 纯函数，供 Provider 与测试共用；也是「按前缀过滤」这一语义的可执行定义。
 */
export const filterHideClaimIds = (claimIds: readonly string[]): string[] =>
  claimIds.filter(isHideClaimId);


/** 供宿主 Provider 使用：挂载后其子树内的 TabBar 可感知 tabbar-hide: claim */
export const TabBarHideClaimProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [claims, setClaims] = useState<Set<string>>(() => new Set());

  const enter = useCallback((claimId: string) => {
    // 前缀 guard：只有 tabbar-hide: 开头的 claim 才能影响 TabBar 显隐。
    // 判定走 isHideClaimId（唯一实现），不在此处重复写 startsWith。
    //
    // 为什么不 throw：TabBar 显隐是纯视觉问题，宿主传错 claimId 时把整页
    // 打白屏是比「底部栏没按预期隐藏」更糟的失败模式。这里静默拒绝 + warn，
    // dev 期可见、生产期不崩，且失败方向安全（TabBar 保持渲染，不会误隐藏）。
    if (!isHideClaimId(claimId)) {
      console.warn(
        `[MobileTabBar] 拒绝非 ${TABBAR_HIDE_CLAIM_PREFIX} 前缀的 claimId: ${claimId}。` +
          `宿主请改用 useTabBarHideClaim(reason)，由本模块统一加前缀。`,
      );
      return;
    }
    setClaims((prev) => {
      if (prev.has(claimId)) return prev;
      const next = new Set(prev);
      next.add(claimId);
      return next;
    });
  }, []);

  const exit = useCallback((claimId: string) => {
    // exit 不做前缀 guard：只需幂等移除。
    // 若对未登记的 id 也 warn，会在「enter 被拒 → 卸载时 exit」的正常路径上产生
    // 噪音日志，反而掩盖真正的误用。
    setClaims((prev) => {
      if (!prev.has(claimId)) return prev;
      const next = new Set(prev);
      next.delete(claimId);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ claims, enter, exit }), [claims, enter, exit]);
  return <TabBarHideClaimContext.Provider value={value}>{children}</TabBarHideClaimContext.Provider>;
};

/**
 * 宿主侧 hook：登记「隐藏底部 TabBar」。
 *
 * **推荐用法**（传 reason，前缀由本模块统一加）：
 * ```
 * useTabBarHideClaim(isReviewSession ? 'review-session' : null)
 * ```
 *
 * **逃生舱用法**（传 { rawClaimId }，用于需要自行拼前缀的场景）：
 * ```
 * useTabBarHideClaim({ rawClaimId: `${TABBAR_HIDE_CLAIM_PREFIX}custom:1` })
 * ```
 * 逃生舱同样过 Provider 的 guard：前缀不对会被拒绝并 warn。
 * 它同时让「Provider 真的会拒绝非法输入」这件事可以被测试从**公开 API**
 * 走到，无需任何测试专用导出。
 *
 * 幂等（同 claimId 重复登记不叠加），卸载时自动释放。
 *
 * @param input  字符串 reason / { rawClaimId } / null|undefined（不登记）
 */
export type TabBarHideClaimInput =
  | string
  | { rawClaimId: string }
  | null
  | undefined;

export function useTabBarHideClaim(input: TabBarHideClaimInput): void {
  const ctx = useContext(TabBarHideClaimContext);
  const uid = useId();

  const claimId =
    typeof input === 'string'
      ? `${TABBAR_HIDE_CLAIM_PREFIX}${input}:${uid}`
      : input && typeof input === 'object' && typeof input.rawClaimId === 'string'
        ? input.rawClaimId
        : null;

  // ⚠️ 依赖数组刻意只含 [claimId]，不含 ctx。
  // ctx 的**引用**来自 Provider 的 useMemo，该 memo 以 claims 为依赖，
  // 而 enter/exit 的 setState 又会改变 claims —— 若把 ctx 放进依赖，
  // 就形成「enter → claims 变 → value 变 → ctx 变 → effect 重跑 → enter」
  // 的渲染环，jsdom 下表现为 vitest worker 堆无限增长直至 4GB OOM
  // （与 react-i18next mock 注释里记录的同类陷阱同源）。
  // enter/exit 本身用 useCallback([]) 稳定，且内部对重复 claimId 做了幂等
  // 短路（prev.has 时返回原 Set），因此只依赖 claimId 是安全的。
  // 这里通过 ref 读取最新 ctx，避免闭包捕获旧值。
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    const current = ctxRef.current;
    if (!current || !claimId) return;
    current.enter(claimId);
    return () => ctxRef.current?.exit(claimId);
  }, [claimId]);
}

/** TabId → 图标。本轮 P0 只需要 4 个既有图标 + home 复用 chat 图标。 */
const TAB_ICON: Record<TabId, React.ElementType> = {
  home: StudyChatIcon,
  study: StudyMagicWandIcon,
  review: StudyCardsIcon,
  media: StudyBooksIcon,
  // 注意：me 曾与 study 同用 StudyMagicWandIcon，导致底栏出现重复图案。
  // 五个 Tab 图标必须两两不同，改动任何一个都要回头核对本表无重。
  me: StudySettingsIcon,
};

/**
 * TabId → i18n key 后缀。
 *
 * key 落在既有 `sidebar` 命名空间的 `navigation.tabs.*` 下
 * （由阶段 2 补齐 zh-CN/en-US 词条；本组件用 defaultValue 兜底，
 * 词条缺失时仍显示中文，不会渲染出裸 key）。
 */
const TAB_LABEL_KEY: Record<TabId, { key: string; fallback: string }> = {
  home: { key: 'sidebar:navigation.tabs.home', fallback: '首页' },
  study: { key: 'sidebar:navigation.tabs.study', fallback: '拍题' },
  review: { key: 'sidebar:navigation.tabs.review', fallback: '复习' },
  media: { key: 'sidebar:navigation.tabs.media', fallback: '知识' },
  me: { key: 'sidebar:navigation.tabs.me', fallback: '我的' },
};

export interface MobileTabBarProps {
  /** 当前应高亮的 Tab */
  activeTab: TabId;
  /** 点击某一格 → 宿主负责导航。返回 false 表示被拦截（如键盘弹出中） */
  onSelectTab: (tab: TabId) => void | boolean;
  /** 宿主显式要求隐藏（全屏任务页等）。默认为 false */
  hidden?: boolean;
  /** 仅渲染在移动端布局（<768px）。宿主通常传 isSmallScreen */
  enabled?: boolean;
  className?: string;
}

/**
 * 底部 Tab Bar。
 *
 * 渲染条件（全部满足才渲染）：
 * 1. enabled（宿主传入的移动端判定，通常 isSmallScreen）
 * 2. !hidden（宿主显式隐藏）
 * 3. 无活跃的 tabbar-hide: claim
 *
 * ⚠️ 本组件不消费 isLoading / 键盘状态：底部 Tab 在键盘弹出时由
 * Android adjustResize 自然被遮挡，与输入栏同一机制，无需特殊处理。
 */
export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeTab,
  onSelectTab,
  hidden = false,
  enabled = true,
  className,
}) => {
  const { t } = useTranslation(['sidebar']);
  const mobileLayout = useMobileLayoutSafe();
  const hideCtx = useContext(TabBarHideClaimContext);

  // 只有前缀过滤集合非空才算「被全屏 claim 隐藏」
  const claimedHidden = (hideCtx?.claims.size ?? 0) > 0;

  const isMobileLayout = mobileLayout?.isMobile ?? false;
  const shouldRender = enabled && isMobileLayout && !hidden && !claimedHidden;

  if (!shouldRender) return null;

  return (
    <nav
      data-mobile-shell="tabbar"
      data-active-tab={activeTab}
      aria-label={t('sidebar:navigation.tabs.aria_label', '主导航')}
      className={cn(
        'flex w-full shrink-0 items-stretch',
        'border-t border-[color:var(--shell-navigation-border)]',
        'bg-[color:var(--shell-navigation-surface)]',
        className,
      )}
      style={{
        // ⚠️ 必须用项目统一的安全区变量，不要直接用 env()：
        // Android WebView 对 env(safe-area-inset-*) 支持不完整，
        // 由 platform.ts:121-162 注入真实值、mobileShell.ts:7 做兜底映射。
        paddingBottom: 'var(--mobile-safe-area-bottom, 0px)',
        paddingLeft: 'var(--mobile-safe-area-left, 0px)',
        paddingRight: 'var(--mobile-safe-area-right, 0px)',
        height: 'calc(var(--mobile-tabbar-height, 52px) + var(--mobile-safe-area-bottom, 0px))',
        zIndex: Z_INDEX.fullscreenContent,
      }}
    >
      {TAB_IDS.map((tab) => {
        const Icon = TAB_ICON[tab];
        const isActive = tab === activeTab;
        const label = t(TAB_LABEL_KEY[tab].key, TAB_LABEL_KEY[tab].fallback);

        return (
          <button
            key={tab}
            type="button"
            data-mobile-tab={tab}
            aria-current={isActive ? 'page' : undefined}
            aria-label={label}
            onClick={() => onSelectTab(tab)}
            className={cn(
              // min-h-11 = 44px：Apple HIG / Material 触控目标底线
              // （与 MobileSidebarNavigation.tsx:173 的启动器格同口径）
              'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5',
              'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'text-[color:var(--shell-navigation-foreground)]'
                : 'text-[color:var(--shell-navigation-muted)]',
            )}
          >
            <Icon className="size-[22px] shrink-0" />
            {/* 不用 text-sm：typography.css 把 .text-sm 重定义为 12px，
                这里要 11px 的紧凑标签（同 MobileSidebarNavigation.tsx:174 的教训） */}
            <span className="text-[11px] leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
