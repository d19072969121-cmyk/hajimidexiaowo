/**
 * E3 — 题库 API 配置：纯函数与状态测试
 *
 * 覆盖用户规格的核心状态机：
 *   - 未配置 → 「去配置」按钮可点
 *   - 已配置 → 「已配置」按钮 disabled
 *   - 刷题页未配置时两个入口置灰
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import React from 'react';

import {
  QUESTION_BANK_PROVIDERS,
  QUESTION_BANK_CONFIG_KEY,
  isProviderConfigured,
  isQuestionBankReady,
  parseQuestionBankConfig,
  DEFAULT_QUESTION_BANK_CONFIG,
} from '@/features/practice/questionBank/config';

// ============================================================================
// A. 纯函数
// ============================================================================

describe('题库来源预设', () => {
  it('恰好三个预设：21世纪教育网 / 题庄 / 自定义', () => {
    // E5：智学网无官方开放平台，已替换为题庄（有正式 API + 匿名试用）
    expect(QUESTION_BANK_PROVIDERS.map((p) => p.id)).toEqual(['cn21', 'tizhuang', 'custom']);
  });

  it('题庄预设预填了接口地址（固定值，无需用户手填）', () => {
    const tz = QUESTION_BANK_PROVIDERS.find((p) => p.id === 'tizhuang')!;
    const baseUrlField = tz.fields.find((f) => f.key === 'baseUrl')!;
    expect(baseUrlField.defaultValue).toBe('https://tizhuang.qcscience.cc/api');
  });

  it('题庄的 License 非必填（留空走匿名试用）', () => {
    const tz = QUESTION_BANK_PROVIDERS.find((p) => p.id === 'tizhuang')!;
    const licenseField = tz.fields.find((f) => f.key === 'accessKey')!;
    expect(licenseField.required).toBeFalsy();
  });

  it('21世纪教育网带官方文档地址与沙箱地址', () => {
    const cn21 = QUESTION_BANK_PROVIDERS.find((p) => p.id === 'cn21')!;
    expect(cn21.docsUrl).toMatch(/21cnjy\.com/);
    expect(cn21.sandboxUrl).toMatch(/21cnjy\.com/);
  });

  it('每个来源都有唯一的字段 key（表单渲染依赖）', () => {
    for (const provider of QUESTION_BANK_PROVIDERS) {
      const keys = provider.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('isProviderConfigured', () => {
  it('必填字段全填才为 true', () => {
    expect(isProviderConfigured('cn21', { accessKey: 'k', baseUrl: 'https://x' })).toBe(true);
  });

  it('缺任一必填字段为 false', () => {
    expect(isProviderConfigured('cn21', { accessKey: 'k' })).toBe(false);
    expect(isProviderConfigured('cn21', { baseUrl: 'https://x' })).toBe(false);
  });

  it('空字符串 / 纯空白不算已填', () => {
    expect(isProviderConfigured('cn21', { accessKey: '  ', baseUrl: 'https://x' })).toBe(false);
  });

  it('凭据对象为 undefined 时为 false', () => {
    expect(isProviderConfigured('cn21', undefined)).toBe(false);
  });
});

describe('isQuestionBankReady', () => {
  it('未选来源时为 false（默认空，强制用户选）', () => {
    expect(isQuestionBankReady(DEFAULT_QUESTION_BANK_CONFIG)).toBe(false);
  });

  it('选了来源但没填齐仍为 false', () => {
    expect(isQuestionBankReady({ provider: 'cn21', credentials: {} })).toBe(false);
  });

  it('选了且填齐为 true', () => {
    expect(
      isQuestionBankReady({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    ).toBe(true);
  });
});

describe('parseQuestionBankConfig：畸形输入防御', () => {
  it('空值 / 非字符串 → 默认未配置', () => {
    expect(parseQuestionBankConfig(null)).toEqual(DEFAULT_QUESTION_BANK_CONFIG);
    expect(parseQuestionBankConfig('')).toEqual(DEFAULT_QUESTION_BANK_CONFIG);
    expect(parseQuestionBankConfig(123)).toEqual(DEFAULT_QUESTION_BANK_CONFIG);
  });

  it('坏 JSON → 默认未配置（不抛）', () => {
    expect(parseQuestionBankConfig('{坏掉')).toEqual(DEFAULT_QUESTION_BANK_CONFIG);
  });

  it('非法 provider 被丢弃（防手工改坏设置）', () => {
    const parsed = parseQuestionBankConfig('{"provider":"nonexistent"}');
    expect(parsed.provider).toBeNull();
  });

  it('凭据里的非字符串值被丢弃', () => {
    const parsed = parseQuestionBankConfig(
      '{"provider":"cn21","credentials":{"cn21":{"accessKey":"k","bad":123}}}',
    );
    expect(parsed.credentials.cn21).toEqual({ accessKey: 'k' });
  });

  it('正常往返', () => {
    const cfg = {
      provider: 'cn21' as const,
      credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
    };
    expect(parseQuestionBankConfig(JSON.stringify(cfg))).toEqual(cfg);
  });
});

describe('设置键安全性契约', () => {
  it('QUESTION_BANK_CONFIG_KEY 必须命中后端的加密存储判定', async () => {
    // 后端 save_setting → db.save_secret → SecureStore::is_sensitive_key
    // （secure_store.rs:559），按 key **前缀**匹配 SENSITIVE_KEY_PATTERNS
    // （secure_store.rs:135）。未命中则凭据**明文落库**。
    //
    // 本模块存题库平台凭据（accessKey），必须加密。此测试从后端源码
    // 提取 pattern 列表并复算匹配结果——后端改了名单这里会立刻红灯。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src-tauri/src/secure_store.rs'),
      'utf8',
    );

    // 抓 SENSITIVE_KEY_PATTERNS 数组里的字符串字面量
    const block = src.match(/SENSITIVE_KEY_PATTERNS[^=]*=\s*&\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(block, '未能从 secure_store.rs 解析出 SENSITIVE_KEY_PATTERNS').not.toBe('');
    const patterns = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(5);

    const key = QUESTION_BANK_CONFIG_KEY;
    const matched =
      key.endsWith('.api_key')
      || key.endsWith('.apiKey')
      || patterns.some((p) => key.startsWith(p));

    expect(
      matched,
      `设置键 "${key}" 未命中加密存储判定，题库凭据将明文落库。`
      + `需以 SENSITIVE_KEY_PATTERNS 中某项开头（当前：${patterns.join(', ')}）`,
    ).toBe(true);
  });
});

// ============================================================================
// B. 配置区 UI：状态按钮
// ============================================================================

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
  resetQuestionBankConfigCache,
  useQuestionBankConfig,
} from '@/features/practice/questionBank/useQuestionBankConfig';
import { QuestionBankApiSection } from '@/features/settings/components/QuestionBankApiSection';

describe('QuestionBankApiSection：去配置 / 已配置 状态机', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetQuestionBankConfigCache();
  });

  it('未配置时按钮显示「去配置」且可点', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<QuestionBankApiSection />);

    const btn = await screen.findByTestId('question-bank-status-button');
    await waitFor(() => expect(btn).toHaveAttribute('data-configured', 'false'));
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('去配置');
  });

  it('已配置时按钮显示「已配置」且**仍可点**（E9：原需求「配了就禁用」导致改不了）', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    );
    render(<QuestionBankApiSection />);

    const btn = await screen.findByTestId('question-bank-status-button');
    await waitFor(() => expect(btn).toHaveAttribute('data-configured', 'true'));
    // ⚠️ E9 契约变更：**不再** disabled。
    // 用户实测反馈「题库配置后没有修改按钮」——原 disabled 让配好的用户
    // 再也进不去面板改配置。只有「加载中」才不可点。
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('已配置');
  });

  it('已配置时仍能展开面板修改（E9 回归防护）', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    );
    render(<QuestionBankApiSection />);

    const btn = await screen.findByTestId('question-bank-status-button');
    await waitFor(() => expect(btn).toHaveAttribute('data-configured', 'true'));
    fireEvent.click(btn);

    // 能进面板 = 能改配置。这正是问题 ③ 的修复点。
    expect(screen.getByTestId('question-bank-config-panel')).toBeInTheDocument();
    expect(screen.getByTestId('question-bank-field-accessKey')).toBeInTheDocument();
  });

  it('已配置时提供「清除配置」按钮，且需二次确认（E9 用户要求）', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    );
    render(<QuestionBankApiSection />);

    const btn = await screen.findByTestId('question-bank-status-button');
    await waitFor(() => expect(btn).toHaveAttribute('data-configured', 'true'));
    fireEvent.click(btn);

    // 第一次点击只进入确认态，不清除（清的是加密存储的 accessKey，必须防误触）
    fireEvent.click(screen.getByTestId('question-bank-clear'));
    expect(screen.getByTestId('question-bank-clear-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('question-bank-clear-ok')).toBeInTheDocument();

    // 取消可退回
    fireEvent.click(screen.getByTestId('question-bank-clear-cancel'));
    expect(screen.queryByTestId('question-bank-clear-confirm')).not.toBeInTheDocument();
  });

  it('点「去配置」展开配置面板（三个预设来源齐全）', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<QuestionBankApiSection />);

    const btn = await screen.findByTestId('question-bank-status-button');
    fireEvent.click(btn);

    expect(screen.getByTestId('question-bank-config-panel')).toBeInTheDocument();
    for (const id of ['cn21', 'tizhuang', 'custom']) {
      expect(screen.getByTestId(`question-bank-provider-${id}`)).toBeInTheDocument();
    }
  });

  it('选中来源后渲染该来源的凭据字段', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<QuestionBankApiSection />);

    fireEvent.click(await screen.findByTestId('question-bank-status-button'));
    fireEvent.click(screen.getByTestId('question-bank-provider-cn21'));

    expect(screen.getByTestId('question-bank-field-accessKey')).toBeInTheDocument();
    expect(screen.getByTestId('question-bank-field-baseUrl')).toBeInTheDocument();
  });

  it('21世纪教育网有「填入沙箱地址」按钮（便于联调）', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<QuestionBankApiSection />);

    fireEvent.click(await screen.findByTestId('question-bank-status-button'));
    fireEvent.click(screen.getByTestId('question-bank-provider-cn21'));

    expect(screen.getByTestId('question-bank-fill-sandbox')).toBeInTheDocument();
    expect(screen.getByTestId('question-bank-docs-link')).toBeInTheDocument();
  });

  it('订阅期间 store 被推进时，不在 ensureLoaded 回程覆盖消费者手上的新值', async () => {
    // 复现场景：本组件订阅后、ensureLoaded 尚未返回时，store 已被推进
    // （例如另一处调用了 setProvider/setCredential，或后端的值已由别的
    //  组件实例 emit 进来）。此时若无条件 setConfig(currentConfig)，
    // 会把消费者手上的新值回退成旧值。
    //
    // 注：加载中状态按钮是禁用的（不可点），故这里不能走「用户先点开面板」
    // 的路径——那条路径在真实交互中来不及发生。改用「store 在订阅后被
    // 外部推进」来构造同一类过期快照。
    let resolveGet: (v: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_setting') {
        return new Promise((resolve) => {
          resolveGet = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useQuestionBankConfig());

    // 确保 hook 已完成首次渲染（此时 ensureLoaded 仍 pending，store 未 emit）
    await act(async () => {
      await Promise.resolve();
    });

    // 外部推进 store：模拟别的实例写入了配置
    act(() => {
      result.current.setProvider('cn21');
      result.current.setCredential('cn21', 'accessKey', '外部写入的key');
    });

    // 此刻 store 应已持有外部写入的值
    expect(result.current.config.credentials.cn21?.accessKey).toBe('外部写入的key');

    // 后端这时才返回一个【不同的、无凭据的】旧配置
    await act(async () => {
      resolveGet(JSON.stringify({ provider: null, credentials: {} }));
      await Promise.resolve();
    });

    // 消费者手上的新值不能被回退
    expect(result.current.config.provider).toBe('cn21');
    expect(result.current.config.credentials.cn21?.accessKey).toBe('外部写入的key');
  });

  it('保存把配置序列化写入 save_setting', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_setting') return null;
      return undefined;
    });
    render(<QuestionBankApiSection />);

    fireEvent.click(await screen.findByTestId('question-bank-status-button'));
    fireEvent.click(screen.getByTestId('question-bank-provider-cn21'));

    fireEvent.change(screen.getByTestId('question-bank-field-accessKey'), {
      target: { value: 'my-key' },
    });
    fireEvent.change(screen.getByTestId('question-bank-field-baseUrl'), {
      target: { value: 'https://dev.21cnjy.com/' },
    });
    fireEvent.click(screen.getByTestId('question-bank-save'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_setting', expect.objectContaining({
        key: 'api_configs.question_bank',
      }));
    });

    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'save_setting');
    const payload = JSON.parse(call![1].value);
    expect(payload.provider).toBe('cn21');
    expect(payload.credentials.cn21.accessKey).toBe('my-key');
  });
});

// ============================================================================
// C. 刷题页：未配置门禁
// ============================================================================

vi.mock('@/components/layout/MobileHeaderContext', () => ({
  useMobileHeader: () => undefined,
}));

import { PracticeHubPage } from '@/features/practice/pages/PracticeHubPage';

describe('PracticeHubPage：题库未配置时的门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetQuestionBankConfigCache();
  });

  it('未配置：两个刷题入口置灰不可点', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<PracticeHubPage />);

    await waitFor(() => {
      expect(screen.getByTestId('practice-hub-page')).toHaveAttribute('data-ready', 'false');
    });
    expect(screen.getByTestId('practice-hub-entry-review-variants')).toBeDisabled();
    expect(screen.getByTestId('practice-hub-entry-by-category')).toBeDisabled();
  });

  it('未配置：显示引导条与「去配置」', async () => {
    mockInvoke.mockResolvedValue(null);
    render(<PracticeHubPage />);

    expect(await screen.findByTestId('practice-hub-not-configured')).toBeInTheDocument();
    expect(screen.getByTestId('practice-hub-go-configure')).toBeInTheDocument();
  });

  it('已配置：入口可点，且不再显示引导条', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    );
    render(<PracticeHubPage />);

    await waitFor(() => {
      expect(screen.getByTestId('practice-hub-page')).toHaveAttribute('data-ready', 'true');
    });
    expect(screen.getByTestId('practice-hub-entry-review-variants')).not.toBeDisabled();
    expect(screen.queryByTestId('practice-hub-not-configured')).not.toBeInTheDocument();
  });

  it('已配置时点入口会回调 onStartPractice（带正确 mode）', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        provider: 'cn21',
        credentials: { cn21: { accessKey: 'k', baseUrl: 'https://x' } },
      }),
    );
    const onStartPractice = vi.fn();
    render(<PracticeHubPage onStartPractice={onStartPractice} />);

    await waitFor(() => {
      expect(screen.getByTestId('practice-hub-page')).toHaveAttribute('data-ready', 'true');
    });
    fireEvent.click(screen.getByTestId('practice-hub-entry-review-variants'));

    expect(onStartPractice).toHaveBeenCalledWith('review-variants');
  });

  it('未配置时点入口不回调（置灰即不动作）', async () => {
    mockInvoke.mockResolvedValue(null);
    const onStartPractice = vi.fn();
    render(<PracticeHubPage onStartPractice={onStartPractice} />);

    await waitFor(() => {
      expect(screen.getByTestId('practice-hub-page')).toHaveAttribute('data-ready', 'false');
    });
    fireEvent.click(screen.getByTestId('practice-hub-entry-review-variants'));

    expect(onStartPractice).not.toHaveBeenCalled();
  });
});
