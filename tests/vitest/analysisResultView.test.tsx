/**
 * AnalysisResultView — 解析结果全屏视图的单测（A3-P0）
 *
 * 覆盖任务要求的三态（空态 / 加载态 / 有解析结果态）+ 错误态，
 * 外加「拍题入口可能不传数据」的健壮性边界：null / undefined / {} /
 * 字段类型不符 / 空字符串 / 纯空白，一律不得抛异常。
 *
 * 渲染断言用 data-testid，避免依赖 i18n 文案（vitest.setup.ts 固定 zh-CN，
 * 但文案改动不应让用例变红）。
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  AnalysisResultView,
  type AnalysisResultData,
} from '@/components/analysis/AnalysisResultView';

// MarkdownRenderer 走 react-markdown + rehype + 懒加载 KaTeX，链路重且与本页
// 职责无关（它已有自己的 __tests__）。这里替换为可断言的轻量替身，
// 使用例只验证「本页是否正确调用并传入内容」。
vi.mock('@/features/chat/components/renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

vi.mock('@/features/chat/components/renderers/StreamingMarkdownRenderer', () => ({
  StreamingMarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="streaming-markdown-renderer" data-streaming={String(isStreaming)}>
      {content}
    </div>
  ),
}));

// CustomScrollArea 依赖 ResizeObserver 等；用透明容器替身，保留内容渲染。
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const renderView = (props: React.ComponentProps<typeof AnalysisResultView> = {}) =>
  render(<AnalysisResultView {...props} />);

describe('AnalysisResultView', () => {
  // ==========================================================================
  // 三态之一：空态
  // ==========================================================================
  describe('空态', () => {
    it('不传 data 时渲染空态，不渲染错误态', () => {
      renderView();
      expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'empty');
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('analysis-result-error')).not.toBeInTheDocument();
    });

    it('data 为 null / 空对象 / 全空字段时同样落空态', () => {
      const { unmount: u1 } = renderView({ data: null });
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
      u1();

      const { unmount: u2 } = renderView({ data: {} });
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
      u2();

      renderView({ data: { question: '   ', answer: '', rawText: null, tags: [] } });
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
    });

    it('空态提供 onRetry 时渲染可点击的重试按钮', () => {
      const onRetry = vi.fn();
      renderView({ onRetry });
      fireEvent.click(screen.getByTestId('analysis-result-empty-action'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('空态无 onRetry 时不渲染重试按钮', () => {
      renderView();
      expect(screen.queryByTestId('analysis-result-empty-action')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 三态之二：加载态
  // ==========================================================================
  describe('加载态', () => {
    it('phase="loading" 时渲染加载态且带无障碍属性', () => {
      renderView({ phase: 'loading' });
      const view = screen.getByTestId('analysis-result-view');
      expect(view).toHaveAttribute('data-phase', 'loading');

      const loading = screen.getByTestId('analysis-result-loading');
      expect(loading).toBeInTheDocument();
      expect(loading).toHaveAttribute('aria-busy', 'true');
      expect(loading).toHaveAttribute('role', 'status');
    });

    it('加载态渲染自定义 loadingHint', () => {
      renderView({ phase: 'loading', loadingHint: '正在识别题目…' });
      expect(screen.getByText('正在识别题目…')).toBeInTheDocument();
    });

    it('加载态优先于已有内容（显式 phase 覆盖推导）', () => {
      renderView({ phase: 'loading', data: { question: '题目', answer: '解析' } });
      expect(screen.getByTestId('analysis-result-loading')).toBeInTheDocument();
      expect(screen.queryByTestId('analysis-result-question')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 三态之三：有解析结果态
  // ==========================================================================
  describe('有解析结果态', () => {
    const fullData: AnalysisResultData = {
      question: '解方程 $x^2 - 5x + 6 = 0$',
      answer: '因式分解得 $(x-2)(x-3)=0$，故 $x=2$ 或 $x=3$。',
      rawText: '原始 OCR：解方程 x^2-5x+6=0',
      tags: ['一元二次方程', '因式分解'],
      questionType: '解答题',
      imageCount: 2,
    };

    it('完整数据时进入 ready 态并渲染题干与解析', () => {
      renderView({ data: fullData });
      expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');

      expect(screen.getByTestId('analysis-result-question')).toBeInTheDocument();
      expect(screen.getByTestId('analysis-result-answer')).toBeInTheDocument();
      expect(screen.getByText(fullData.question as string)).toBeInTheDocument();
      expect(screen.getByText(fullData.answer as string)).toBeInTheDocument();
    });

    it('题干与解析交给 MarkdownRenderer 渲染（非流式）', () => {
      renderView({ data: fullData });
      expect(screen.getAllByTestId('markdown-renderer')).toHaveLength(2);
      expect(screen.queryByTestId('streaming-markdown-renderer')).not.toBeInTheDocument();
    });

    it('isStreaming=true 时解析走 StreamingMarkdownRenderer', () => {
      renderView({ data: fullData, isStreaming: true });
      const streaming = screen.getByTestId('streaming-markdown-renderer');
      expect(streaming).toBeInTheDocument();
      expect(streaming).toHaveAttribute('data-streaming', 'true');
      // 题干仍走静态渲染器
      expect(screen.getAllByTestId('markdown-renderer')).toHaveLength(1);
    });

    it('渲染标签与题目类型', () => {
      renderView({ data: fullData });
      expect(screen.getByTestId('analysis-result-tags')).toBeInTheDocument();
      expect(screen.getByText('一元二次方程')).toBeInTheDocument();
      expect(screen.getByText('因式分解')).toBeInTheDocument();
      expect(screen.getByTestId('analysis-result-question-type')).toHaveTextContent('解答题');
    });

    it('渲染图片数量提示', () => {
      renderView({ data: fullData });
      expect(screen.getByTestId('analysis-result-image-count')).toBeInTheDocument();
    });

    it('原始文本与题干不同时才渲染折叠块', () => {
      const { unmount } = renderView({ data: fullData });
      expect(screen.getByTestId('analysis-result-raw')).toBeInTheDocument();
      unmount();

      renderView({ data: { question: '同一段', rawText: '同一段' } });
      expect(screen.queryByTestId('analysis-result-raw')).not.toBeInTheDocument();
    });

    it('仅有题目（无解析）时仍进入 ready 态', () => {
      renderView({ data: { question: '只有题干' } });
      expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
      expect(screen.getByTestId('analysis-result-question')).toBeInTheDocument();
      expect(screen.queryByTestId('analysis-result-answer')).not.toBeInTheDocument();
    });

    it('仅有标签时也视为有内容', () => {
      renderView({ data: { tags: ['函数'] } });
      expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
      expect(screen.getByTestId('analysis-result-tags')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 健壮性：拍题入口可能不传数据 / 传脏数据
  // ==========================================================================
  describe('健壮性（数据缺失与类型不符）', () => {
    it('data 形状完全不符时不抛异常，落回空态', () => {
      // 模拟上游把字符串/数组误传成 data
      expect(() => renderView({ data: 'oops' as unknown as AnalysisResultData })).not.toThrow();
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
    });

    it('字段类型不符（数字/对象/嵌套数组）时被安全忽略', () => {
      const dirty = {
        question: 12345,
        answer: { nested: true },
        rawText: ['a', 'b'],
        tags: 'not-an-array',
        questionType: () => 'fn',
        imageCount: 'three',
      } as unknown as AnalysisResultData;

      expect(() => renderView({ data: dirty })).not.toThrow();
      // 无可展示内容 → 空态；且绝无未捕获异常导致的空白
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
    });

    it('tags 内混合脏项时只保留合法字符串并去重', () => {
      const dirty = {
        question: '题干',
        tags: ['A', '', '  ', null, 42, { x: 1 }, 'A', 'B'] as unknown as string[],
      } as AnalysisResultData;

      renderView({ data: dirty });
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('B')).toBeInTheDocument();
      // 'A' 去重后只有一个
      expect(screen.getAllByText('A')).toHaveLength(1);
    });

    it('imageCount 为负数/非有限数时不渲染图片提示', () => {
      const { unmount } = renderView({ data: { question: '题干', imageCount: -3 } });
      expect(screen.queryByTestId('analysis-result-image-count')).not.toBeInTheDocument();
      unmount();

      renderView({ data: { question: '题干', imageCount: Number.NaN } });
      expect(screen.queryByTestId('analysis-result-image-count')).not.toBeInTheDocument();
    });

    it('data 为 undefined 时走空态而非崩溃', () => {
      expect(() => renderView({ data: undefined })).not.toThrow();
      expect(screen.getByTestId('analysis-result-empty')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 错误态
  // ==========================================================================
  describe('错误态', () => {
    it('error 存在时推导为错误态并展示原文', () => {
      renderView({ error: 'OCR 服务不可用' });
      const view = screen.getByTestId('analysis-result-view');
      expect(view).toHaveAttribute('data-phase', 'error');
      expect(screen.getByTestId('analysis-result-error')).toHaveAttribute('role', 'alert');
      expect(screen.getByText('OCR 服务不可用')).toBeInTheDocument();
    });

    it('error 为空字符串/空白时不误判为错误态', () => {
      renderView({ error: '   ', data: { question: '题干' } });
      expect(screen.getByTestId('analysis-result-view')).toHaveAttribute('data-phase', 'ready');
    });

    it('显式 phase="error" 时即使无 error 文案也渲染错误态', () => {
      renderView({ phase: 'error' });
      expect(screen.getByTestId('analysis-result-error')).toBeInTheDocument();
    });

    it('错误态的重试按钮可触发 onRetry', () => {
      const onRetry = vi.fn();
      renderView({ phase: 'error', onRetry });
      fireEvent.click(screen.getByTestId('analysis-result-retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 交互
  // ==========================================================================
  describe('交互', () => {
    it('提供 onBack 时渲染返回按钮并可点击', () => {
      const onBack = vi.fn();
      renderView({ data: { question: '题干' }, onBack });
      fireEvent.click(screen.getByTestId('analysis-result-back'));
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('未提供 onBack 时不渲染返回按钮', () => {
      renderView({ data: { question: '题干' } });
      expect(screen.queryByTestId('analysis-result-back')).not.toBeInTheDocument();
    });

    it('提供 onNoteChange 时渲染可编辑笔记并回传输入', () => {
      const onNoteChange = vi.fn();
      renderView({ data: { question: '题干' }, note: '旧笔记', onNoteChange });

      const input = screen.getByTestId('analysis-result-note-input');
      expect(input).toHaveValue('旧笔记');

      fireEvent.change(input, { target: { value: '新笔记' } });
      expect(onNoteChange).toHaveBeenCalledWith('新笔记');
    });

    it('未提供 onNoteChange 时不渲染笔记区（只读宿主）', () => {
      renderView({ data: { question: '题干' } });
      expect(screen.queryByTestId('analysis-result-note')).not.toBeInTheDocument();
    });

    it('note 为非字符串脏值时输入框回落为空串', () => {
      const dirtyNote = 42 as unknown as string;
      renderView({ data: { question: '题干' }, note: dirtyNote, onNoteChange: vi.fn() });
      expect(screen.getByTestId('analysis-result-note-input')).toHaveValue('');
    });

    it('ready 态且存在可复制内容时渲染复制按钮', () => {
      renderView({ data: { question: '题干', answer: '解析' } });
      expect(screen.getByTestId('analysis-result-copy')).toBeInTheDocument();
    });

    it('空态不渲染复制按钮', () => {
      renderView();
      expect(screen.queryByTestId('analysis-result-copy')).not.toBeInTheDocument();
    });
  });
});
