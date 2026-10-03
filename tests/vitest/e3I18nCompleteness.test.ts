/**
 * E3 交叉审查修复 — i18n 完整性契约
 *
 * ## 为什么需要这份测试
 * 交叉审查（reviewer-adversarial）发现：practiceHub.*（6 个）、reviewHub.*（8 个）、
 * settings:questionBank.*（10 个）**全部缺失**，用户在界面上直接看到裸 key。
 *
 * 更隐蔽的是：这 24 个缺失**逃过了当时全部 28 条 UI 断言**——因为组件里写的是
 * `t('settings:questionBank.goConfigure', '去配置')`，而测试断言 `toHaveTextContent('去配置')`，
 * i18n 缺词时 fallback 恰好顶上，断言照样通过。
 *
 * 所以本文件不复用任何 UI 渲染，而是**直接核对语言文件**：
 * 每个组件里用到的 key 必须在 zh-CN 与 en-US 两个语言文件中真实存在。
 *
 * 形态参照 appSidebarUpdateBadgeSource.test.ts 等源码级契约。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

function readSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

/** 取嵌套路径，如 'questionBank.title' */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

/** 从源码里抽出某命名空间下的全部 t() 键 */
function extractKeys(source: string, ns: string, prefix: string): string[] {
  // 两种写法都要覆盖：
  //   1) 带命名空间：t('settings:questionBank.title', ...)
  //   2) 裸写（落在默认 namespace = common）：t('practiceHub.title', ...)
  const withNs = ns !== prefix
    ? new RegExp(`${ns}:${prefix}\\.[a-zA-Z0-9_.]+`, 'g')
    : null;
  const bare = new RegExp(`'${prefix}\\.[a-zA-Z0-9_.]+'`, 'g');

  const found = new Set<string>();
  if (withNs) {
    for (const m of source.matchAll(withNs)) {
      found.add(m[0].slice(ns.length + 1));
    }
  }
  for (const m of source.matchAll(bare)) {
    found.add(m[0].slice(1, -1));
  }
  return [...found].sort();
}

// ============================================================================
// 组件 → 语言文件 的对应关系
// ============================================================================

const CASES: Array<{
  label: string;
  source: string;
  ns: string;
  prefix: string;
  localeFiles: Record<string, string>;
}> = [
  {
    label: 'QuestionBankApiSection → settings:questionBank.*',
    source: 'src/features/settings/components/QuestionBankApiSection.tsx',
    ns: 'settings',
    prefix: 'questionBank',
    localeFiles: {
      'zh-CN': 'src/locales/zh-CN/settings.json',
      'en-US': 'src/locales/en-US/settings.json',
    },
  },
  {
    label: 'PracticeHubPage → practiceHub.*',
    source: 'src/features/practice/pages/PracticeHubPage.tsx',
    ns: 'practiceHub',
    prefix: 'practiceHub',
    localeFiles: {
      'zh-CN': 'src/locales/zh-CN/common.json',
      'en-US': 'src/locales/en-US/common.json',
    },
  },
  {
    label: 'ReviewHubPage → reviewHub.*',
    source: 'src/features/review/pages/ReviewHubPage.tsx',
    ns: 'reviewHub',
    prefix: 'reviewHub',
    localeFiles: {
      'zh-CN': 'src/locales/zh-CN/common.json',
      'en-US': 'src/locales/en-US/common.json',
    },
  },
  {
    // E4：拍题页。交叉审查发现本闸门当初只登记了 E3 的三个文件，
    // 漏了 E4 新增的 capture.*（11 个键）—— 等于新开的洞没被这道闸门盖上。
    // 而 e4CapturePage.test.tsx 按 E3 教训所述方式（比对 fallback 字面量）
    // 恰好测不出缺 key，只有本闸门能测。
    label: 'CapturePage → capture.*',
    source: 'src/features/capture/pages/CapturePage.tsx',
    ns: 'capture',
    prefix: 'capture',
    localeFiles: {
      'zh-CN': 'src/locales/zh-CN/common.json',
      'en-US': 'src/locales/en-US/common.json',
    },
  },
];

describe('E3 i18n 完整性契约：组件里用到的 key 必须在语言文件中存在', () => {
  for (const c of CASES) {
    const source = readSource(c.source);
    const keys = extractKeys(source, c.ns, c.prefix);

    it(`${c.label}：抽出 ${keys.length} 个 key（防空断言）`, () => {
      expect(keys.length).toBeGreaterThan(0);
    });

    for (const [locale, file] of Object.entries(c.localeFiles)) {
      it(`${c.label}：${locale} 全部存在`, () => {
        const dict = readJson(file);
        const missing = keys.filter((k) => {
          const v = getPath(dict, k);
          return typeof v !== 'string' || v.trim() === '';
        });
        expect(
          missing,
          `${file} 缺少 ${missing.length} 个键：${missing.join(', ')}。`
          + `这些键在界面上会回落成源码 fallback（或裸 key），且 UI 断言测不出来——`
          + `因为断言比的正是 fallback 字面量。`,
        ).toEqual([]);
      });
    }
  }
});

describe('E3 i18n 契约：questionBank.title 不得被 exam_sheet 撞键污染', () => {
  it('settings.json 自带 questionBank.title（同命名空间优先于跨 NS 回退）', () => {
    // 背景：i18n.ts:86 配了 fallbackNS，若 settings.json 没有该键，
    // 会静默命中 exam_sheet.json 的 questionBank.title（"智能题目集"），
    // 不报缺失但语义完全错误。此断言锁死「settings 自己必须有」。
    for (const file of ['src/locales/zh-CN/settings.json', 'src/locales/en-US/settings.json']) {
      const dict = readJson(file);
      expect(getPath(dict, 'questionBank.title'), `${file} 缺 questionBank.title`).toBeTruthy();
    }
  });
});
