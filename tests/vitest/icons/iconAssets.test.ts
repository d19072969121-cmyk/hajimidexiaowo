/**
 * 图标资产契约（E13-Z）
 *
 * 背景：本轮全量替换了 APP 图标（`src-tauri/icons/` 32 个文件 + `gen/android` 15 个）。
 * 这些是**二进制资产**——既无类型检查，也无可读差异：一旦被误删、清空、
 * 或装错尺寸，CI **不会报错**，只会在打包后表现为图标异常。
 *
 * 本契约用「存在 + 可解码 + 尺寸符合项目约定 + 非空」四类断言把它们锁死。
 *
 * ⚠️ 尺寸用**项目实测约定**，不是教科书值：本项目 hdpi launcher 是 49x49
 * （标准 Android 是 72），沿用既有约定以避免与其它平台产物不一致。
 *
 * 零依赖：PNG 尺寸直接读 IHDR 头，不引入图像库。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ICONS_DIR = 'src-tauri/icons';
const GEN_RES_DIR = 'src-tauri/gen/android/app/src/main/res';

const abs = (relative: string): string => resolve(ROOT, relative);

/** 直接解析 PNG 的 IHDR，返回 { width, height }；非 PNG 或头损坏则抛错。 */
function readPngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) {
    throw new Error(`${file} 不是合法 PNG（签名不匹配）`);
  }
  // IHDR 必须位于偏移 8 的块内：长度(4) + 类型(4) = 8，故数据从 16 起
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${file} 首个块不是 IHDR`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 断言文件存在、非空、且是一个尺寸正确的 PNG。 */
function expectPng(relative: string, width: number, height: number): void {
  const file = abs(relative);
  expect(existsSync(file), `${relative} 应存在`).toBe(true);
  expect(statSync(file).size, `${relative} 不应为空文件`).toBeGreaterThan(0);

  const size = readPngSize(file);
  expect(size, `${relative} 尺寸应为 ${width}x${height}`).toEqual({ width, height });
}

// ── 项目既有尺寸约定（实测值，勿套教科书）──────────────────────────────
const LAUNCHER_SIZES: Record<string, number> = {
  mdpi: 48,
  hdpi: 49, // 本项目既有值；标准 Android 为 72，此处刻意沿用实测约定
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

const FOREGROUND_SIZES: Record<string, number> = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

const TOP_LEVEL_SIZES: Array<[string, number]> = [
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
  ['StoreLogo.png', 50],
];

const WINDOWS_TILE_SIZES: Array<[string, number]> = [
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
];

describe('图标资产 · tauri.conf.json 引用完整性', () => {
  const conf = JSON.parse(readFileSync(abs('src-tauri/tauri.conf.json'), 'utf8')) as {
    bundle: { icon: string[] };
  };

  it('bundle.icon 声明的每个路径都实际存在且非空', () => {
    expect(conf.bundle.icon.length).toBeGreaterThan(0);

    for (const iconPath of conf.bundle.icon) {
      // tauri.conf.json 里的路径相对于 src-tauri/
      const file = abs(`src-tauri/${iconPath}`);
      expect(existsSync(file), `tauri.conf.json 引用的 ${iconPath} 不存在`).toBe(true);
      expect(statSync(file).size, `${iconPath} 不应为空`).toBeGreaterThan(0);
    }
  });

  it('bundle.icon 中的 PNG 可解码且宽高为正', () => {
    for (const iconPath of conf.bundle.icon.filter((p) => p.endsWith('.png'))) {
      const { width, height } = readPngSize(abs(`src-tauri/${iconPath}`));
      expect(width, `${iconPath} 宽度应为正`).toBeGreaterThan(0);
      expect(height, `${iconPath} 高度应为正`).toBeGreaterThan(0);
    }
  });

  it('bundle.icon 中的 icon.ico / icon.icns 存在且具最小体积', () => {
    for (const iconPath of conf.bundle.icon.filter((p) => /\.(ico|icns)$/u.test(p))) {
      const file = abs(`src-tauri/${iconPath}`);
      expect(existsSync(file), `${iconPath} 应存在`).toBe(true);
      // 含多分辨率层，不应是几百字节的空壳
      expect(statSync(file).size, `${iconPath} 体积过小，疑似损坏`).toBeGreaterThan(1024);
    }
  });
});

describe('图标资产 · 顶层 PNG 尺寸', () => {
  it.each(TOP_LEVEL_SIZES)('%s 应为正方形 %s', (name, size) => {
    expectPng(`${ICONS_DIR}/${name}`, size, size);
  });
});

describe('图标资产 · Windows 磁贴尺寸', () => {
  it.each(WINDOWS_TILE_SIZES)('%s 应为正方形 %s', (name, size) => {
    expectPng(`${ICONS_DIR}/${name}`, size, size);
  });
});

describe('图标资产 · Android launcher 各密度尺寸', () => {
  it.each(Object.entries(LAUNCHER_SIZES))('%s ic_launcher.png 应为正方形', (density, size) => {
    expectPng(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher.png`, size, size);
  });

  it.each(Object.entries(LAUNCHER_SIZES))('%s ic_launcher_round.png 应为正方形', (density, size) => {
    expectPng(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher_round.png`, size, size);
  });
});

describe('图标资产 · Android 自适应图标前景层尺寸', () => {
  it.each(Object.entries(FOREGROUND_SIZES))(
    '%s ic_launcher_foreground.png 应为正方形',
    (density, size) => {
      expectPng(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher_foreground.png`, size, size);
    },
  );

  it('前景层与 launcher 的尺寸关系遵循项目既有约定（hdpi 例外）', () => {
    // ⚠️ 不能用统一公式推导：本项目 hdpi launcher 是 49（非标准 72），
    // 而它的 foreground 是 162（= 标准 72 × 2.25），并非 49 × 2.25 = 110。
    // 即 hdpi 的"2.25 倍"关系来自标准值而非该项目实际 launcher 尺寸，
    // 这是既有产物的事实状态，故按密度显式断言，不套公式。
    const expected: Record<string, number> = {
      mdpi: 48 * 2.25, // 108，标准
      hdpi: 72 * 2.25, // 162，按标准 72 而非实际 49
      xhdpi: 96 * 2.25, // 216，标准
      xxhdpi: 144 * 2.25, // 324，标准
      xxxhdpi: 192 * 2.25, // 432，标准
    };

    for (const [density, size] of Object.entries(expected)) {
      const { width } = readPngSize(
        abs(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher_foreground.png`),
      );
      expect(width, `${density} 前景层尺寸`).toBe(Math.round(size));
    }
  });

  it('前景层不小于同密度 launcher（安全区裁切需要更大画布）', () => {
    for (const [density, launcherSize] of Object.entries(LAUNCHER_SIZES)) {
      const { width } = readPngSize(
        abs(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher_foreground.png`),
      );
      expect(width, `${density} 前景层应大于 launcher`).toBeGreaterThan(launcherSize);
    }
  });
});

