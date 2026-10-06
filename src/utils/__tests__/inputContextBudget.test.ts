/**
 * 输入预算推导契约（E15）。
 *
 * 背景：用户报「免 Key 模型还是不能用」，报错
 *   `context budget exceeded after safe trimming: estimated_input_tokens=7228
 *    limit=2048 removed_messages=0 trimmed_tail_chars=0`
 *
 * `limit=2048` 的直接来源就是本模块的推导下限。首页单轮对话的固定开销
 * （system + 工具定义 + 瞬态 `<request_context>` / `<skill_instructions>`
 * 注入）实测约 7.2K，任何小于它的下限都会让推导结果落进「必然超限」区间，
 * 后端 `enforce_request_input_budget` 随即中断整轮对话。
 *
 * 本文件锁定的契约：
 * 1. 推导下限必须大于首轮固定开销（~7.2K），否则等于埋雷；
 * 2. 「推断窗口 ≤ 输出预留」的矛盾配置不得推导出荒谬小值；
 * 3. 用户**显式**配置的小预算必须原样尊重，不被下限放大。
 */
import { describe, expect, it } from 'vitest';

import { deriveInputContextBudget, inferInputContextBudget } from '../modelCapabilities';

/** 线上实测：首页单轮对话的不可裁剪固定开销 */
const FIRST_TURN_FIXED_OVERHEAD_TOKENS = 7_228;

describe('deriveInputContextBudget 推导下限', () => {
  it('推导下限大于首轮固定开销（否则首页对话必然超限）', () => {
    // 「推断窗口 ≤ 输出预留」的矛盾配置：window=32768、输出=32768
    const budget = deriveInputContextBudget({
      contextWindow: 32_768,
      maxOutputTokens: 32_768,
    });

    expect(budget).toBeGreaterThan(FIRST_TURN_FIXED_OVERHEAD_TOKENS);
  });

  it('输出预留超过窗口时同样不产生荒谬小值', () => {
    const budget = deriveInputContextBudget({
      contextWindow: 32_768,
      maxOutputTokens: 65_536,
    });

    expect(budget).toBeGreaterThan(FIRST_TURN_FIXED_OVERHEAD_TOKENS);
  });

  it('免 Key 通道的真实形态：无显式窗口 + 大输出预留', () => {
    // 免 Key 模型没有 context_window，后端按 32768 兜底
    const budget = inferInputContextBudget({
      modelLike: { id: 'openai', name: 'Pollinations 免Key通道' },
      maxOutputTokens: 32_768,
    });

    expect(budget).toBeGreaterThan(FIRST_TURN_FIXED_OVERHEAD_TOKENS);
  });

  it('正常大窗口配置不受下限影响（推导值仍由窗口主导）', () => {
    const budget = deriveInputContextBudget({
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    });

    // 200000 - 8192 - 16000(headroom 8%) = 175808，远高于下限
    expect(budget).toBe(175_808);
  });
});

describe('deriveInputContextBudget 用户显式配置', () => {
  it('用户显式配置的小预算原样保留，不被推导下限放大', () => {
    const budget = deriveInputContextBudget({
      userContextLimit: 8_192,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    });

    expect(budget).toBe(8_192);
  });

  it('用户显式配置的极小值保留（只做 >0 保底，不做可用性放大）', () => {
    const budget = deriveInputContextBudget({
      userContextLimit: 2_048,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    });

    expect(budget).toBe(2_048);
  });
});
