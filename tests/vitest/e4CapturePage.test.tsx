/**
 * E4 — 拍题页测试
 *
 * 分两层（吸取 E3 教训：只测组件会漏掉 App 接线）：
 *   A. 组件行为：拍照/相册 input 存在与属性、选图、去重、上限、提交
 *   B. App 接线：study Tab 落点、提交回调传了、i18n key 齐
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/components/layout/MobileHeaderContext', () => ({
  useMobileHeader: () => undefined,
}));

import { CapturePage, CAPTURE_MAX_IMAGES } from '@/features/capture/pages/CapturePage';

/** 造一个 File（jsdom 不提供 image 类型校验，手动指定 type） */
function makeFile(name: string, size = 1024): File {
  const f = new File(['x'.repeat(8)], name, { type: 'image/png' });
  Object.defineProperty(f, 'size', { value: size });
  Object.defineProperty(f, 'lastModified', { value: 1000 });
  return f;
}

function pickInto(input: HTMLElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

/**
 * 覆盖 navigator.userAgent —— canCapturePhoto 的核心分支靠 UA 判定
 * （isAndroid()/isIOS()），不 mock UA 就测不到真机行为。
 * 用 defineProperty 覆盖 getter，并返回还原函数。
 */
function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}

describe('CapturePage：相机能力与采集', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 每个用例前复位 UA，避免上一例的 mock 串台（影响 canCapturePhoto 判定）
    setUserAgent('');
  });

  it('渲染隐藏的相机 input，且带 capture="environment"（手机唤起后置摄像头）', () => {
    render(<CapturePage />);
    const cam = screen.getByTestId('capture-camera-input') as HTMLInputElement;
    expect(cam).toBeInTheDocument();
    expect(cam.getAttribute('capture')).toBe('environment');
    expect(cam.getAttribute('accept')).toBe('image/*');
    expect(cam.type).toBe('file');
  });

  it('相册 input 不带 capture 属性（退化为普通选择）且支持多选', () => {
    render(<CapturePage />);
    const gal = screen.getByTestId('capture-gallery-input') as HTMLInputElement;
    expect(gal.getAttribute('capture')).toBeNull();
    expect(gal.multiple).toBe(true);
  });

  it('从相册选图后进入已选列表，并出现提交按钮', () => {
    render(<CapturePage onSubmitImages={vi.fn()} />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png')]);

    expect(screen.getByTestId('capture-selected')).toBeInTheDocument();
    expect(screen.getByTestId('capture-selected-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('capture-submit')).toBeInTheDocument();
  });

  it('非图片文件被忽略', () => {
    render(<CapturePage />);
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' });
    pickInto(screen.getByTestId('capture-gallery-input'), [txt]);
    expect(screen.queryByTestId('capture-selected')).not.toBeInTheDocument();
  });

  it('同名同大小的重复图不会重复加入（去重）', () => {
    render(<CapturePage />);
    const input = screen.getByTestId('capture-gallery-input');
    pickInto(input, [makeFile('a.png')]);
    pickInto(input, [makeFile('a.png')]);
    expect(screen.getAllByTestId(/capture-selected-item-/)).toHaveLength(1);
  });

  it('超过上限的图被截断', () => {
    render(<CapturePage />);
    const many = Array.from({ length: CAPTURE_MAX_IMAGES + 3 }, (_, i) => makeFile(`f${i}.png`));
    pickInto(screen.getByTestId('capture-gallery-input'), many);
    expect(screen.getAllByTestId(/capture-selected-item-/)).toHaveLength(CAPTURE_MAX_IMAGES);
  });

  it('可移除单张', () => {
    render(<CapturePage />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png')]);
    fireEvent.click(screen.getByTestId('capture-remove-0'));
    expect(screen.queryByTestId('capture-selected')).not.toBeInTheDocument();
  });

  it('可清空全部', () => {
    render(<CapturePage />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png'), makeFile('b.png')]);
    fireEvent.click(screen.getByTestId('capture-clear'));
    expect(screen.queryByTestId('capture-selected')).not.toBeInTheDocument();
  });

  it('提交把已选文件交给 onSubmitImages', () => {
    const onSubmit = vi.fn();
    render(<CapturePage onSubmitImages={onSubmit} />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png')]);
    fireEvent.click(screen.getByTestId('capture-submit'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toHaveLength(1);
  });

  it('未选图时提交按钮不出现（无从提交）', () => {
    render(<CapturePage onSubmitImages={vi.fn()} />);
    expect(screen.queryByTestId('capture-submit')).not.toBeInTheDocument();
  });

  it('isSubmitting 时提交按钮禁用', () => {
    render(<CapturePage onSubmitImages={vi.fn()} isSubmitting />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png')]);
    expect(screen.getByTestId('capture-submit')).toBeDisabled();
  });

  it('isSubmitting 时再提交不回调（防重复建会话）', () => {
    const onSubmit = vi.fn();
    render(<CapturePage onSubmitImages={onSubmit} isSubmitting />);
    pickInto(screen.getByTestId('capture-gallery-input'), [makeFile('a.png')]);
    fireEvent.click(screen.getByTestId('capture-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('error 时展示错误文案', () => {
    render(<CapturePage error="读取图片失败" />);
    expect(screen.getByTestId('capture-error')).toHaveTextContent('读取图片失败');
  });

  it('桌面端（无 capture 能力）只显示相册入口', () => {
    // 显式 mock UA 为桌面：这样测的是「canCapturePhoto 的 UA 判定分支」这一**真行为**，
    // 而不是 jsdom 恰好不实现 capture 属性的环境巧合。
    // （交叉审查指出：原写法未 mock UA，UA 判定写坏成恒 false 时该用例照样绿。）
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    render(<CapturePage />);
    expect(screen.queryByTestId('capture-take-photo')).not.toBeInTheDocument();
    expect(screen.getByTestId('capture-pick-gallery')).toBeInTheDocument();
  });

  it('Android（canCapturePhoto 的主路径）显示拍照入口', () => {
    // canCapturePhoto 的主路径是 isAndroid()/isIOS()（inputBarCapabilities.ts:42），
    // 必须显式 mock UA 才能覆盖到真机上的核心行为。
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36');
    render(<CapturePage />);
    expect(
      screen.getByTestId('capture-take-photo'),
      'Android 下未显示拍照入口：真机上用户无法拍题（只能从相册选）',
    ).toBeInTheDocument();
  });

  it('iOS 同样显示拍照入口', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    render(<CapturePage />);
    expect(screen.getByTestId('capture-take-photo')).toBeInTheDocument();
  });
});

// ============================================================================
// B. App 层接线（E3 教训：只测组件会漏掉 App 是否真的接上）
// ============================================================================

describe('E4 App 接线契约：拍题页接入 study Tab', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  const tabSource = readFileSync(resolve(process.cwd(), 'src/config/tabNavigation.ts'), 'utf8');

  /**
   * 剥离注释后的源码。
   *
   * ⚠️ 交叉审查**实测复现**过：直接用原始源码做字符串匹配可被规避——
   * 把 `onSubmitImages={captureToAnalysisSession}` 改成 JSX 注释后，
   * 字面量仍在文件里，断言照样通过（prop 真断了却测不出来）。
   * E3 的 `onStartPractice` 死 prop 也是这样漏掉的。
   * 故所有源码级接线断言都必须先剥离注释。
   */
  const stripComments = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const appCode = stripComments(appSource);

  it('study Tab 的落地视图是 capture', () => {
    expect(tabSource).toMatch(/study:\s*'capture'/);
  });

  it('capture 归属 study Tab', () => {
    expect(tabSource).toMatch(/'capture':\s*\['study'\]/);
  });

  it('App 渲染了 LazyCapturePage 并传入 onSubmitImages', () => {
    const idx = appCode.indexOf('<LazyCapturePage');
    expect(idx, '未找到 <LazyCapturePage> 渲染点').toBeGreaterThan(-1);
    const jsx = appCode.slice(idx, appCode.indexOf('/>', idx) + 2);
    expect(jsx, 'onSubmitImages 未接线：拍完照不会建会话，按钮点了没反应').toMatch(/onSubmitImages=\{/);
  });

  it('App 传入了 isSubmitting 与 error（否则处理中/失败无反馈）', () => {
    const idx = appCode.indexOf('<LazyCapturePage');
    const jsx = appCode.slice(idx, appCode.indexOf('/>', idx) + 2);
    expect(jsx).toMatch(/isSubmitting=\{/);
    expect(jsx).toMatch(/error=\{/);
  });

  it('建会话后先 setCurrentSessionId 再切视图（顺序错会导致解析页空态）', () => {
    // useActiveChatStore 经 getCurrentSessionId() 取 store；
    // 若先切视图再设当前会话，解析页挂载时拿不到会话 → 永远空态。
    const block = appCode.slice(
      appCode.indexOf('const captureToAnalysisSession'),
    );
    const setIdx = block.indexOf('sessionManager.setCurrentSessionId(session.id)');
    const viewIdx = block.indexOf("setCurrentView('analysis-result')");
    expect(setIdx).toBeGreaterThan(-1);
    expect(viewIdx).toBeGreaterThan(-1);
    expect(setIdx, 'setCurrentSessionId 必须在 setCurrentView 之前').toBeLessThan(viewIdx);
  });

  it('创建的会话 mode 是 analysis（错题本据此筛选）', () => {
    const block = appCode.slice(appCode.indexOf('const captureToAnalysisSession'));
    expect(block).toMatch(/mode:\s*'analysis'/);
  });
});
