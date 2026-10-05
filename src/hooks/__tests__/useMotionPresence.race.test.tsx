import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMotionPresence } from '../useMotionPresence';

// ---------------------------------------------------------------------------
// 受控 rAF：把帧回调捕获进队列，让测试可以在「延迟显示的第一帧」与
// 「随后的重渲染」之间插入干扰。transition 分支在修复前零覆盖 —— 这就是
// bug 能溜到真机的原因。
//
// 修复后的进入契约（EnterFrameHandoff）：
//   1) 延迟只跨 1 帧，不是 2 帧；
//   2) 该帧之外还有一支短定时器兜底，帧被丢弃/节流都不会把 shown 永久卡在 false；
//   3) 与 open 无关的重渲染 / 依赖变化 / 帧被取消 都不得让 shown 停在 false。
//
// 判别性说明（重要）：前 3 条用例在修复前后都能通过（受控 rAF 下旧实现的
// 第二帧依然会被执行）。真正钉住本修复的是两条：
//   - 「进入延迟只跨 1 帧」：钉住延迟窗口从 2 帧缩到 1 帧（旧实现必失败）；
//   - 「关闭动画语义不变」：用兜底定时器路径到达终态，钉住兜底存在。
// 另外 Lead 的原始探针（见 /tmp/E13_race_probe.test.ts）在旧实现下返回
// shown=false、修复后返回 true，是本次修复的独立复现证据。
// ---------------------------------------------------------------------------

type CapturedFrame = { id: number; cb: FrameRequestCallback };

let rafQueue: CapturedFrame[];
let rafId: number;
const cancelled = new Set<number>();

function installControlledRaf() {
  rafQueue = [];
  rafId = 0;
  cancelled.clear();
  const request = (cb: FrameRequestCallback): number => {
    const id = ++rafId;
    rafQueue.push({ id, cb });
    return id;
  };
  const cancel = (id: number) => {
    cancelled.add(id);
  };
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  if (typeof window !== 'undefined') {
    (window as any).requestAnimationFrame = request;
    (window as any).cancelAnimationFrame = cancel;
  }
}

/** 执行所有存活帧；被 cancel 的回调不执行（真实浏览器语义）。 */
function runFrame() {
  const pending = rafQueue.splice(0, rafQueue.length);
  for (const { id, cb } of pending) {
    if (!cancelled.has(id)) cb(performance.now());
  }
}

/** 只执行下一个仍存活的帧。 */
function runNextLiveFrame() {
  const index = rafQueue.findIndex((f) => !cancelled.has(f.id));
  if (index === -1) return false;
  const [frame] = rafQueue.splice(index, 1);
  frame.cb(performance.now());
  return true;
}

/** 摘掉下一个存活帧并模拟它被清理函数取消。 */
function cancelNextLiveFrame() {
  const index = rafQueue.findIndex((f) => !cancelled.has(f.id));
  if (index === -1) return false;
  const [frame] = rafQueue.splice(index, 1);
  cancelled.add(frame.id);
  return true;
}

