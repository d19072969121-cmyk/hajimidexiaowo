/**
 * E5 — 解析模式提示词契约
 *
 * ## 背景（真实用户问题）
 * 用户在真机拍整页题（一屏 4 道题）后，模型**把题目原样转录回来而不解题**，
 * 且 LaTeX 转义乱码（`CHX2∣∣O` 之类）。
 *
 * 根因定位在提示词层（非模型能力）：
 *   1. 未说明「图里可能有多道题」→ 模型不知如何组织输出，退化为逐字抄写
 *   2. 未禁止重述原文 →「仔细阅读题目内容」被理解为「先把题目写出来」
 *   3. OCR 文本以「【识别到的题目内容】」注入 → 模型自认是转录器；
 *      且 OCR 出错时以错误文本为准
 *   4. 首条消息「请分析这道题目」→「分析」被理解为「解析图片内容」
 *
 * 本契约把这些约束钉死，防止回归。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 剥离注释后再断言。
 *
 * 交叉审查实测教训：直接用原始源码做字符串匹配，**注释里的字面量也会命中**，
 * 契约可被「把代码注释掉但保留文本」规避（E3 的 onStartPractice 死 prop、
 * E4 的 onSubmitImages 都栽在这上面）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const code = stripComments(readFileSync(
  resolve(process.cwd(), 'src/features/chat/plugins/modes/analysis.ts'),
  'utf8',
));

describe('E5 解析提示词契约：必须明确禁止重述题目', () => {
  it('提示词含「不要重述」类约束', () => {
    expect(
      code.includes('不要重述'),
      '提示词未禁止重述题目：用户拍整页题时会得到「原样转录」而非解答（真实事故）。',
    ).toBe(true);
  });

  it('提示词要求逐题解答（多题自适应）', () => {
    expect(code).toMatch(/逐题/);
    // 多题是核心场景：一屏 4 道题时必须保留题号分题作答
    expect(code).toMatch(/保留题号|多道题|有多道/);
  });

  it('提示词要求先给答案再给解析', () => {
    expect(code).toMatch(/先给.*答案|明确答案/);
  });
});

describe('E5 解析提示词契约：OCR 文本必须被定位为「仅供参考」', () => {
  it('OCR 注入处标注了「仅供参考」或「可能有误」', () => {
    const idx = code.indexOf('ocrMeta.question');
    expect(idx, '未找到 ocrMeta.question 注入点').toBeGreaterThan(-1);
    // 取注入点前的一段（提示语在前）
    const before = code.slice(Math.max(0, idx - 400), idx);
    expect(
      before,
      'OCR 文本未标注为参考：模型会把 OCR 的错误当事实（实测出现过公式乱码）。',
    ).toMatch(/仅供参考|可能有.*误|以图片为准/);
  });

  it('明确要求「以图片为准」', () => {
    expect(code).toMatch(/以图片为准/);
  });

  it('不再使用易被误读为「转录」的旧措辞', () => {
    // 旧版把 OCR 文本标为「【识别到的题目内容】」，配合「分析要求」
    // 使模型把自己当转录器。此断言防止改回去。
    expect(code).not.toContain('【识别到的题目内容】');
  });
});

describe('E5 解析提示词契约：首条消息措辞', () => {
  it('首条消息用「解答」而非含糊的「分析」', () => {
    const idx = code.indexOf('store.sendMessage(');
    expect(idx).toBeGreaterThan(-1);
    const line = code.slice(idx, idx + 200);
    expect(
      line,
      '首条消息措辞含糊：「分析」易被理解为「解析图片内容」而非「解答题目」。',
    ).toMatch(/解答/);
  });

  it('首条消息提示了「可能有多道」', () => {
    const idx = code.indexOf('store.sendMessage(');
    const line = code.slice(idx, idx + 200);
    expect(line).toMatch(/多道|逐题/);
  });
});
