/**
 * E13-D 回归测试：移动端 IME 组合期间「吞字」
 *
 * 根因（已实证）：受控 textarea 的 onChange 在组合期间跳过 store 回写时，
 * React 会在本次 onChange 的同步 flush 内把 DOM 回滚为旧 value prop ——
 * 用户敲的字在被真正看到之前就被抹掉，且与重渲染无关。
 *
 * 本文件锁死：组合期间及组合中途重渲染都必须保留文本，且不得重复追加。
 */
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ComposerTextarea } from '../ComposerTextarea';

// 驱动受控组件必须走原型上的原生 setter，否则 React 的 onChange 不会触发
const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  'value'
)!.set!;

const Harness: React.FC<{ isMobile: boolean; tick: number; writes: string[] }> = ({
  isMobile,
  tick,
  writes,
}) => {
  const [value, setValue] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const ghostRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <div data-tick={tick}>
      <ComposerTextarea
        textareaRef={textareaRef}
        ghostRef={ghostRef}
        viewportRef={viewportRef}
        inputValue={value}
        placeholder="placeholder"
        isMobile={isMobile}
        isStreaming={false}
        queueEnabled={false}
        showStop={false}
        sendShortcut="enter"
        textareaViewportHeight={40}
        onInputChange={(next) => {
          writes.push(next);
          setValue(next);
        }}
        onCaretPosChange={() => {}}
        adjustTextareaHeight={() => {}}
        scrollCaretIntoView={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onFocusChange={() => {}}
        onPaste={() => {}}
        skillSlash={{ open: false } as never}
        applySkillSlashSelection={() => false}
      />
    </div>
  );
};

const el = () =>
  document.querySelector('[data-testid="input-bar-v2-textarea"]') as HTMLTextAreaElement;

const compositionStart = () =>
  act(() => {
    el().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });

const type = (value: string) =>
  act(() => {
    nativeSetter.call(el(), value);
    el().dispatchEvent(new Event('input', { bubbles: true }));
  });

const compositionEnd = () =>
  act(() => {
    el().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

afterEach(cleanup);

describe('ComposerTextarea IME 组合输入（E13-D 吞字回归）', () => {
  it('移动端：组合结束后文本保留（核心回归）', () => {
    const writes: string[] = [];
    render(<Harness isMobile tick={0} writes={writes} />);
    compositionStart();
    type('你好');
    expect(el().value).toBe('你好');
    compositionEnd();
    expect(el().value).toBe('你好');
    expect(writes[writes.length - 1]).toBe('你好');
  });

  it('移动端：组合中途外部重渲染不丢字', () => {
    const writes: string[] = [];
    const { rerender } = render(<Harness isMobile tick={0} writes={writes} />);
    compositionStart();
    type('你好');
    rerender(<Harness isMobile tick={1} writes={writes} />);
    expect(el().value).toBe('你好');
    compositionEnd();
    expect(el().value).toBe('你好');
  });

  it('移动端：拼音增量组合每一步都不丢', () => {
    const writes: string[] = [];
    render(<Harness isMobile tick={0} writes={writes} />);
    compositionStart();
    for (const step of ['n', 'ni', 'nih', 'niha', 'nihao']) {
      type(step);
      expect(el().value).toBe(step);
    }
    compositionEnd();
    expect(el().value).toBe('nihao');
  });

  it('mobile 路径：DOM 与受控值保持一致（断言真实缺陷本身）', () => {
    // 缺陷复现的关键特征：组合期间 DOM 曾被立即清空。
    // 修复后该断言必须恒成立。
    const writes: string[] = [];
    render(<Harness isMobile tick={0} writes={writes} />);
    compositionStart();
    type('zhong');
    expect(el().value).not.toBe('');
    expect(writes).toContain('zhong');
  });

  it('compositionend 不重复追加（WKWebView 回归保护）', () => {
    const writes: string[] = [];
    render(<Harness isMobile tick={0} writes={writes} />);
    compositionStart();
    type('你好');
    compositionEnd();
    // 同一值不应被写入两次
    expect(writes).toEqual(['你好']);
  });

  it('桌面端组合输入不受影响', () => {
    const writes: string[] = [];
    render(<Harness isMobile={false} tick={0} writes={writes} />);
    compositionStart();
    type('你好');
    compositionEnd();
    expect(el().value).toBe('你好');
  });

  it('移动端非 IME 普通输入正常', () => {
    const writes: string[] = [];
    render(<Harness isMobile tick={0} writes={writes} />);
    type('hello');
    expect(el().value).toBe('hello');
    expect(writes).toEqual(['hello']);
  });
});