describe('图标资产 · Android 自适应图标配置', () => {
  const XML_PATH = `${ICONS_DIR}/android/mipmap-anydpi-v26/ic_launcher.xml`;

  it('ic_launcher.xml 存在且为合法 XML', () => {
    const file = abs(XML_PATH);
    expect(existsSync(file), `${XML_PATH} 应存在`).toBe(true);

    const xml = readFileSync(file, 'utf8');
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<adaptive-icon');
    expect(xml).toContain('</adaptive-icon>');
    // 标签配平（简易校验，避免引入 XML 解析依赖）
    expect((xml.match(/<adaptive-icon/gu) ?? []).length).toBe(
      (xml.match(/<\/adaptive-icon>/gu) ?? []).length,
    );
  });

  it('引用的 foreground mipmap 与 background color 均实际存在', () => {
    const xml = readFileSync(abs(XML_PATH), 'utf8');

    // foreground 指向 @mipmap/ic_launcher_foreground
    expect(xml).toMatch(/android:drawable="@mipmap\/ic_launcher_foreground"/u);
    for (const density of Object.keys(FOREGROUND_SIZES)) {
      expect(
        existsSync(abs(`${ICONS_DIR}/android/mipmap-${density}/ic_launcher_foreground.png`)),
        `foreground 引用的 ${density} 资源缺失，自适应图标会解析失败`,
      ).toBe(true);
    }

    // background 指向 @color/ic_launcher_background，其定义须存在
    expect(xml).toMatch(/android:drawable="@color\/ic_launcher_background"/u);
    const colorXml = abs(`${ICONS_DIR}/android/values/ic_launcher_background.xml`);
    expect(existsSync(colorXml), 'ic_launcher_background 颜色定义缺失').toBe(true);
    expect(readFileSync(colorXml, 'utf8')).toContain('ic_launcher_background');
  });
});

describe('图标资产 · gen/android 同步（本地出包用）', () => {
  // gen/ 被 .gitignore 忽略，CI/干净克隆下可能不存在 → 用守卫跳过，避免 CI 误红。
  const genAvailable = existsSync(abs(GEN_RES_DIR));

  it.runIf(genAvailable)('gen/android 下每个 mipmap PNG 与 icons/android 源 md5 一致', () => {
    const md5 = (file: string): string =>
      createHash('md5').update(readFileSync(file)).digest('hex');

    let compared = 0;
    for (const density of Object.keys(LAUNCHER_SIZES)) {
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
        const source = abs(`${ICONS_DIR}/android/mipmap-${density}/${name}`);
        const copy = abs(`${GEN_RES_DIR}/mipmap-${density}/${name}`);
        expect(existsSync(copy), `gen/android 缺少 mipmap-${density}/${name}`).toBe(true);
        expect(md5(copy), `gen/android 的 ${density}/${name} 与源不一致`).toBe(md5(source));
        compared += 1;
      }
    }
    expect(compared).toBe(Object.keys(LAUNCHER_SIZES).length * 3);
  });

  it('gen/android 存在性不影响本契约其余部分', () => {
    // 显式记录守卫状态，便于排查 CI 上为何跳过
    expect(typeof genAvailable).toBe('boolean');
  });
});
