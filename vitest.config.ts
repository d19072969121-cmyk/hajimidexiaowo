import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'tests/vitest/ui-shell/**/*.{test,spec}.{ts,tsx}',
      'tests/vitest/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.{test,spec}.{ts,tsx}',
    ],
    css: false, // 禁用CSS处理避免选择器问题
    silent: true, // 降低日志噪音与内存占用，避免大规模 console 输出导致 runner 不稳定
    // 🔧 稳定性：Node 22 + threads(tinypool) 偶发 "Channel closed" 崩溃 → 用 forks 池规避。
    // ⚠️ 不要再开 singleFork：单进程串行会让 jsdom 内存跨文件累积，
    // 大批量文件跑到中途触发 V8 GC 抖动近似死锁（本地与 CI 分片 4 均复现过）。
    // 多进程并行 + 堆上限兜底，内存有界且显著更快。
    // CI 分片曾把单个 worker 顶死在 4096MB（日志约 4001MB 后 OOM），
    // 不是断言失败。CI 提高单进程堆、同时把 forks 上限收成 2，避免
    // 4 worker × 6GB 撑爆 runner；不放宽任何用例。
    // E13P 实测（2026-10-05）：非 CI 默认 = max(numCpus-1)=7 fork，
    // 在 11GB 内存机上触到崩溃边界（swap 暴涨 +792MB、MemAvailable 压到
    // 2.8GB，与 node::TearDownOncePerProcess Aborted 同水位），且吞吐反而
    // 衰减（7 fork=5.3x vs 2 fork=1.9x 近线性）。故非 CI 也固定 maxForks=2，
    // 本机可用 VITEST_MAX_FORKS 覆盖。瓶颈主因是每文件 jsdom 环境初始化
    // （~84% 耗时），详见 analysis/E13P_测试性能诊断.md。
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: [
          process.env.CI ? '--max-old-space-size=6144' : '--max-old-space-size=4096',
        ],
        maxForks: process.env.VITEST_MAX_FORKS
          ? parseInt(process.env.VITEST_MAX_FORKS, 10)
          : 2,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'heic2any': path.resolve(__dirname, 'tests/vitest/mocks/heic2any.mock.ts'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'tests/ct/mocks/tauri-core-mock.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'tests/ct/mocks/tauri-event-mock.ts'),
      '@tauri-apps/api/window': path.resolve(__dirname, 'tests/ct/mocks/tauri-window-mock.ts'),
      '@tauri-apps/api/webviewWindow': path.resolve(__dirname, 'tests/ct/mocks/tauri-webviewWindow-mock.ts'),
      '@tauri-apps/api/webview': path.resolve(__dirname, 'tests/ct/mocks/tauri-webview-mock.ts'),
      '/src/contexts/SubjectContext.tsx': path.resolve(__dirname, 'tests/ct/mocks/SubjectContext.mock.tsx'),
      'react-i18next': path.resolve(__dirname, 'tests/ct/mocks/react-i18next.tsx'),
      '/src/utils/tauriApi.ts': path.resolve(__dirname, 'tests/ct/mocks/tauriApi.mock.ts'),
    },
  },
});
