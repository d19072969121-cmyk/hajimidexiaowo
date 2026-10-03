/**
 * 题库 API 配置 —— 类型、预设与读写（E3）
 *
 * ## 定位
 * 刷题功能的数据源配置。项目内有本地题库（`qbank_*` 命令族，SQLite + FTS5），
 * 本模块负责**外部题库 API** 的选择与凭据管理。
 *
 * ## 为什么默认是「未配置」而非某个预设
 * 用户拍板：**默认空，强制用户自己选**。
 * 理由：21世纪教育网（21cnjy）的 `access-key` 需要向平台申请
 * （见 https://dev.21cnjy.com/docs/guide/access-flow.html），
 * 陌生人装上本 App 是不带任何 key 的。若默认选中它，会出现
 * 「显示已配置但一刷题就报未授权」的尴尬。故默认 provider = null，
 * 由 UI 引导「去配置」。
 *
 * ## 存储
 * 走项目既有的 `save_setting` / `get_setting`（key-value 字符串）。
 * 凭据以 JSON 字符串整体存在一个 key 下——**没有独立的密钥库**，
 * 与项目现有做法（如 WebSearchAdvancedConfig 存 API key）一致。
 */

/** 题库来源标识 */
export type QuestionBankProviderId =
  /** 21世纪教育网开放平台（有正式文档与沙箱，见 dev.21cnjy.com/docs/api） */
  | 'cn21'
  /** 智学网。**无官方开放平台**，只能按自定义形态填地址与凭据 */
  | 'zhixue'
  /** 自定义。用户填任意兼容的题库 API */
  | 'custom';

export interface QuestionBankProviderMeta {
  id: QuestionBankProviderId;
  /** 展示名 */
  label: string;
  /** 一句话说明（配置卡片副标题） */
  description: string;
  /**
   * 该来源的凭据字段定义。UI 按此动态渲染表单，
   * 避免为每个来源写一套硬编码表单。
   */
  fields: QuestionBankField[];
  /** 官方文档地址（有则显示「查看文档」） */
  docsUrl?: string;
  /** 沙箱地址（有则可一键填入，便于联调） */
  sandboxUrl?: string;
}

export interface QuestionBankField {
  key: string;
  label: string;
  /** 是否为敏感值（密码型输入 + 掩码显示） */
  secret?: boolean;
  placeholder?: string;
  /** 说明/帮助文本 */
  hint?: string;
  required?: boolean;
}

/**
 * 预设题库来源。
 *
 * ⚠️ 21cnjy 的认证是 **access-key + salt + timestamp + sign** 四件套
 *    （见 https://dev.21cnjy.com/docs/guide/authentication.html）。
 *    salt 是「参与签名的随机字符串，建议每次请求唯一」——即每次请求现生成，
 *    **不是**配置项，故此处只让用户填 access-key 与 baseUrl。
 *    签名算法在真正接 API 时实现，本模块只管凭据存储。
 */
export const QUESTION_BANK_PROVIDERS: readonly QuestionBankProviderMeta[] = [
  {
    id: 'cn21',
    label: '21世纪教育网',
    description: 'K12 题库开放平台，支持知识点组卷与举一反三',
    docsUrl: 'https://dev.21cnjy.com/docs/api/',
    sandboxUrl: 'https://dev.21cnjy.com/sandbox/',
    fields: [
      {
        key: 'accessKey',
        label: 'Access Key',
        secret: true,
        required: true,
        placeholder: '向平台申请后获得',
        hint: '需在 21世纪教育网开放平台申请；未申请可先用沙箱地址联调',
      },
      {
        key: 'baseUrl',
        label: '接口地址',
        required: true,
        placeholder: 'https://dev.21cnjy.com/',
        hint: '正式环境用 https://dev.21cnjy.com/，联调用沙箱地址',
      },
    ],
  },
  {
    id: 'zhixue',
    label: '智学网',
    description: '无官方开放平台，需自备接口地址与凭据',
    fields: [
      {
        key: 'baseUrl',
        label: '接口地址',
        required: true,
        placeholder: 'https://...',
        hint: '智学网未提供官方开放 API，此处仅作自定义接入入口',
      },
      {
        key: 'accessKey',
        label: 'Token / Cookie',
        secret: true,
        placeholder: '按你的接口要求填写',
      },
    ],
  },
  {
    id: 'custom',
    label: '自定义',
    description: '填入任意兼容的题库接口',
    fields: [
      { key: 'baseUrl', label: '接口地址', required: true, placeholder: 'https://...' },
      { key: 'accessKey', label: '密钥 / Token', secret: true, placeholder: '可选' },
    ],
  },
];

