/**
 * 「自动拉取模型」按钮（VendorDetailPanel 模型列表头部）
 *
 * 覆盖：按钮位置 / 一键全量添加 / 去重 / 免 Key 供应商不带 Authorization /
 * 失败与响应形状异常的可读提示 / loading 期间禁用。
 * fetch 全部 mock，不发起真实网络请求。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApisTab } from '../ApisTab';
import { INVALID_VENDOR_MODEL_RESPONSE } from '../vendorModelService';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';

const tauriFetchMock = vi.hoisted(() => vi.fn());
const globalFetchMock = vi.hoisted(() => vi.fn());
const notificationMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauriFetchMock }));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notificationMock,
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isXl: false }),
}));

vi.mock('react-i18next', () => ({
  // 与 i18next 同语义：命中 key 时按 options 插值；未命中才回落 defaultValue。
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
      if (options?.defaultValue !== undefined) {
        return String(options.defaultValue).replace(/\{\{(\w+)\}\}/gu, (_match, name: string) =>
          String(options[name] ?? ''));
      }
      return options?.count !== undefined ? `${key}:${String(options.count)}` : key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseVendor: VendorConfig = {
  id: 'custom-openai',
  name: 'Custom OpenAI',
  providerType: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-live',
};

const existingProfile = {
  id: 'profile-gpt-5',
  vendorId: baseVendor.id,
  label: 'GPT-5',
  model: 'gpt-5',
  enabled: true,
  status: 'enabled',
} as ModelProfile;

const existingApi = {
  id: existingProfile.id,
  name: existingProfile.label,
  model: existingProfile.model,
} as ApiConfig;

interface RenderOptions {
  vendor?: VendorConfig;
  onAddVendorModels?: (vendor: VendorConfig, models: Array<{ modelId: string; label: string }>) => Promise<void>;
  models?: Array<{ profile: ModelProfile; api: ApiConfig }>;
}

function renderPanel(options: RenderOptions = {}) {
  const vendor = options.vendor ?? baseVendor;
  const onAddVendorModels = options.onAddVendorModels ?? vi.fn(async () => undefined);
  const noop = vi.fn();

  render(
    <ApisTab
      vendors={[vendor]}
      sortedVendors={[vendor]}
      selectedVendor={vendor}
      selectedVendorId={vendor.id}
      setSelectedVendorId={noop}
      selectedVendorModels={options.models ?? [{ profile: existingProfile, api: existingApi }]}
      selectedVendorIsSiliconflow={false}
      profileCountByVendor={new Map([[vendor.id, 1]])}
      vendorBusy={false}
      vendorSaving={false}
      isEditingVendor={false}
      vendorFormData={{}}
      setVendorFormData={noop}
      testingApi={null}
      handleOpenVendorModal={noop}
      handleStartEditVendor={noop}
      handleCancelEditVendor={noop}
      handleSaveEditVendor={noop}
      handleDeleteVendor={noop}
      handleSaveVendorBaseUrl={noop}
      handleSaveVendorApiKey={noop}
      handleClearVendorApiKey={noop}
      handleOpenModelEditor={noop}
      inlineEditState={null}
      setInlineEditState={noop}
      handleSaveInlineEdit={vi.fn(async () => undefined)}
      isAddingNewModel={false}
      handleAddModelInline={noop}
      handleCancelAddModel={noop}
      convertProfileToApiConfig={() => existingApi}
      handleToggleModelProfile={noop}
      handleDeleteModelProfile={noop}
      handleToggleFavorite={noop}
      testApiConnection={vi.fn(async () => undefined)}
      handleSiliconFlowConfig={noop}
      handleBatchCreateConfigs={noop}
      handleBatchConfigsCreated={noop}
      onReorderVendors={noop}
      onAddVendorModels={onAddVendorModels}
    />
  );

  return { onAddVendorModels };
}

function clickAutoFetch() {
  fireEvent.click(screen.getByRole('button', { name: 'settings:vendor_panel.auto_fetch_models_button' }));
}

describe('自动拉取模型按钮', () => {
  beforeEach(() => {
    tauriFetchMock.mockReset();
    globalFetchMock.mockReset();
    notificationMock.mockReset();
    vi.stubGlobal('fetch', globalFetchMock);
  });

  it('渲染在【添加模型】按钮上方', () => {
    renderPanel();

    const autoFetch = screen.getByRole('button', { name: 'settings:vendor_panel.auto_fetch_models_button' });
    const addModel = screen.getByRole('button', { name: 'settings:vendor_panel.add_model_button' });

    // compareDocumentPosition 含 DOCUMENT_POSITION_FOLLOWING(4)：autoFetch 在 addModel 之前
    expect(autoFetch.compareDocumentPosition(addModel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('一次点击完成拉取 + 全量添加，并跳过已存在的模型', async () => {
    tauriFetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'gpt-5', context_length: 400000 },
          { id: 'gpt-5-mini', context_length: 400000 },
          { id: 'gpt-5-nano' },
        ],
      })
    );
    const { onAddVendorModels } = renderPanel();

    clickAutoFetch();

    await waitFor(() => expect(onAddVendorModels).toHaveBeenCalledTimes(1));
    expect(onAddVendorModels).toHaveBeenCalledWith(baseVendor, [
      { modelId: 'gpt-5-mini', label: 'gpt-5-mini', contextWindow: 400000, maxOutputTokens: undefined },
      { modelId: 'gpt-5-nano', label: 'gpt-5-nano', contextWindow: undefined, maxOutputTokens: undefined },
    ]);
    expect(notificationMock).toHaveBeenCalledWith(
      'success',
      '自动拉取模型：已添加 2 个模型'
    );
  });

  it('未配置 Base URL 时给出提示且不发请求', async () => {
    const { onAddVendorModels } = renderPanel({ vendor: { ...baseVendor, baseUrl: '   ' } });

    clickAutoFetch();

    await waitFor(() =>
      expect(notificationMock).toHaveBeenCalledWith('warning', 'settings:vendor_model_fetcher.need_base_url')
    );
    expect(tauriFetchMock).not.toHaveBeenCalled();
    expect(onAddVendorModels).not.toHaveBeenCalled();
  });

  it('需要 Key 但未配置时给出提示且不发请求', async () => {
    const { onAddVendorModels } = renderPanel({ vendor: { ...baseVendor, apiKey: '', apiKeys: [] } });

    clickAutoFetch();

    await waitFor(() =>
      expect(notificationMock).toHaveBeenCalledWith('warning', 'settings:vendor_model_fetcher.need_api_key')
    );
    expect(tauriFetchMock).not.toHaveBeenCalled();
    expect(onAddVendorModels).not.toHaveBeenCalled();
  });

  it.each([
    ['pollinations', 'https://text.pollinations.ai/openai'],
    ['llmtech', 'https://api.llmtech.eu/v1'],
    ['kilo', 'https://api.kilo.ai/api/gateway'],
  ])('免 Key 供应商 %s：authMode=none 可不带 Authorization 拉取并全量添加', async (providerType, baseUrl) => {
    tauriFetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'free-model-a' }, { id: 'free-model-b' }] }));
    const { onAddVendorModels } = renderPanel({
      vendor: {
        id: `builtin-${providerType}`,
        name: `${providerType} (free)`,
        providerType,
        baseUrl,
        authMode: 'none',
        apiKey: '',
      },
    });

    clickAutoFetch();

    await waitFor(() => expect(onAddVendorModels).toHaveBeenCalledTimes(1));
    const [requestUrl, requestInit] = tauriFetchMock.mock.calls[0];
    expect(requestUrl).toBe(`${baseUrl.replace(/\/+$/u, '')}/models`);
    expect(requestInit.method).toBe('GET');
    const headerNames = Object.keys((requestInit.headers ?? {}) as Record<string, string>)
      .map(name => name.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(onAddVendorModels.mock.calls[0][1]).toHaveLength(2);
  });

  it('响应形状异常时映射为可读文案', async () => {
    tauriFetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    const { onAddVendorModels } = renderPanel();

    clickAutoFetch();

    await waitFor(() =>
      expect(notificationMock).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('settings:vendor_model_fetcher.invalid_response')
      )
    );
    expect(notificationMock.mock.calls[0][0]).toBe('error');
    expect(INVALID_VENDOR_MODEL_RESPONSE).toBe('INVALID_VENDOR_MODEL_RESPONSE');
    expect(onAddVendorModels).not.toHaveBeenCalled();
  });

  it('HTTP 失败时回传可读原因，不静默失败', async () => {
    tauriFetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    renderPanel();

    clickAutoFetch();

    await waitFor(() =>
      expect(notificationMock).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('自动拉取模型失败：')
      )
    );
    expect(notificationMock.mock.calls[0][1]).toContain('401');
  });

  it('无可添加新模型时给出空结果提示，且不调用添加回调', async () => {
    tauriFetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-5' }] }));
    const { onAddVendorModels } = renderPanel();

    clickAutoFetch();

    await waitFor(() =>
      expect(notificationMock).toHaveBeenCalledWith('info', 'settings:vendor_panel.auto_fetch_models_empty')
    );
    expect(onAddVendorModels).not.toHaveBeenCalled();
  });

  it('拉取进行中禁用按钮并显示 loading 文案，结束后自动复位', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    tauriFetchMock.mockImplementation(() => new Promise<Response>(resolve => {
      resolveFetch = resolve;
    }));
    renderPanel();
    const autoFetch = screen.getByRole('button', { name: 'settings:vendor_panel.auto_fetch_models_button' });

    // 用原生 click() 让 React 走「legacy discrete event」路径：setState 在 dispatch
    // 内部同步 flush，事件返回后 DOM 已经是 loading 态。testing-library 的 fireEvent
    // 走 act 包裹的 modern 路径，状态提交会推迟，随后 findBy/getBy 都看不到 loading 文案。
    await act(async () => {
      autoFetch.click();
      await Promise.resolve();
    });

    const busy = screen.getByRole('button', { name: 'settings:vendor_panel.auto_fetch_models_fetching' });
    expect(busy).toBeDisabled();
    await waitFor(() => expect(tauriFetchMock).toHaveBeenCalledTimes(1));
    expect(resolveFetch).toBeTypeOf('function');

    resolveFetch?.(jsonResponse({ data: [{ id: 'gpt-5' }] }));

    // finally 复位 loading：按钮回到可点状态，不再停留在「正在拉取模型…」
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'settings:vendor_panel.auto_fetch_models_button' })
      ).not.toBeDisabled()
    );
    // 已存在的 gpt-5 被去重 → 空结果提示（证明整条链路走完且 finally 复位未被吞）
    expect(notificationMock).toHaveBeenCalledWith('info', 'settings:vendor_panel.auto_fetch_models_empty');
  });
});
