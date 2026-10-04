import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getErrorDetails } from '@/utils/errorUtils';
// ★ 直接 import **真货**（方案 A）：数据层已抽到 bankClient.ts 并 export，
//   本契约不再复制一份实现 —— 复刻件漂移风险从根上消除（审查员任务 4 的发现）。
import { extractErrorCode } from '@/features/practice/questionBank/bankClient';

/**
 * 「额度耗尽」错误码契约 —— 消除前端与 Rust 文案的隐式耦合
 *
 * ## 背景（这是一次返工）
 * 用户反馈 ⑥ 的「找同类题」要区分三种失败态，其中「额度用尽」需给出注册引导。
 * 首版前端**靠匹配错误文案**（`'429'` / `'quota'` / `'额度'`）识别，但 Rust 的
 * 429 消息是「题庄题库额度已耗尽：匿名试用 24 小时 100 题…」——不含 `429`、
 * 不含 `quota`，**只是恰好含「额度」二字才没失效**。Rust 文案一改
 * （如「次数已用完」），前端立刻静默把额度耗尽误报成普通网络错误。
 *
 * ## 修法
 * Rust 在 `AppError.details` 里带 `{"code":"quota_exhausted"}`；
 * 前端 `extractErrorCode` 优先读结构化码，文案匹配降级为兜底。
 *
 * 本契约锁死两侧：**Rust 必须带码** + **前端必须能解析真实传输形态**。
 */

const ROOT = process.cwd();
const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');


describe('额度耗尽错误码契约（Rust ↔ Tauri ↔ 前端）', () => {
  it('Rust 侧 429 必须带结构化错误码 quota_exhausted', () => {
    const src = readSource('src-tauri/src/cmd/question_bank.rs');
    // 必须是 toMatch 到 with_details + code（而非仅 network 文案）
    const hasCode = /429\s*=>[\s\S]{0,300}?"code"\s*:\s*"quota_exhausted"/.test(src)
      || /429\s*=>[\s\S]{0,300}?quota_exhausted/.test(src);
    expect(
      hasCode,
      'Rust 的 429 分支没有带结构化错误码 —— 前端只能靠匹配文案识别（脆弱耦合），'
      + '文案一改就静默失效',
    ).toBe(true);
  });

  it('前端侧优先读结构化码，不只看文案', () => {
    // ★ 方案 A 后：实现住在 bankClient.ts（数据层），页面只做 UI
    const src = readSource('src/features/practice/questionBank/bankClient.ts');
    expect(src, '数据层缺少结构化码解析函数').toMatch(/export function extractErrorCode/);
    expect(
      src,
      'isQuotaError 未优先使用 extractErrorCode —— 仍以文案为唯一依据',
    ).toMatch(/isQuotaError[\s\S]{0,400}?extractErrorCode/);
  });

  it('数据层已被页面复用（消除复刻件的结构性前提）', () => {
    // 若页面又把实现内联回去，本断言会红 —— 防止「抽了但没用」的假重构
    const page = readSource('src/features/review/pages/MistakeDetailPage.tsx');
    expect(
      page,
      '页面未从 bankClient 导入数据层 —— 要么抽了没用，要么又内联了一份',
    ).toMatch(/from '@\/features\/practice\/questionBank\/bankClient'/);
    expect(
      page,
      '页面仍内联着 extractErrorCode 实现 —— 会出现两份真货并存',
    ).not.toMatch(/function\s+extractErrorCode/);
  });

  it('能解析 Tauri 的真实传输形态（AppError 塞在 Error.message 里）', () => {
    // errorUtils.ts:52-54 注释：「Tauri invoke 失败通常把 JSON 放在 Error.message 中」
    const payload = JSON.stringify({
      error_type: 'Network',
      message: '题庄题库额度已耗尽：匿名试用 24 小时 100 题，注册后可提升至 200 题/日',
      details: { code: 'quota_exhausted' },
    });
    expect(extractErrorCode(new Error(payload))).toBe('quota_exhausted');
  });

  it('能解析直接对象与嵌套 error 形态', () => {
    expect(
      extractErrorCode({ error_type: 'Network', message: 'x', details: { code: 'quota_exhausted' } }),
    ).toBe('quota_exhausted');
    expect(
      extractErrorCode({ error: JSON.stringify({ message: 'x', details: { code: 'quota_exhausted' } }) }),
    ).toBe('quota_exhausted');
  });

  it('文案改变后仍能识别（文本耦合已消除的证据）', () => {
    const payload = JSON.stringify({
      error_type: 'Network',
      message: '题庄题库次数已用完',   // ← 故意不含「额度」
      details: { code: 'quota_exhausted' },
    });
    expect(extractErrorCode(new Error(payload))).toBe('quota_exhausted');
  });

  it('普通错误不会被误判为额度耗尽', () => {
    expect(extractErrorCode(new Error('network timeout'))).toBeNull();
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode(undefined)).toBeNull();
  });

  it('自引用对象不导致崩溃（公共工具会爆栈，本页须兜住）', () => {
    const cyc: Record<string, unknown> = { message: 'x' };
    cyc.error = cyc;
    expect(() => extractErrorCode(cyc)).not.toThrow();
  });
});
