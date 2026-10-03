/**
 * E2 — 自动归类引擎测试
 *
 * 分两层：
 *   A. 纯函数（buildClassifyPrompt / parseTagResponse / sanitizeTags）
 *      —— 这层是「模型返回脏数据怎么办」的防线，必须覆盖充分。
 *   B. classifySession 的编排（mock invoke）
 *      —— 验证「抽取 → 写入」的调用契约与失败降级。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import {
  buildClassifyPrompt,
  parseTagResponse,
  sanitizeTags,
  classifySession,
  MAX_AUTO_TAGS,
} from '@/features/review/classify/autoClassify';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

// ============================================================================
// A. 纯函数
// ============================================================================

describe('buildClassifyPrompt', () => {
  it('包含题目与解析文本', () => {
    const prompt = buildClassifyPrompt('解方程 x^2-5x+6=0', '因式分解得 (x-2)(x-3)=0');
    expect(prompt).toContain('解方程 x^2-5x+6=0');
    expect(prompt).toContain('因式分解得 (x-2)(x-3)=0');
  });

  it('明确要求 JSON 数组并限制数量（降模型乱输出的概率）', () => {
    const prompt = buildClassifyPrompt('q', 'a');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain(String(MAX_AUTO_TAGS));
  });

  it('超长输入被截断（避免把 prompt 撑爆）', () => {
    const huge = 'x'.repeat(10000);
    const prompt = buildClassifyPrompt(huge, huge);
    // 题干截到 1000、解析截到 2000
    expect(prompt.length).toBeLessThan(4000);
  });

  it('空输入不抛异常', () => {
    expect(() => buildClassifyPrompt('', '')).not.toThrow();
  });
});

describe('parseTagResponse：模型输出防御', () => {
  it('解析标准 JSON 数组', () => {
    expect(parseTagResponse('["一元二次方程","韦达定理"]')).toEqual(['一元二次方程', '韦达定理']);
  });

  it('解析带 markdown 围栏的输出', () => {
    expect(parseTagResponse('```json\n["定语从句","虚拟语气"]\n```'))
      .toEqual(['定语从句', '虚拟语气']);
  });

  it('解析无语言标记的围栏', () => {
    expect(parseTagResponse('```\n["函数单调性"]\n```')).toEqual(['函数单调性']);
  });

  it('解析模型带解释文字的输出（抓第一个数组片段）', () => {
    expect(parseTagResponse('好的，标签如下：\n["因式分解"]\n希望有帮助！'))
      .toEqual(['因式分解']);
  });

  it('对象包着数组时，取出内层数组（模型常见包装行为）', () => {
    // 刻意宽容：抽标签场景下，模型用 {"tags":[...]} 包一层很常见，
    // 多救回一次有效输出比严格拒绝更有价值。
    expect(parseTagResponse('{"tags":["a"]}')).toEqual(['a']);
  });

  it('对象里没有数组时返回空', () => {
    expect(parseTagResponse('{"tags":"不是数组"}')).toEqual([]);
    expect(parseTagResponse('{"message":"好的"}')).toEqual([]);
  });

  it('完全非 JSON 的文本返回空', () => {
    expect(parseTagResponse('我不知道')).toEqual([]);
  });

  it('非字符串输入返回空，不抛异常', () => {
    expect(parseTagResponse(null)).toEqual([]);
    expect(parseTagResponse(undefined)).toEqual([]);
    expect(parseTagResponse(123)).toEqual([]);
    expect(parseTagResponse({})).toEqual([]);
  });

  it('空字符串返回空', () => {
    expect(parseTagResponse('')).toEqual([]);
    expect(parseTagResponse('   ')).toEqual([]);
  });

  it('数组里混入非字符串元素时只留字符串', () => {
    expect(parseTagResponse('["有效标签", 123, null, "另一个"]'))
      .toEqual(['有效标签', '另一个']);
  });

  it('多行数组（模型常这么输出）', () => {
    expect(parseTagResponse('[\n  "标签A",\n  "标签B"\n]')).toEqual(['标签A', '标签B']);
  });
});

describe('sanitizeTags：清洗', () => {
  it('去空白、去空串', () => {
    expect(sanitizeTags(['  一元二次方程  ', '', '   '])).toEqual(['一元二次方程']);
  });

  it('去重', () => {
    expect(sanitizeTags(['代数', '代数', '几何'])).toEqual(['代数', '几何']);
  });

  it('截断到上限', () => {
    const many = Array.from({ length: 20 }, (_, i) => `标签${i}`);
    expect(sanitizeTags(many)).toHaveLength(MAX_AUTO_TAGS);
  });

  it('过滤过长条目（句子不是标签）', () => {
    expect(sanitizeTags(['这是一个非常非常长的句子不应该作为知识点标签使用'])).toEqual([]);
  });

  it('保留长度恰好的标签', () => {
    expect(sanitizeTags(['一元二次方程'])).toEqual(['一元二次方程']);
  });

  it('非字符串元素被丢弃', () => {
    expect(sanitizeTags([1, null, {}, [], '有效'])).toEqual(['有效']);
  });
});

// ============================================================================
// B. classifySession 编排
// ============================================================================

describe('classifySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('抽出标签后逐个调 chat_v2_add_tag', async () => {
    mockInvoke
      .mockResolvedValueOnce({ assistant_message: '["一元二次方程","韦达定理"]' })
      .mockResolvedValue(undefined);

    const written = await classifySession({
      sessionId: 's1',
      question: '解方程',
      answer: '因式分解',
    });

    expect(written).toEqual(['一元二次方程', '韦达定理']);
    expect(mockInvoke).toHaveBeenCalledWith('call_llm_for_boundary', {
      prompt: expect.stringContaining('解方程'),
    });
    expect(mockInvoke).toHaveBeenCalledWith('chat_v2_add_tag', {
      sessionId: 's1',
      tag: '一元二次方程',
    });
    expect(mockInvoke).toHaveBeenCalledWith('chat_v2_add_tag', {
      sessionId: 's1',
      tag: '韦达定理',
    });
  });

  it('题干与解析都空时不调 LLM（省 token）', async () => {
    const written = await classifySession({ sessionId: 's1', question: '', answer: '  ' });
    expect(written).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('LLM 调用失败时返回空数组，不抛异常', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('模型不可用'));
    const written = await classifySession({ sessionId: 's1', question: 'q', answer: 'a' });
    expect(written).toEqual([]);
  });

  it('模型没吐 JSON 时返回空数组，不写入任何标签', async () => {
    mockInvoke.mockResolvedValueOnce({ assistant_message: '我不确定' });
    const written = await classifySession({ sessionId: 's1', question: 'q', answer: 'a' });
    expect(written).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalledWith('chat_v2_add_tag', expect.anything());
  });

  it('单个标签写入失败不影响其余（部分成功）', async () => {
    mockInvoke
      .mockResolvedValueOnce({ assistant_message: '["甲","乙","丙"]' })
      .mockResolvedValueOnce(undefined)          // 甲成功
      .mockRejectedValueOnce(new Error('重复'))  // 乙失败
      .mockResolvedValueOnce(undefined);         // 丙成功

    const written = await classifySession({ sessionId: 's1', question: 'q', answer: 'a' });
    expect(written).toEqual(['甲', '丙']);
  });

  it('assistant_message 缺失时不崩', async () => {
    mockInvoke.mockResolvedValueOnce({});
    const written = await classifySession({ sessionId: 's1', question: 'q', answer: 'a' });
    expect(written).toEqual([]);
  });
});
