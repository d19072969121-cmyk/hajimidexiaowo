/**
 * 🚀 性能优化：页面组件懒加载
 *
 * 将页面组件改为 React.lazy() 动态导入，
 * 减少初始 bundle 大小，加快首帧渲染。
 *
 * 清理说明（2026-01）：
 * - 移除废弃组件：MathWorkflowManager、BridgeToIrec、IrecInsightRecall、
 *   IrecServiceSwitcher、MemoryIntakeDashboard（旧版）
 * - ★ 2026-01 移除：IrecGraphFlow、IrecGraphPage、IrecGraphFlowDemo（图谱模块已废弃）
 * - ★ 2026-02 优化：ChatV2Page 改为懒加载，大幅减少初始 bundle（含 DnD/framer-motion/chat-v2 init 等）
 *
 * 首屏必需（保持同步）：
 * - ModernSidebar（侧边栏）
 * - 基础 UI 组件
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './styles/page-loading.css';

// ============================================================================
// 懒加载 fallback 组件
// ============================================================================

/**
 * 页面加载占位符（极简，避免布局抖动）
 */
interface PageLoadingFallbackProps {
  fullScreen?: boolean;
}

export const PageLoadingFallback: React.FC<PageLoadingFallbackProps> = ({ fullScreen = false }) => {
  const { t } = useTranslation('common');
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsVisible(true), 220);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className={fullScreen ? 'page-loading-fallback page-loading-fallback--fullscreen bg-background' : 'page-loading-fallback bg-background'}
      role="status"
      aria-label={t('loading')}
      aria-busy="true"
    >
      <div className="page-loading-fallback__logo-wrap" data-visible={isVisible}>
        <img
          className="page-loading-fallback__logo"
          src="/logo-black.svg"
          alt=""
          aria-hidden="true"
          width="60"
          height="60"
        />
        <img
          className="page-loading-fallback__logo page-loading-fallback__shine"
          src="/logo-black.svg"
          alt=""
          aria-hidden="true"
          width="60"
          height="60"
        />
      </div>
    </div>
  );
};

// ============================================================================
// 懒加载页面组件
// ============================================================================

// 设置页
export const LazySettings = React.lazy(() =>
  import('./features/settings/components/Settings').then(m => ({ default: m.Settings }))
);

// ★ 2026-02：批量分析已废弃（旧错题系统已移除）
// ★ 2026-06-13：移除 LazyDashboard（components/Dashboard.tsx 旧仪表盘已被 SOTADashboardLite 取代且无人引用；后端 get_statistics 命令已移除，统计走 get_enhanced_statistics）

// SOTA 仪表盘
export const LazySOTADashboard = React.lazy(() =>
  import('./components/SOTADashboardLite').then(m => ({ default: m.SOTADashboard }))
);

// ★ 2026-07-08：移除 LazyLlmUsageStatsPage 死导出（llm-usage-stats 独立视图已并入 DataStats，
//   页面组件仍以 embedded 形态被 LlmUsageStatsSection 使用）

// 数据导入导出
export const LazyDataImportExport = React.lazy(() =>
  import('./components/DataImportExport').then(m => ({ default: m.DataImportExport }))
);

// 导入对话框
export const LazyImportConversationDialog = React.lazy(() =>
  import('./components/ImportConversationDialog').then(m => ({ default: m.ImportConversationDialog }))
);

// 技能管理（feature 公共出口转导出，见 features/skills-management/index.ts）
export const LazySkillsManagementPage = React.lazy(() =>
  import('./features/skills-management').then(m => ({ default: m.SkillsManagementPage }))
);

// 模板管理
export const LazyTemplateManagementPage = React.lazy(() =>
  import('./features/template-management/TemplateManagementApp').then(m => ({ default: m.default }))
);

// UI 样式调试
export const LazyStyleDebugPage = React.lazy(() =>
  import('./components/style-lab/StyleDebugPage')
);

// ★ 知识图谱已废弃（2026-01 移除）
// LazyIrecGraphFlow, LazyIrecGraphPage, LazyIrecGraphFlowDemo

// 学习中心
// ★ 2026-06-12：必须深路径导入。App.tsx 静态导入了 features/learning-hub barrel,
//   若此处动态导入同一 barrel,Rollup 会把 LearningHubPage 并入首屏 chunk,懒加载失效。
export const LazyLearningHubPage = React.lazy(() =>
  import('./features/learning-hub/LearningHubPage').then(m => ({ default: m.LearningHubPage }))
);

// Sandbox 工作台
export const LazySandboxWorkbenchPage = React.lazy(() =>
  import('./features/sandbox/pages/SandboxWorkbenchPage').then(m => ({ default: m.SandboxWorkbenchPage }))
);

// PDF 阅读器
export const LazyPdfReader = React.lazy(() =>
  import('./features/pdf/components/PdfReader').then(m => ({ default: m.default }))
);

