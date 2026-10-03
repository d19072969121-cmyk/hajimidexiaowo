/**
 * A3 接线契约测试 — 验证「组件真的被 App 挂载」而非只是写好躺着。
 *
 * 为什么需要这层：A3 之前的 159 个用例全绿，却因组件是孤岛而在真机上毫无表现。
 * 单元测试测的是组件自身，测不到「有没有被引用」。本契约用源码断言补齐这个盲区。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('A3 接线契约：App.tsx 必须真正引用 UI 组件', () => {
  it('import 了 MobileTabBar 与 TabBarHideClaimProvider', () => {
    expect(app).toContain("from '@/components/navigation/MobileTabBar'");
    expect(app).toMatch(/import\s*\{[^}]*MobileTabBar[^}]*\}/);
    expect(app).toMatch(/import\s*\{[^}]*TabBarHideClaimProvider[^}]*\}/);
  });

  it('在 JSX 里真的渲染了 <MobileTabBar', () => {
    expect(app).toMatch(/<MobileTabBar\b/);
  });

  it('用 TabBarHideClaimProvider 包裹（否则 claim 机制静默失效）', () => {
    expect(app).toMatch(/<TabBarHideClaimProvider>/);
    expect(app).toMatch(/<\/TabBarHideClaimProvider>/);
  });

  it('给 MobileTabBar 传了必需 props：activeTab / onSelectTab / enabled', () => {
    const m = app.match(/<MobileTabBar[\s\S]{0,400}?\/>/);
    expect(m, 'MobileTabBar 应作为自闭合元素被渲染').not.toBeNull();
    expect(m![0]).toMatch(/activeTab=\{/);
    expect(m![0]).toMatch(/onSelectTab=\{/);
    expect(m![0]).toMatch(/enabled=\{/);
  });

  it('activeTab 由 resolveTab(currentView) 推导，不是写死的', () => {
    expect(app).toMatch(/resolveTab\(currentView\)/);
  });

  it('onSelectTab 导航到 TAB_ROOT_VIEW[tab]（而非写死视图）', () => {
    expect(app).toMatch(/TAB_ROOT_VIEW\[tab\]/);
  });

  it('analysis-result 有 renderViewLayer 分支', () => {
    expect(app).toMatch(/renderViewLayer\(\s*'analysis-result'/);
  });

  it('注册了 LazyAnalysisResultPage 并 import 进来', () => {
    expect(app).toMatch(/LazyAnalysisResultPage/);
    expect(app).toMatch(/<LazyAnalysisResultPage\b/);
  });

  it('监听 ANALYSIS_SESSION_CREATED 并切视图（visitedViews 门禁的触发点）', () => {
    expect(app).toMatch(/APP_EVENTS\.ANALYSIS_SESSION_CREATED/);
    expect(app).toMatch(/setCurrentView\(\s*'analysis-result'/);
  });
});

describe('A3 接线契约：解析会话创建处必须广播事件', () => {
  const lifecycle = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/useSessionLifecycle.ts'), 'utf8');

  it('创建解析会话后 dispatch ANALYSIS_SESSION_CREATED', () => {
    expect(lifecycle).toMatch(/dispatchAppEvent\(/);
    expect(lifecycle).toMatch(/APP_EVENTS\.ANALYSIS_SESSION_CREATED/);
  });

  it('dispatch 在 setCurrentSessionId 之后（保证取数时 store 已就绪）', () => {
    const iSet = lifecycle.indexOf('setCurrentSessionId(session.id)');
    const iDispatch = lifecycle.indexOf('APP_EVENTS.ANALYSIS_SESSION_CREATED');
    expect(iSet).toBeGreaterThan(-1);
    expect(iDispatch).toBeGreaterThan(iSet);
  });
});

describe('A3 接线契约：i18n 词条已补齐', () => {
  it('zh-CN 与 en-US 都有 navigation.tabs.{aria_label,home,study,review,media,me}', () => {
    for (const loc of ['zh-CN', 'en-US']) {
      const d = JSON.parse(readFileSync(
        resolve(process.cwd(), `src/locales/${loc}/sidebar.json`), 'utf8'));
      const tabs = d?.navigation?.tabs;
      expect(tabs, `${loc} 缺少 navigation.tabs`).toBeTruthy();
      for (const k of ['aria_label', 'home', 'study', 'review', 'media', 'me']) {
        expect(tabs[k], `${loc} 缺少 navigation.tabs.${k}`).toBeTruthy();
      }
    }
  });
});

describe('A3 接线契约：五个 Tab 图标必须两两不同', () => {
  const bar = readFileSync(
    resolve(process.cwd(), 'src/components/navigation/MobileTabBar.tsx'), 'utf8');

  it('TAB_ICON 表内不出现重复图标组件', () => {
    const block = bar.match(/const TAB_ICON[\s\S]*?\n\};/)?.[0] ?? '';
    expect(block, '未找到 TAB_ICON 定义').not.toBe('');
    const icons = [...block.matchAll(/^\s*\w+:\s*(\w+),/gm)].map(m => m[1]);
    expect(icons.length).toBe(5);
    const dup = icons.filter((v, i) => icons.indexOf(v) !== i);
    expect(dup, `Tab 图标重复：${dup.join(', ')}`).toEqual([]);
  });

  it('五个 Tab 的图标全部来自 StudySidebarIcons（不混用其它来源）', () => {
    const block = bar.match(/const TAB_ICON[\s\S]*?\n\};/)?.[0] ?? '';
    const icons = [...block.matchAll(/^\s*\w+:\s*(\w+),/gm)].map(m => m[1]);
    for (const ic of icons) {
      expect(bar).toMatch(new RegExp(`\\b${ic}\\b[\\s\\S]{0,400}?from '@\\/components\\/icons\\/StudySidebarIcons'`));
    }
  });
});
