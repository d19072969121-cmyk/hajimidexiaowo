/**
 * 「关于页」技术合作伙伴致谢卡片 + 开发信息行的渲染契约。
 *
 * 覆盖（对应本轮 UI 改动）：
 * - 三张致谢卡片全部渲染（siliconflow / dsha / deepstudent）
 * - **渲染顺序**：SiliconFlow → DSHA → Deep Student
 *   （用户明确要求 DSHA 在硅基流动**下面**）
 * - title / description / alt 取自 i18n，而非组件内硬编码
 * - 开发信息行：新增 basedOn 行，且指向上游仓库
 * - platforms 值为 "Android"（不再出现 Windows / macOS / iPadOS）
 *
 * i18n mock 策略：**从真实 locale JSON 查表**返回文案，
 * 而不是返回 key 字符串 —— 只有这样才能证明「文案来自 i18n」。
 * 若返回 key，断言 key 只能证明调用了 t()，证明不了文案来源。
 *
 * 不渲染真实更新逻辑：useAppUpdater 及 updater 相关 tauri 依赖全部 mock。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ── 真实 locale 词条（用于 mock t 的查表）─────────────────────────────
// vi.mock 的工厂会被提升到文件顶部，故其依赖的共享状态必须经 vi.hoisted 建立。
// 但 hoisted 工厂执行时 ESM import（node:fs）尚未初始化，因此这里**只建容器**，
// 真实文件读取推迟到首次查表时惰性执行。
const { localeState, overrides } = vi.hoisted(() => ({
  localeState: { loaded: false, data: {} as Record<string, unknown> },
  overrides: new Map<string, string>(),
}));

function loadLocaleOnce(): Record<string, unknown> {
  if (!localeState.loaded) {
    localeState.data = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    localeState.loaded = true;
  }
  return localeState.data;
}

function lookup(path: string): unknown {
  if (overrides.has(path)) return overrides.get(path);
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      loadLocaleOnce(),
    );
}

/** 与 i18next 同语义：命中 key 返回词条；未命中才回落 defaultValue。 */
const t = (key: string, defaultValueOrOptions?: unknown): string => {
  const hit = lookup(key);
  if (typeof hit === 'string') return hit;

  if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions;
  if (
    defaultValueOrOptions &&
    typeof defaultValueOrOptions === 'object' &&
    'defaultValue' in (defaultValueOrOptions as Record<string, unknown>)
  ) {
    return String((defaultValueOrOptions as { defaultValue: unknown }).defaultValue);
  }
  return key;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

// ── 重型依赖 mock（与本测试关注点无关）────────────────────────────────
vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({
    status: 'idle',
    version: null,
    progress: 0,
    readyToRelaunch: false,
    error: null,
    checkForUpdates: vi.fn(),
    downloadAndInstall: vi.fn(),
    relaunchApp: vi.fn(),
  }),
  getUpdateChannel: () => 'stable',
  setUpdateChannel: vi.fn(),
  getUpdateFrequency: () => 'every_launch',
  setUpdateFrequency: vi.fn(),
  getUpdateFrequencyDays: () => 7,
  setUpdateFrequencyDays: vi.fn(),
  getNoRemind: () => false,
  setNoRemind: vi.fn(),
}));

vi.mock('@/version', () => ({
  default: { FULL_VERSION: 'v0.0.0-test', GIT_HASH: 'testhash', BUILD_DATE: '2026-01-01' },
}));

vi.mock('@/components/legal/PrivacyPolicyDialog', () => ({
  PrivacyPolicyDialog: () => null,
}));

vi.mock('../OpenSourceAcknowledgementsSection', () => ({
  OpenSourceAcknowledgementsSection: () => null,
}));

import { AboutTab } from '../AboutTab';

// ── 断言辅助 ────────────────────────────────────────────────────────
const CARD_KEYS = ['siliconflow', 'dsha', 'deepstudent'] as const;

/** 取三张卡片的标题元素（按 DOM 顺序）。 */
function cardTitles(): HTMLElement[] {
  return CARD_KEYS.map((key) => {
    const title = lookup(`acknowledgements.partners.cards.${key}.title`);
    return screen.getByText(String(title), { selector: 'h4' });
  });
}

