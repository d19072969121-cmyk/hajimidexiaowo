/**
 * MobileTabBar 契约（A3 轮次 · 阶段 1）
 *
 * 锁定三组不变量：
 * 1. **渲染闸门**：enabled / isMobile / hidden / tabbar-hide claim 四者同时成立才渲染；
 * 2. **前缀隔离**（本组件最重要的设计约束）：非 `tabbar-hide:` 前缀的 claim
 *    不得隐藏 TabBar——这是 A3_TAB_ARCHITECTURE.md §4.1 识别出的「幽灵 bug」防线；
 * 3. **禁用词**：组件不得直接消费 `isFullscreenContent`（README 级别的约束，
 *    用源码断言锁定，防止后来者「顺手简化」）。
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MobileTabBar,
  TABBAR_HIDE_CLAIM_PREFIX,
  TabBarHideClaimProvider,
  filterHideClaimIds,
  isHideClaimId,
  useTabBarHideClaim,
} from '@/components/navigation/MobileTabBar';
import { MobileLayoutProvider } from '@/components/layout/MobileLayoutContext';
import { TAB_IDS } from '@/config/tabNavigation';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      // 模拟真实 i18next：词条缺失时返回 key（本组件不给裸 key 是因为传了 defaultValue）
      return key;
    },
  }),
}));

/** 把组件挂在「移动端布局」下。matchMedia 在 vitest.setup.ts 里恒返回 matches:false，
 *  即 isSmallScreen=false ⇒ useBreakpoint().isSmallScreen=false ⇒ isMobile=false。
 *  因此需要显式声明移动端。这里直接 mock useBreakpoint。 */
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true, isMobile: true }),
}));

const renderTabBar = (props: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) =>
  render(
    <MobileLayoutProvider>
      <TabBarHideClaimProvider>
        <MobileTabBar activeTab="home" onSelectTab={() => {}} {...props} />
      </TabBarHideClaimProvider>
    </MobileLayoutProvider>,
  );

/** 消费 tabbar-hide claim 的测试探针 */
const HideClaimProbe: React.FC<{ reason: string | null }> = ({ reason }) => {
  useTabBarHideClaim(reason);
  return null;
};

/**
 * 通过公开 API 的「逃生舱」形态投递任意 claimId（{ rawClaimId }）。
 * 用它而非测试专用导出，因此 Provider 的拒绝路径是从公开 API 走到的。
 */
const RawClaimProbe: React.FC<{ claimId: string }> = ({ claimId }) => {
  useTabBarHideClaim({ rawClaimId: claimId });
  return null;
};

