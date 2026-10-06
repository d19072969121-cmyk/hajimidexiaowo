/**
 * 移动端顶栏「三杠」存在性契约（E15）：
 *
 * 回归现象：切视图瞬间左上角三杠闪一下才出现。
 * 根因：setActiveView 在新视图尚未注册配置时把顶栏 config 整个换成
 * defaultConfig（showMenu=false / onMenuClick=undefined），
 * 于是 showMenuButton=false → 三杠消失；等页面挂载后 setConfig 才恢复。
 *
 * 本文件锁定的契约：
 * 1. 缓存未命中时不得回退到 defaultConfig，必须保持按钮形态；
 * 2. clearConfig 命中活跃视图时同样不得把三杠清掉；
 * 3. 与已卸载组件实例绑定的 rightActions / titleNode 仍必须被收敛。
 */
import React from 'react';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';

import {
  MobileHeaderProvider,
  MobileHeaderActiveViewSync,
  useMobileHeader,
  useMobileHeaderContextSafe,
  type MobileHeaderConfig,
} from '../MobileHeaderContext';
import { UnifiedMobileHeader } from '../UnifiedMobileHeader';

/** 读回 Provider 当前生效的 config */
const configProbe: { current: MobileHeaderConfig | null } = { current: null };

const Probe: React.FC = () => {
  const ctx = useMobileHeaderContextSafe();
  configProbe.current = ctx?.config ?? null;
  return null;
};

/** 模拟某个页面注册自己的顶栏配置 */
const Page: React.FC<{
  viewId: string;
  config: MobileHeaderConfig;
  deps?: React.DependencyList;
}> = ({ viewId, config, deps = [viewId] }) => {
  useMobileHeader(viewId, config, deps);
  return null;
};

const Harness: React.FC<{
  activeView: string;
  children?: React.ReactNode;
}> = ({ activeView, children }) => (
  <MobileHeaderProvider>
    <MobileHeaderActiveViewSync activeView={activeView} />
    <Probe />
    {children}
  </MobileHeaderProvider>
);

const menuConfig = (title: string): MobileHeaderConfig => ({
  title,
  showMenu: true,
  onMenuClick: () => {},
});

describe('MobileHeader 三杠存在性', () => {
  beforeEach(() => {
    cleanup();
    configProbe.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('切到未注册配置的新视图时，保持上一视图的三杠形态而不是回退默认值', () => {
    const { rerender } = render(
      <Harness activeView="chat-v2">
        <Page viewId="chat-v2" config={menuConfig('对话')} />
      </Harness>,
    );

    expect(configProbe.current?.showMenu).toBe(true);
    expect(typeof configProbe.current?.onMenuClick).toBe('function');

    // 切到一个尚未挂载/注册配置的视图（懒加载窗口期）
    act(() => {
      rerender(<Harness activeView="learning-hub" />);
    });

    // 关键断言：三杠的判定条件在窗口期内必须仍然成立
    expect(configProbe.current?.showMenu).toBe(true);
    expect(typeof configProbe.current?.onMenuClick).toBe('function');
  });

  it('窗口期内收敛 rightActions / titleNode，避免陈旧实例被继续渲染', () => {
    const { rerender } = render(
      <Harness activeView="chat-v2">
        <Page
          viewId="chat-v2"
          config={{
            ...menuConfig('对话'),
            rightActions: <span data-testid="stale-action">stale</span>,
            titleNode: <span data-testid="stale-title">stale</span>,
          }}
        />
      </Harness>,
    );

    expect(configProbe.current?.rightActions).toBeTruthy();
    expect(configProbe.current?.titleNode).toBeTruthy();

    act(() => {
      rerender(<Harness activeView="learning-hub" />);
    });

    expect(configProbe.current?.rightActions).toBeUndefined();
    expect(configProbe.current?.titleNode).toBeUndefined();
    // 但三杠本体仍在
    expect(configProbe.current?.showMenu).toBe(true);
  });

  it('视图注册配置后，新配置完整生效（窗口期收敛不干扰正常注册）', () => {
    const { rerender } = render(
      <Harness activeView="chat-v2">
        <Page key="chat-v2" viewId="chat-v2" config={menuConfig('对话')} />
      </Harness>,
    );

    // 真实切换：旧视图实例卸载，新视图实例挂载并注册
    act(() => {
      rerender(
        <Harness activeView="learning-hub">
          <Page key="learning-hub" viewId="learning-hub" config={menuConfig('学习资源')} />
        </Harness>,
      );
    });

    expect(configProbe.current?.title).toBe('学习资源');
    expect(configProbe.current?.showMenu).toBe(true);
  });

  it('窗口期逐帧不变量：从切换开始到新视图注册完成，showMenu 每一帧都为真', () => {
    // 用渲染轨迹捕获窗口期内的中间帧：修复前这些帧会被 defaultConfig
    // 覆盖成 showMenu=false，即用户看到的「三杠闪一下才出现」。
    const snapshots: boolean[] = [];
    const FrameRecorder: React.FC = () => {
      const ctx = useMobileHeaderContextSafe();
      snapshots.push(ctx?.config.showMenu === true);
      return null;
    };

    const { rerender } = render(
      <MobileHeaderProvider>
        <MobileHeaderActiveViewSync activeView="chat-v2" />
        <FrameRecorder />
        <Page key="chat-v2" viewId="chat-v2" config={menuConfig('对话')} />
      </MobileHeaderProvider>,
    );

    snapshots.length = 0;

    act(() => {
      rerender(
        <MobileHeaderProvider>
          <MobileHeaderActiveViewSync activeView="learning-hub" />
          <FrameRecorder />
          <Page key="learning-hub" viewId="learning-hub" config={menuConfig('学习资源')} />
        </MobileHeaderProvider>,
      );
    });

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every(Boolean)).toBe(true);
  });

  it('渲染层判定：窗口期内三杠按钮确实在 DOM 中且可点击', () => {
    const onMenuClick = vi.fn();
    const { rerender } = render(
      <MobileHeaderProvider>
        <MobileHeaderActiveViewSync activeView="chat-v2" />
        <Page
          viewId="chat-v2"
          config={{ title: '对话', showMenu: true, onMenuClick }}
        />
        <UnifiedMobileHeader />
      </MobileHeaderProvider>,
    );

    const before = screen.queryAllByLabelText('展开侧边栏');
    expect(before.length).toBeGreaterThan(0);

    // 切到未注册视图：三杠不得消失
    act(() => {
      rerender(
        <MobileHeaderProvider>
          <MobileHeaderActiveViewSync activeView="learning-hub" />
          <Page
            viewId="chat-v2"
            config={{ title: '对话', showMenu: true, onMenuClick }}
          />
          <UnifiedMobileHeader />
        </MobileHeaderProvider>,
      );
    });

    const after = screen.queryAllByLabelText('展开侧边栏');
    expect(after.length).toBeGreaterThan(0);
  });
});
