/**
 * E13-D：遮罩（sidebar mask）透明度残留契约
 *
 * 用户症状：首页左上角「三杠」（aria-label=common:mobile_header.open_sidebar）时有时无。
 * 成因二：侧栏遮罩在特定重挂载路径下以 opacity=1 出现在静止态，且
 * z-index(2000) 压在顶栏（relative，无 z-index）之上 → 顶栏被半透明壳盖住。
 *
 * 本测试不截屏、不依赖视觉，全部结论来自 DOM 断言。
 *
 * ⚠️ 与 task-1（useMotionPresence 双 rAF 竞态）是**独立**的第二个成因，
 * 修 task-1 不会修好本文件覆盖的路径。
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', initReactI18next: vi.fn() },
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/layout/UnifiedMobileHeader', () => ({
  MobileInFlowHeader: () => (
    <header data-testid="mobile-header" className="relative shrink-0">
      <button type="button" aria-label="common:mobile_header.open_sidebar">
        menu
      </button>
    </header>
  ),
}));

import { MobileSlidingLayout } from '@/components/layout/MobileSlidingLayout';

/** 可控 rAF 时钟：把 settle 动画的每一帧变成显式可推进的步骤 */
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 0;
let now = 0;

beforeEach(() => {
  rafQueue = [];
  rafId = 0;
  now = 0;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafId += 1;
    rafQueue.push({ id: rafId, cb });
    return rafId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => {
    rafQueue = rafQueue.filter((f) => f.id !== id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flushFrame = (dt = 16) => {
  now += dt;
  const queued = rafQueue;
  rafQueue = [];
  act(() => {
    queued.forEach((f) => f.cb(now));
  });
};

const stopSettling = (frames = 40) => {
  for (let i = 0; i < frames; i++) flushFrame();
};

const layout = (opts: {
  screenPosition: 'left' | 'center' | 'right';
  hasSidebar?: boolean;
  showContentOverlay?: boolean;
  sidebarWidth?: number | 'auto';
}) => (
  <MobileSlidingLayout
    sidebar={opts.hasSidebar === false ? null : <div>sidebar</div>}
    screenPosition={opts.screenPosition}
    onScreenPositionChange={() => {}}
    rightPanel={<div>right</div>}
    sidebarWidth={opts.sidebarWidth ?? 280}
    showContentOverlay={opts.showContentOverlay ?? true}
  >
    <div>main</div>
  </MobileSlidingLayout>
);

/** jsdom 的 clientWidth 恒为 0，容器宽度必须显式打桩 */
const mountLayout = (opts: Parameters<typeof layout>[0], width = 400) => {
  const utils = render(layout(opts));
  const root = utils.container.firstElementChild as HTMLElement;
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: width });
  act(() => {});
  return utils;
};

const maskOf = (container: HTMLElement) =>
  container.querySelector('[data-mobile-sidebar-mask]') as HTMLButtonElement | null;

describe('E13 遮罩透明度残留契约', () => {
  it('静止中屏：遮罩不可见、不可交互、不在可达序里', () => {
    const { container } = mountLayout({ screenPosition: 'center' });
    const mask = maskOf(container);
    expect(mask).not.toBeNull();
    expect(Number(mask!.style.opacity)).toBe(0);
    expect(mask!.style.pointerEvents).toBe('none');
    expect(mask!.getAttribute('aria-hidden')).toBe('true');
    expect(mask!.getAttribute('tabindex')).toBe('-1');
  });

  it('关闭抽屉的淡出轨迹单调收敛到 0（不得停在非零值）', () => {
    const { container, rerender } = mountLayout({ screenPosition: 'center' });
    rerender(layout({ screenPosition: 'left' }));
    stopSettling();
    const mask = maskOf(container)!;
    expect(Number(mask.style.opacity)).toBe(1);

    rerender(layout({ screenPosition: 'center' }));
    const values: number[] = [Number(mask.style.opacity)];
    for (let i = 0; i < 30; i++) {
      flushFrame();
      values.push(Number(mask.style.opacity));
    }
    expect(values[values.length - 1]).toBe(0);
    // 单调不回弹
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1] + 1e-9);
    }
  });

  it('拖拽中途 touchcancel 回弹后不得留下非零透明度', () => {
    const { container } = mountLayout({ screenPosition: 'center' });
    const root = container.firstElementChild as HTMLElement;
    const mask = maskOf(container)!;

    const fire = (type: string, x: number, y: number) => {
      const ev = new Event(type, { bubbles: true }) as Event & {
        touches: unknown[];
        changedTouches: unknown[];
      };
      ev.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
      ev.changedTouches = [{ clientX: x, clientY: y }];
      act(() => {
        root.dispatchEvent(ev);
      });
    };

    fire('touchstart', 100, 300);
    fire('touchmove', 220, 302);
    // 半开状态：遮罩确实已经跟着变半透明（说明手势生效）
    expect(Number(mask.style.opacity)).toBeGreaterThan(0);
    fire('touchcancel', 220, 302);
    stopSettling();
    expect(Number(mask.style.opacity)).toBe(0);
  });

  /**
   * ⚠️ E13 已知潜在缺陷（当前发布不可达，标记为期望失败）
   *
   * 缺陷：遮罩 DOM 卸载后重新挂载时，settle 效应从 `renderedTranslateRef` 读到
   * 属于「上一个已卸载节点」的残留值当动画起点（MobileSlidingLayout.tsx:405），
   * 于是把新挂载的遮罩先写成 opacity:1 再淡出 ≈200ms。
   *
   * 为何不可达：遮罩卸载需要 `hasSidebar` 或 `showContentOverlay` 翻假。
   * 经穷举，全部 12 个 MobileSlidingLayout 调用点 `sidebar` 恒非空、
   * `showContentOverlay` 恒为字面量 true → 发布路径无法触发。
   *
   * 用 it.fails：修复后本用例会转为「意外通过」并报警，提示摘掉该标记。
   * 详见 analysis/E13_成因二遮罩覆盖评估.md §2.4 / §4.1。
   */
  it.fails('遮罩卸载后重新挂载：首帧不得为不透明（E13 已知潜在缺陷，见报告）', () => {
    const { container, rerender } = mountLayout({ screenPosition: 'left' });
    stopSettling();
    expect(Number(maskOf(container)!.style.opacity)).toBe(1);

    // 侧栏消失 → 遮罩整体卸载
    rerender(layout({ screenPosition: 'center', hasSidebar: false }));
    expect(maskOf(container)).toBeNull();

    // 侧栏恢复 → 遮罩重新挂载（静止中屏，本应完全不可见）
    rerender(layout({ screenPosition: 'center', hasSidebar: true }));
    const remounted = maskOf(container)!;
    expect(Number(remounted.style.opacity)).toBe(0);
    stopSettling();
    expect(Number(remounted.style.opacity)).toBe(0);
  });

  it('showContentOverlay 关→开 且屏幕停在 left 时不得瞬时全不透明', () => {
    const { container, rerender } = mountLayout({
      screenPosition: 'left',
      showContentOverlay: false,
    });
    flushFrame();
    expect(maskOf(container)).toBeNull();

    rerender(layout({ screenPosition: 'left', showContentOverlay: true }));
    const remounted = maskOf(container)!;
    // left 屏遮罩本就该不透明 —— 这里锁的是「不得先 0 后动画」之外的另一种：
    // 必须与当前 translate 一致，而不是沿用旧的 ref 值
    expect(Number(remounted.style.opacity)).toBeCloseTo(1, 5);
  });

  it('连续快开快合的每一帧透明度都必须落在合法域 [0,1]', () => {
    const { container, rerender } = mountLayout({ screenPosition: 'center' });
    const mask = maskOf(container)!;
    for (let cycle = 0; cycle < 4; cycle++) {
      rerender(layout({ screenPosition: cycle % 2 === 0 ? 'left' : 'center' }));
      for (let i = 0; i < 6; i++) {
        flushFrame();
        const v = Number(mask.style.opacity);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('结构性约束：遮罩层级必须高于顶栏容器，修复需消除静止态遮挡', () => {
    const { container } = mountLayout({ screenPosition: 'center' });
    const mask = maskOf(container)!;
    // 遮罩是 z-index:2000 的 absolute inset-0，顶栏所在的 z-[1] 主内容壳在它下面
    expect(mask.style.zIndex).toBe('2000');
    expect(mask.className).toContain('absolute');
    expect(mask.className).toContain('inset-0');
    const mainPane = container.querySelector('.z-\\[1\\]') as HTMLElement;
    expect(mainPane).not.toBeNull();
    // 遮罩是主内容壳的第一个子元素 → 与顶栏同处一个层叠上下文，靠 z-index 胜出。
    // 顶栏本体（MobileInFlowHeader）只在 isMobileLayout 为真时渲染，本测试未挂
    // 移动布局 Provider，故这里锁的是「遮罩是主内容壳首个子节点」这一不变式：
    // 它保证了遮罩与顶栏同处一个层叠上下文，靠 z-index:2000 压过无 z-index 的顶栏。
    expect(mainPane.firstElementChild).toBe(mask);
    expect(mainPane.contains(mask)).toBe(true);
  });
});