function precedes(first: HTMLElement, second: HTMLElement): boolean {
  // DOCUMENT_POSITION_FOLLOWING(4)：second 在 first 之后
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('关于页 · 技术合作伙伴致谢卡片', () => {
  it('三张卡片全部渲染（siliconflow / dsha / deepstudent）', () => {
    render(<AboutTab />);

    for (const key of CARD_KEYS) {
      const title = lookup(`acknowledgements.partners.cards.${key}.title`);
      expect(typeof title).toBe('string');
      expect(screen.getByText(String(title), { selector: 'h4' })).toBeInTheDocument();
    }
  });

  it('渲染顺序为 SiliconFlow → DSHA → Deep Student', () => {
    render(<AboutTab />);

    const [siliconflow, dsha, deepstudent] = cardTitles();

    // 用户明确要求：DSHA 在硅基流动**下面**
    expect(precedes(siliconflow, dsha)).toBe(true);
    expect(precedes(dsha, deepstudent)).toBe(true);
    // 传递性再确认一次首尾
    expect(precedes(siliconflow, deepstudent)).toBe(true);
  });

  it('每张卡片的 title / description 均取自 i18n 词条', () => {
    render(<AboutTab />);

    for (const key of CARD_KEYS) {
      const title = String(lookup(`acknowledgements.partners.cards.${key}.title`));
      const description = String(lookup(`acknowledgements.partners.cards.${key}.description`));

      expect(screen.getByText(title, { selector: 'h4' })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    }
  });

  it('三张卡片的描述文案互不相同（防止复制粘贴串词）', () => {
    render(<AboutTab />);

    const descriptions = CARD_KEYS.map((key) =>
      String(lookup(`acknowledgements.partners.cards.${key}.description`)),
    );

    expect(new Set(descriptions).size).toBe(CARD_KEYS.length);
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it('无图标的卡片渲染 i18n alt 作为无障碍标签', () => {
    render(<AboutTab />);

    // dsha / deepstudent 走 markText 分支，aria-label 取自 i18n alt
    for (const key of ['dsha', 'deepstudent'] as const) {
      const alt = String(lookup(`acknowledgements.partners.cards.${key}.alt`));
      expect(screen.getByLabelText(alt)).toBeInTheDocument();
    }
  });

  it('文案确实走 i18n：替换词条后渲染结果随之改变（哨兵断言）', () => {
    // 把 DSHA 的 title / description 换成唯一哨兵串。
    // 若组件内硬编码了 "DSHA"，渲染结果不会变，下面的断言就会失败。
    const sentinelTitle = '__SENTINEL_DSHA_TITLE__';
    const sentinelDescription = '__SENTINEL_DSHA_DESCRIPTION__';
    overrides.set('acknowledgements.partners.cards.dsha.title', sentinelTitle);
    overrides.set('acknowledgements.partners.cards.dsha.description', sentinelDescription);

    try {
      render(<AboutTab />);

      // 渲染出的是哨兵，而非组件里可能硬编码的字面量
      expect(screen.getByText(sentinelTitle, { selector: 'h4' })).toBeInTheDocument();
      expect(screen.getByText(sentinelDescription)).toBeInTheDocument();
      // 原词条值不应再出现
      expect(screen.queryByText('DSHA', { selector: 'h4' })).toBeNull();
    } finally {
      overrides.clear();
    }
  });
});

describe('关于页 · 开发信息行', () => {
  it('渲染 basedOn 行，文案取自 i18n 且指向上游仓库', () => {
    render(<AboutTab />);

    const fieldLabel = String(lookup('acknowledgements.developer.fields.basedOn'));
    const fieldValue = String(lookup('acknowledgements.developer.values.basedOn'));

    expect(screen.getByText(fieldLabel)).toBeInTheDocument();

    const link = screen.getByText(fieldValue).closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://github.com/helixnow/deep-student');
    // 外链安全属性
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('platforms 显示 "Android"，且不再出现 Windows / macOS / iPadOS', () => {
    render(<AboutTab />);

    const platforms = String(lookup('acknowledgements.developer.values.platforms'));
    expect(platforms).toBe('Android');
    expect(screen.getByText('Android')).toBeInTheDocument();

    // 旧的多平台串必须已从渲染结果中消失
    expect(screen.queryByText(/Windows\s*\/\s*macOS/u)).toBeNull();
    expect(screen.queryByText(/iPadOS/u)).toBeNull();
    expect(screen.queryByText(/macOS/u)).toBeNull();
    expect(screen.queryByText(/Windows/u)).toBeNull();
  });
});