describe('useMotionPresence / transition 分支进入竞态', () => {
  beforeEach(() => {
    installControlledRaf();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('EnterFrameHandoff: 双帧之间被取消后，open 仍为 true 时 shown 自主收敛为 true', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open, tick }: { open: boolean; tick: number }) => {
        void tick; // 强制重渲染，但不改变 open
        return useMotionPresence(open, { exitMs: 350, enter: 'transition' });
      },
      { initialProps: { open: true, tick: 0 } },
    );

    expect(result.current.mounted).toBe(true);
    expect(result.current.shown).toBe(false);

    // 只驱动「第一帧」。旧实现里这一帧会再调度第二帧，shown 仍为 false；
    // 新实现里这一帧就是唯一的延迟帧。
    act(() => {
      runNextLiveFrame();
    });

    // 延迟窗口内发生一次与 open 无关的重渲染
    // （首页 LearningHubPage 高频引用导致的偶发重渲染即走这条路径）。
    // 把此刻仍挂在队列上的帧标记为「已被清理函数取消」——这正是旧实现
    // 在 rerender 时取消掉第二帧、且再没有任何路径把 shown 置回 true 的形态。
    act(() => {
      rerender({ open: true, tick: 1 });
      cancelNextLiveFrame();
    });

    // 不再驱动任何一帧：open 保持 true 就必须已有自主路径把 shown 拉回 true
    // （旧实现下这里永久为 false → 顶栏卡在 opacity-0）。
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.shown).toBe(true);
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);
  });

  it('EnterFrameHandoff: 唯一帧被取消 + 更重的重渲染压力下 shown 仍收敛为 true', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open, tick }: { open: boolean; tick: number }) => {
        void tick;
        return useMotionPresence(open, { exitMs: 350, enter: 'transition' });
      },
      { initialProps: { open: true, tick: 0 } },
    );

    // 连续 3 轮：刚入队的帧被取消，且每轮都夹一次与 open 无关的重渲染
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        cancelNextLiveFrame();
      });
      act(() => {
        rerender({ open: true, tick: i + 1 });
      });
    }

    // open 全程保持 true：必须已经自主到达终态，且没有被 cancel 打断在 false。
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.shown).toBe(true);
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);
  });

  it('EnterFrameHandoff: 依赖真的变化（exitMs 150→200）打断后 shown 仍收敛为 true', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open, exitMs }: { open: boolean; exitMs: number }) =>
        useMotionPresence(open, { exitMs, enter: 'transition' }),
      { initialProps: { open: true, exitMs: 150 } },
    );

    act(() => {
      runNextLiveFrame(); // 延迟帧执行，调度兜底定时器
    });

    // 依赖变化 → cleanup 取消定时器，effect 重跑（open 仍为 true）
    act(() => {
      rerender({ open: true, exitMs: 200 });
    });
    act(() => {
      runFrame();
      vi.advanceTimersByTime(200);
    });

    expect(result.current.shown).toBe(true);
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);
  });

  it('进入延迟只跨 1 帧：first commit 的 opacity-0 是正常的 from-state', () => {
    const { result } = renderHook(() =>
      useMotionPresence(true, { exitMs: 350, enter: 'transition' }),
    );

    // 首帧提交时 from-state 生效（这正是 transition 的起点）
    expect(result.current.shown).toBe(false);
    expect(result.current.mounted).toBe(true);

    // 只驱动一帧即进入终态
    act(() => {
      runFrame();
    });
    expect(result.current.shown).toBe(true);
  });

  it('连续多帧重渲染风暴下 shown 不会永久卡在 false', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open, tick, exitMs }: { open: boolean; tick: number; exitMs: number }) =>
        useMotionPresence(open, { exitMs, enter: 'transition' }),
      { initialProps: { open: true, tick: 0, exitMs: 150 } },
    );

    for (let i = 0; i < 6; i += 1) {
      act(() => {
        runFrame();
      });
      act(() => {
        rerender({ open: true, tick: i + 1, exitMs: i % 2 === 0 ? 150 : 200 });
      });
    }

    act(() => {
      runFrame();
      vi.advanceTimersByTime(200);
    });

    expect(result.current.shown).toBe(true);
  });

  it('关闭动画语义不变：exiting 为真、按 exitMs 计时后卸载', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useMotionPresence(open, { exitMs: 350, enter: 'transition' }),
      { initialProps: { open: true } },
    );

    // 进入延迟由兜底定时器接管（受控 rAF 下帧回调不会随机触发）
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.shown).toBe(true);

    act(() => {
      rerender({ open: false });
    });
    expect(result.current.exiting).toBe(true);
    expect(result.current.shown).toBe(false);
    expect(result.current.mounted).toBe(true);

    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(result.current.mounted).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.mounted).toBe(false);
    expect(result.current.exiting).toBe(false);
  });

  it('重新打开会取消进行中的关闭计时器（不留悬空卸载）', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useMotionPresence(open, { exitMs: 350, enter: 'transition' }),
      { initialProps: { open: true } },
    );

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.shown).toBe(true);

    act(() => {
      rerender({ open: false });
    });
    expect(result.current.exiting).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      rerender({ open: true });
    });
    expect(result.current.exiting).toBe(false);
    expect(result.current.mounted).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.shown).toBe(true);

    // 原关闭计时器若未被清理，会在 350ms 处把 mounted 打成 false
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.mounted).toBe(true);
    expect(result.current.shown).toBe(true);
  });
});