/** 单个来源的已存凭据：field.key → 值 */
export type QuestionBankCredentials = Record<string, string>;

export interface QuestionBankConfig {
  /** 当前选中的来源；null = 未配置 */
  provider: QuestionBankProviderId | null;
  /** 各来源各自保存的凭据（切换来源不丢已填内容） */
  credentials: Partial<Record<QuestionBankProviderId, QuestionBankCredentials>>;
}

export const DEFAULT_QUESTION_BANK_CONFIG: QuestionBankConfig = {
  provider: null,
  credentials: {},
};

/**
 * 设置项 key（与项目既有 save_setting/get_setting 机制一致）。
 *
 * ⚠️ key 名的选择关乎**凭据是否加密存储**，不是随意的字符串。
 *
 * 后端 `save_setting`（cmd/web_search.rs:540）走 `db.save_secret`，由
 * `SecureStore::is_sensitive_key`（secure_store.rs:559）按 **key 名前缀**
 * 判定是否进加密存储。判定规则是 `key.starts_with(pattern)`，
 * 有效 pattern 见 secure_store.rs:135 的 SENSITIVE_KEY_PATTERNS。
 *
 * 本模块存的是题库平台凭据（accessKey 等），与 API key 同级敏感。
 * 故 key 必须以 `api_configs` 开头才能命中加密分支——
 * 若命名为 `question_bank.api_config` 则**不匹配任何 pattern，会明文落库**。
 *
 * 改动此值前务必重新核对 is_sensitive_key 的匹配结果。
 */
export const QUESTION_BANK_CONFIG_KEY = 'api_configs.question_bank';

/**
 * 字段值是否「有效」。
 *
 * 不只是判非空：`baseUrl` 这类字段若填 `'x'`、`'不是URL'` 也算「已配置」，
 * 会让 PracticeHubPage 的门禁对垃圾配置放行——用户点了之后才在请求阶段炸，
 * 而这恰恰是「未配置即置灰」要避免的体验。故对 URL 类字段做形态校验。
 *
 * 判定用宽松规则（只要有 `scheme://host` 形态即可），不追求完整 URL 语法：
 * 目标是拦住明显不是地址的输入，不是做严格校验器。
 */
export function isFieldValueValid(field: QuestionBankField, value: string | undefined): boolean {
  const v = (value ?? '').trim();
  if (v.length === 0) return false;

  // 字段名含 url / Url / URL 视为地址类
  if (/url/i.test(field.key)) {
    // 必须有 scheme:// 且 host 部分非空
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/]+/.test(v);
  }
  return true;
}

/**
 * 判断某来源是否已填齐必填字段。
 *
 * 纯函数，供 UI 显示「去配置 / 已配置」两态，以及判断能否启用刷题。
 */
export function isProviderConfigured(
  providerId: QuestionBankProviderId,
  credentials: QuestionBankCredentials | undefined,
): boolean {
  const meta = QUESTION_BANK_PROVIDERS.find((p) => p.id === providerId);
  if (!meta) return false;
  return meta.fields
    .filter((f) => f.required)
    .every((f) => isFieldValueValid(f, credentials?.[f.key]));
}

/**
 * 当前配置是否可用（选了一个来源，且该来源已填齐）。
 * 未配置时刷题页应引导去配置，而不是发请求失败。
 */
export function isQuestionBankReady(config: QuestionBankConfig): boolean {
  if (!config.provider) return false;
  return isProviderConfigured(config.provider, config.credentials[config.provider]);
}

/**
 * 反序列化设置项。对畸形 JSON 全防御——设置项可能被手工改坏或被旧版本写入，
 * 此时回落到默认（未配置），而不是让整个设置页崩掉。
 */
export function parseQuestionBankConfig(raw: unknown): QuestionBankConfig {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_QUESTION_BANK_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_QUESTION_BANK_CONFIG;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_QUESTION_BANK_CONFIG;

  const obj = parsed as { provider?: unknown; credentials?: unknown };
  const validIds = QUESTION_BANK_PROVIDERS.map((p) => p.id);

  const provider = typeof obj.provider === 'string' && validIds.includes(obj.provider as QuestionBankProviderId)
    ? (obj.provider as QuestionBankProviderId)
    : null;

  const credentials: QuestionBankConfig['credentials'] = {};
  if (obj.credentials && typeof obj.credentials === 'object') {
    for (const id of validIds) {
      const entry = (obj.credentials as Record<string, unknown>)[id];
      if (!entry || typeof entry !== 'object') continue;
      const clean: QuestionBankCredentials = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof v === 'string') clean[k] = v;
      }
      credentials[id] = clean;
    }
  }

  return { provider, credentials };
}
