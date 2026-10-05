import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => {
  const absolutePath = resolve(process.cwd(), file);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

describe('DeepStudent about logo token contract', () => {
  const aboutTabSource = readSource('src/features/settings/components/AboutTab.tsx');
  const logoSource = readSource('src/components/ui/DeepStudentLogo.tsx');

  it('uses the DeepStudent SVG wordmark in the About tab instead of the generic image asset', () => {
    expect(aboutTabSource).toContain("import { DeepStudentLogo } from '@/components/ui/DeepStudentLogo';");
    expect(aboutTabSource).toContain('<DeepStudentLogo');
    expect(aboutTabSource).toContain('w-44');
    expect(aboutTabSource).toContain('max-w-full');
    expect(aboutTabSource).not.toContain('src="/logo.svg"');
  });

  it('maps the DeepStudent fill tokens onto semantic tokens so dark mode follows the theme', () => {
    expect(logoSource).toContain('role="img"');
    expect(logoSource).toContain('fill-background');
    expect(logoSource).toContain('fill-foreground');
    expect(logoSource).not.toMatch(/fill="(?:#101820|white)"/u);
  });

  it('sizes the logo viewBox to the bitmap aspect ratio so the art fills the frame', () => {
    // 位图 832x464 = 1.7931；viewBox 若沿用旧 wordmark 的 409x147 (2.7823)，
    // preserveAspectRatio="xMidYMid meet" 会把图形收缩到框宽的 64.4% 并左右留白。
    // 契约：viewBox 宽高比必须与 <image> 一致（满框绘制，无留白）。
    //
    // 注意：本文件同时导出方形标 DeepStudentMark（viewBox 0 0 147 147），
    // 故必须把提取范围限定在 DeepStudentLogo 组件体内，否则会误取 Mark 的 viewBox。
    const logoComponent = logoSource.slice(logoSource.indexOf('export const DeepStudentLogo:'));
    expect(logoComponent.length).toBeGreaterThan(0);

    const viewBox = logoComponent.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/u);
    expect(viewBox).not.toBeNull();

    const [, boxWidth, boxHeight] = viewBox as RegExpMatchArray;
    const boxRatio = Number(boxWidth) / Number(boxHeight);

    const imageWidth = logoComponent.match(/href="\/ai-study-logo-832\.png"[\s\S]*?width="([\d.]+)"/u);
    const imageHeight = logoComponent.match(/href="\/ai-study-logo-832\.png"[\s\S]*?height="([\d.]+)"/u);
    expect(imageWidth).not.toBeNull();
    expect(imageHeight).not.toBeNull();

    const imageRatio = Number(imageWidth![1]) / Number(imageHeight![1]);
    expect(boxRatio).toBeCloseTo(imageRatio, 3);
    // 与 public/ai-study-logo-832.png 实际尺寸 832x464 吻合
    expect(boxRatio).toBeCloseTo(832 / 464, 3);
  });
});