// 待办事项
export const LazyTodoPage = React.lazy(() =>
  import('@/features/todo/components/TodoPage').then(m => ({ default: m.TodoPage }))
);

// 闪卡复习（传统壳页面；学习桌面 OS 模式仍走 workbench 应用壳）
export const LazyFlashcardsPage = React.lazy(() =>
  import('@/features/flashcards/FlashcardsApp').then(m => ({ default: m.FlashcardsApp }))
);

// A3-P0：解析结果全屏视图（拍题 → 解析 → 错题 → 复习 的中间环节）。
// 定位见 src/components/analysis/AnalysisResultPage.tsx 头部注释：
// 上游无独立解析页，本视图是 chat 会话的特殊展示态，属 study tab。
export const LazyAnalysisResultPage = React.lazy(() =>
  import('@/components/analysis/AnalysisResultPage').then(m => ({ default: m.AnalysisResultPage }))
);

// A5：复习入口页（错题本 / 单词卡片 / 易错点 / 刷题 四入口）。
// 视图 id 用 review-hub 而非 review——后者在 canonicalView.ts 的
// DEPRECATED_VIEW_MAP 里是历史废弃视图名，会被静默重定向到 chat-v2。
export const LazyReviewHubPage = React.lazy(() =>
  import('@/features/review/pages/ReviewHubPage').then(m => ({ default: m.ReviewHubPage }))
);

// E3：刷题入口页（温故新知 / 自己定类型）。刷题独立于卡片逻辑，自成一套。
export const LazyPracticeHubPage = React.lazy(() =>
  import('@/features/practice/pages/PracticeHubPage').then(m => ({ default: m.PracticeHubPage }))
);

// E8：刷题会话页（温故新知搜同类题 / 自己定类型选范围）—— 用户反馈 ③
export const LazyPracticeSessionPage = React.lazy(() =>
  import('@/features/practice/pages/PracticeSessionPage').then(m => ({ default: m.PracticeSessionPage }))
);

// E4：拍题页。study Tab 落地视图，整条链的起点。
// 相机能力复用上游的 capture="environment"（纯 Web 标准，无需原生插件）。
export const LazyCapturePage = React.lazy(() =>
  import('@/features/capture/pages/CapturePage').then(m => ({ default: m.CapturePage }))
);

// E5：知识卡片（原「单词卡片」改名）与易错点。用户要求二者分开，
// 此前都复用 flashcards 界面。
export const LazyKnowledgeCardsPage = React.lazy(() =>
  import('@/features/review/pages/KnowledgeCardsPage').then(m => ({ default: m.KnowledgeCardsPage }))
);
export const LazyWeakPointsPage = React.lazy(() =>
  import('@/features/review/pages/WeakPointsPage').then(m => ({ default: m.WeakPointsPage }))
);

// E6：错题详情独立页。此前点错题复用 analysis-result（「刚拍完的即时结果」），
// 语义不对——本页是「历史错题回顾」，故独立成页。
// 视图 id 用 mistake-detail：它曾是该表式的历史废弃名（重定向 chat-v2），
// 本次已在 canonicalView.ts 删除该重定向键后复活。
export const LazyMistakeDetailPage = React.lazy(() =>
  import('@/features/review/pages/MistakeDetailPage').then(m => ({ default: m.MistakeDetailPage }))
);

// 开发专用组件：生产构建中 import.meta.env.DEV 为 false，动态 import 被 Rollup 死代码消除
const DevNull: React.FC<any> = () => null;
const devLazy = () => Promise.resolve({ default: DevNull as React.ComponentType<any> });

export const LazyCrepeDemoPage = import.meta.env.DEV
  ? React.lazy(() => import('./components/dev/CrepeDemoPage').then(m => ({ default: m.CrepeDemoPage })))
  : React.lazy(devLazy);

export const LazyChatV2IntegrationTest = import.meta.env.DEV
  ? React.lazy(() => import('./features/chat/dev').then(m => ({ default: m.IntegrationTest })))
  : React.lazy(devLazy);

export const LazyLLMOutputPlayground = import.meta.env.DEV
  ? React.lazy(() => import('./features/chat/dev/playground').then(m => ({ default: m.LLMOutputPlayground })))
  : React.lazy(devLazy);

// 图片查看器
export const LazyImageViewer = React.lazy(() =>
  import('./components/ImageViewer').then(m => ({ default: m.ImageViewer }))
);

// 🚀 Chat V2 主页面（默认视图，改为懒加载以减少初始 bundle）
// 其依赖链包含 @dnd-kit/*、framer-motion、chat-v2/init 等重量级模块
export const LazyChatV2Page = React.lazy(() =>
  import('./features/chat/pages').then(m => ({ default: m.ChatV2Page }))
);
