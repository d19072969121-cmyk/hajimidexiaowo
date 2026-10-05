import { describe, it, expect } from 'vitest';
import { inferProviderTypeFromBaseUrl } from '@/features/settings/components/modelConverters';

describe('新增免 Key 源的 base_url 自动识别', () => {
  it.each([
    ['https://api.llmtech.eu/v1', 'llmtech'],
    ['https://api.kilo.ai/api/gateway', 'kilo'],
    ['https://text.pollinations.ai/openai', 'pollinations'],
  ])('%s -> %s', (url, expected) => {
    expect(inferProviderTypeFromBaseUrl(url)).toBe(expected);
  });

  it('不误伤已有供应商', () => {
    expect(inferProviderTypeFromBaseUrl('https://api.siliconflow.cn/v1')).toBe('siliconflow');
    expect(inferProviderTypeFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
  });
});