describe('MobileTabBar: 渲染闸门', () => {
  it('移动端布局下默认渲染出 5 格，顺序与 TAB_IDS 一致', () => {
    renderTabBar();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(TAB_IDS.length);
    expect(buttons.map((b) => b.getAttribute('data-mobile-tab'))).toEqual([...TAB_IDS]);
  });

  it('每格都有可读的 aria-label（无障碍底线）', () => {
    renderTabBar();
    for (const label of ['首页', '拍题', '复习', '知识', '我的']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('enabled=false 时不渲染', () => {
    const { container } = renderTabBar({ enabled: false });
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();
  });

  it('hidden=true 时不渲染（宿主显式全屏）', () => {
    const { container } = renderTabBar({ hidden: true });
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();
  });

  it('非移动端布局时不渲染', () => {
    // 直接渲染裸组件（不套 MobileLayoutProvider）→ useMobileLayoutSafe() 返回 null
    const { container } = render(<MobileTabBar activeTab="home" onSelectTab={() => {}} />);
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();
  });

  it('暴露 data-mobile-shell 与 data-active-tab 供上层样式/测试定位', () => {
    const { container } = renderTabBar({ activeTab: 'review' });
    const nav = container.querySelector('[data-mobile-shell="tabbar"]');
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute('data-active-tab')).toBe('review');
  });
});

describe('MobileTabBar: 高亮与交互', () => {
  it('activeTab 对应的格子带 aria-current="page"，其余不带', () => {
    renderTabBar({ activeTab: 'review' });
    expect(screen.getByRole('button', { name: '复习' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '首页' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: '知识' }).getAttribute('aria-current')).toBeNull();
  });

  it('点击某格回调携带正确的 TabId', () => {
    const onSelectTab = vi.fn();
    renderTabBar({ onSelectTab });

    fireEvent.click(screen.getByRole('button', { name: '知识' }));
    expect(onSelectTab).toHaveBeenCalledWith('media');

    fireEvent.click(screen.getByRole('button', { name: '我的' }));
    expect(onSelectTab).toHaveBeenCalledWith('me');

    expect(onSelectTab).toHaveBeenCalledTimes(2);
  });

  it('点击当前已高亮的 Tab 也会触发回调（由宿主决定是否 no-op）', () => {
    const onSelectTab = vi.fn();
    renderTabBar({ activeTab: 'home', onSelectTab });
    fireEvent.click(screen.getByRole('button', { name: '首页' }));
    expect(onSelectTab).toHaveBeenCalledWith('home');
  });

  it('回调返回 false 不影响组件自身状态（拦截由宿主负责）', () => {
    const onSelectTab = vi.fn(() => false);
    renderTabBar({ activeTab: 'home', onSelectTab });
    fireEvent.click(screen.getByRole('button', { name: '复习' }));
    // 组件仍是受控的：高亮不动
    expect(screen.getByRole('button', { name: '首页' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '复习' }).getAttribute('aria-current')).toBeNull();
  });

  it('每格都是 <button type="button">（防止在表单内误提交）', () => {
    renderTabBar();
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});

describe('MobileTabBar: 前缀判定纯函数（isHideClaimId / filterHideClaimIds）', () => {
  it('合规前缀：tabbar-hide: 开头的全部接受', () => {
    expect(isHideClaimId('tabbar-hide:review')).toBe(true);
    expect(isHideClaimId(`${TABBAR_HIDE_CLAIM_PREFIX}review-session:r1`)).toBe(true);
    // 冒号后为空也算合规（前缀本身完整即可，语义由调用方负责）
    expect(isHideClaimId('tabbar-hide:')).toBe(true);
  });

  it('非前缀：完全无关的字符串一律拒绝', () => {
    expect(isHideClaimId('no-prefix-claim')).toBe(false);
    expect(isHideClaimId('')).toBe(false);
    expect(isHideClaimId('tabbar')).toBe(false);
    expect(isHideClaimId('review-session')).toBe(false);
  });

  it('相似但非法：缺冒号 / 前缀被包在中间 / 大小写不符，全部拒绝', () => {
    // 防「只 startsWith 半个字面量」的粗糙实现被绕过
    expect(isHideClaimId('tabbar-hide-not-really')).toBe(false);
    expect(isHideClaimId('tabbar-hide')).toBe(false);      // 缺冒号
    expect(isHideClaimId('xxx-tabbar-hide:y')).toBe(false); // 前缀不在开头
    expect(isHideClaimId('TABBAR-HIDE:x')).toBe(false);     // 大小写敏感
    expect(isHideClaimId('tabbar_hide:x')).toBe(false);     // 下划线变体
  });

  it('另一条既有语义（tabbar-safe:）不再是合法前缀', () => {
    // Lead 已裁定只保留 hide 一条路径（见 A3_TAB_ARCHITECTURE.md §4.1 修订）
    expect(isHideClaimId('tabbar-safe:review')).toBe(false);
  });

  it('filterHideClaimIds 只保留合规项，且保持顺序、不修改原数组', () => {
    const input = [
      'tabbar-hide:a',
      'no-prefix',
      'tabbar-safe:b',
      'tabbar-hide:c',
      'tabbar-hide-not-really',
    ];
    const snapshot = [...input];

    expect(filterHideClaimIds(input)).toEqual(['tabbar-hide:a', 'tabbar-hide:c']);
    // 纯函数：不得就地排序/删除原数组
    expect(input).toEqual(snapshot);
  });

  it('filterHideClaimIds 对空数组返回空数组', () => {
    expect(filterHideClaimIds([])).toEqual([]);
  });
});

describe('MobileTabBar: tabbar-hide 前缀隔离（核心不变量）', () => {
  const renderWithProbe = (reason: string | null, props: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) =>
    render(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <HideClaimProbe reason={reason} />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} {...props} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );

  it('无 claim 时正常渲染', () => {
    const { container } = renderWithProbe(null);
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).not.toBeNull();
  });

  it('登记 tabbar-hide: claim 后隐藏', () => {
    const { container } = renderWithProbe('review-session');
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();
  });

  it('释放 claim 后恢复渲染', () => {
    const { container, rerender } = renderWithProbe('review-session');
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();

    rerender(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <HideClaimProbe reason={null} />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).not.toBeNull();
  });

  it('前缀常量值稳定（宿主依赖它拼 claimId）', () => {
    expect(TABBAR_HIDE_CLAIM_PREFIX).toBe('tabbar-hide:');
  });

  it('非 tabbar-hide: 前缀的 claim 不生效（Provider guard）', () => {
    // 「甲方案」的核心：前缀不变量由代码强制，而不是靠命名约定。
    // 经 useTabBarHideClaim 的逃生舱形态 { rawClaimId } 投递一个不带前缀的
    // claimId —— 走的是**公开 API**，因此 Provider 的拒绝路径是被真正执行到的，
    // 不依赖任何测试专用导出。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { container } = render(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <RawClaimProbe claimId="no-prefix-claim" />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );

    // 未被隐藏 —— guard 生效
    expect(container.querySelector('[data-mobile-shell="tabbar"]')).not.toBeNull();
    // 且给出了可排查的提示（dev 期可见），而不是静默吞掉
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('no-prefix-claim');

    warn.mockRestore();
  });

  it('tabbar-safe: 前缀的 claim 不生效（只有 hide 生效）', () => {
    // 实现只保留 tabbar-hide: 一条路径（Lead 已裁定，见 A3_TAB_ARCHITECTURE.md §4.1）。
    // 本用例把「仅 hide 前缀生效」这个事实固化成契约。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { container } = render(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <RawClaimProbe claimId="tabbar-safe:review" />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );

    expect(container.querySelector('[data-mobile-shell="tabbar"]')).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('前缀伪造无效：缺冒号的 tabbar-hide-not-really 被拒绝', () => {
    // 防「只 startsWith 字面量 tabbar-hide」的粗糙实现被绕过。
    expect('tabbar-hide-not-really'.startsWith(TABBAR_HIDE_CLAIM_PREFIX)).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <RawClaimProbe claimId="tabbar-hide-not-really" />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );

    expect(container.querySelector('[data-mobile-shell="tabbar"]')).not.toBeNull();
    warn.mockRestore();
  });

  it('合规前缀仍能生效（guard 没有误伤正常路径）', () => {
    // 反向对照：guard 若写成「一律拒绝」，上面三条会通过但这条会红。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <MobileLayoutProvider>
        <TabBarHideClaimProvider>
          <RawClaimProbe claimId={`${TABBAR_HIDE_CLAIM_PREFIX}review`} />
          <MobileTabBar activeTab="home" onSelectTab={() => {}} />
        </TabBarHideClaimProvider>
      </MobileLayoutProvider>,
    );

    expect(container.querySelector('[data-mobile-shell="tabbar"]')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('MobileTabBar: 幽灵 bug 防线（源码级）', () => {
  const rawSource = readFileSync(
    resolve(process.cwd(), 'src/components/navigation/MobileTabBar.tsx'),
    'utf-8',
  );

  /**
   * 剥掉注释后再做「不得出现某标识符」的断言。
   *
   * 为什么必须这么做：本组断言的原意是「组件**代码**不得消费 X」，但
   * 朴素写法 `expect(source).not.toContain('X')` 实际验证的是「全文不出现
   * 字符串 X」——只要注释里为了解释「为什么不消费 X」而提到 X，就会误判。
   * 本组件的头注释恰恰大量解释了为什么不复用 isFullscreenContent
   * （见 MobileTabBar.tsx:14/16/23/29/67），朴素写法必然假红。
   *
   * 这里做的是**保守剥离**：只移除注释，不改动代码文本，因此
   * 「代码里真的写了 X」仍然会被抓到。注释内出现 X 不再误报。
   */
  const stripComments = (text: string): string =>
    text
      // 行注释（避免误伤 URL 里的 //：要求 // 前不是冒号）
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      // 块注释（非贪婪，跨行）
      .replace(/\/\*[\s\S]*?\*\//g, '');

  const source = stripComments(rawSource);

  it('剥离注释后仍保留全部代码（防剥离逻辑自身失效）', () => {
    // 防空断言：若 stripComments 把代码也削没了，下面的 not.toContain 全部会
    // 空转通过。用几条确定的代码特征锁住剥离结果的有效性。
    expect(source).toContain('data-mobile-shell');
    expect(source).toContain('TAB_IDS.map');
    expect(source).toContain('onSelectTab');
    expect(source.length).toBeGreaterThan(rawSource.length * 0.5);
  });

  it('不直接消费 isFullscreenContent（会与输入栏 inset 语义串台）', () => {
    // A3_TAB_ARCHITECTURE.md §4.1 的最大风险点：
    // isFullscreenContent 的原语义是「抑制输入栏底部 inset」，当前唯一消费方是
    // InputBarUI.tsx:2341。TabBar 若直接读它，任何登记全屏 claim 的地方都会
    // 隐藏底部栏。本组件只认 tabbar-hide: 前缀。
    expect(source).not.toContain('isFullscreenContent');
  });

  it('不写 currentView / 不 import viewStore（受控组件，导航权在宿主）', () => {
    expect(source).not.toContain('setCurrentView');
    expect(source).not.toContain('useViewStore');
    expect(source).not.toContain('@/stores/');
  });

  it('不 import App.tsx（避免环形依赖与契约测试冲突）', () => {
    expect(source).not.toMatch(/from ['"][^'"]*App['"]/);
  });

  it('路由映射统一来自 config/tabNavigation（不在组件里自建映射表）', () => {
    expect(source).toContain("from '@/config/tabNavigation'");
    // 不允许在组件里硬编码 view→tab 的映射字面量
    expect(source).not.toMatch(/VIEW_TO_TABS\s*=/);
  });

  it('底部安全区走统一变量而非裸 env()（Android WebView 支持不完整）', () => {
    expect(source).toContain('var(--mobile-safe-area-bottom');
    expect(source).not.toContain('env(safe-area-inset-bottom');
  });

  it('触控目标达到 44px 底线（min-h-11 与既有启动器同口径）', () => {
    expect(source).toContain('min-h-11');
  });
});
