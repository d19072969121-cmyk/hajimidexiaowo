//! 题庄题库（tizhuang）外部题库 HTTP 客户端命令
//!
//! ## 定位
//! 项目内的本地题库走 `question_bank_service`（SQLite + FTS5，命令族 `qbank_*`）。
//! 本模块负责**外部题库 API**（前端 `src/features/practice/questionBank/config.ts`
//! 的 `tizhuang` 来源），供刷题/找同类题调用。
//!
//! ## 认证模型（全部为实测结论，非文档推断）
//! 题庄有**两套并行的路由前缀**，选哪套取决于是否配置了 License：
//!
//! | 场景 | 搜题 | 配额 | 请求头 |
//! |---|---|---|---|
//! | 有 License | `GET /v1/questions` | `GET /v1/quota` | `X-API-Key: <license>` |
//! | 匿名试用 | `GET /v1/trial/questions` | `GET /v1/trial/quota` | `X-Trial-Token: <try_xxx>` |
//!
//! **trial token 只对 `/v1/trial/*` 路由有效**：拿 `X-Trial-Token` 打 `/v1/questions`
//! 会返回 `{"detail":"缺少 API Key，请使用 X-API-Key 请求头。"}`。
//!
//! 元数据接口（`/v1/meta/*`）**不含 trial/非 trial 之分，且免费不消费额度**，
//! 匿名试用下可直接访问。
//!
//! ## 凭据绝不入 query
//! License / trial token 只走请求头。query 只承载业务筛选参数——
//! query 会被写进各级访问日志、Referer、代理缓存，凭据放进去等于泄漏。
//!
//! ## 不落日志
//! 本模块任何 `log::*` / 错误信息都**不得包含** License 或 trial token 明文。
//! 需要标识一次请求时用其长度与非可逆摘要前缀。

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::models::{AppError, AppErrorType};

type Result<T> = std::result::Result<T, AppError>;

// =============================================================================
// 常量
// =============================================================================

/// 前端题庄来源默认接口地址（`config.ts` 中 `defaultValue` 的同值）。
///
/// 前端已把该值预填进 `credentials.tizhuang.baseUrl`；此处仅在前端配置缺失
/// （未配置 provider、旧版本数据、手工改坏）时兜底，避免直接失败。
const DEFAULT_BASE_URL: &str = "https://tizhuang.qcscience.cc/api";

/// 题库配置在 settings 表中的 key。
///
/// 必须与前端 `QUESTION_BANK_CONFIG_KEY`（`config.ts`）**逐字符一致**：
/// 该 key 以 `api_configs` 开头，命中 `SecureStore::is_sensitive_key`
/// （`secure_store.rs:135` 起 `SENSITIVE_KEY_PATTERNS` 含 `"api_configs"`），
/// 走 `get_secret` / `save_secret` 加密分支。
const CONFIG_SETTING_KEY: &str = "api_configs.question_bank";

/// 匿名试用 token 的缓存 key。
///
/// 同样以 `api_configs` 开头 → 加密存储。含 `token` 后缀亦命中通用敏感模式，
/// 双重保险。**不得改成非敏感前缀**，否则 trial token 明文落库。
const TRIAL_TOKEN_SETTING_KEY: &str = "api_configs.question_bank.trial";

/// 匿名试用的稳定客户端标识 key。
///
/// 文档明确：**身份必须持久化且禁止轮换**——轮换身份等于绕过匿名限额。
/// 该值本身不是密钥，但一并与 token 放在加密桶里，避免跨设备同步时泄漏关联性。
const ANON_CLIENT_ID_SETTING_KEY: &str = "api_configs.question_bank.anon_client_id";

/// `/v1/questions` 的 `limit` 上限（服务端契约硬限制）。
const MAX_QUESTION_LIMIT: u32 = 100;

/// 「找同类题」场景的默认 limit。
///
/// 搜题**按返回的父题数精确计费**（实测 `limit=3` 使 `used` 0→3）。
/// 默认给 100 会在用户一次点击里吃掉整份试用额度，故默认取小值 5。
const DEFAULT_QUESTION_LIMIT: u32 = 5;

/// 单次请求超时。
///
/// 实测 `/v1/meta/subjects` 首包耗时 10.6 秒（服务端冷启动/回源），
/// 故不能沿用常规 5~10 秒超时；30 秒可覆盖首包冷启动又不至于让 UI 无限等待。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 元数据接口同样适用（首次冷启动最慢的就是它们）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 提前过期窗口：剩余不足 60 秒即视为过期，避免 token 在请求途中失效。
const TRIAL_EXPIRY_SKEW: Duration = Duration::from_secs(60);

/// User-Agent：服务端可能按 UA 做风控，固定一个可识别值。
const USER_AGENT: &str = concat!("AIStudy/", env!("CARGO_PKG_VERSION"));

/// 允许访问的题庄主机白名单。
///
/// `baseUrl` 来自用户可编辑的设置项。若不做校验，一个被改坏的配置（或恶意导入的
/// 配置备份）就能把本题庄模块变成任意主机探测/SSRF 的跳板。此处只允许官方域名，
/// 且强制 https。
///
/// `custom` 来源不走本模块：`resolve_credentials` 只接受 `provider == "tizhuang"`，
/// 其它值一律报「未配置/来源不符」，因此白名单不会挡住合法的自定义需求。
const ALLOWED_HOSTS: &[&str] = &["tizhuang.qcscience.cc"];

// =============================================================================
// HTTP 客户端（进程内复用连接池）
// =============================================================================

/// 进程级共享客户端：reqwest 的连接池挂在 `Client` 上，每次命令新建
/// `Client` 会丢掉 keep-alive，元数据接口本身又慢（10.6s 首包），
/// 复用连接对连续筛选操作有实际收益。
static HTTP_CLIENT: LazyLock<std::result::Result<reqwest::Client, String>> =
    LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| format!("构建题库 HTTP 客户端失败: {e}"))
    });

fn http_client() -> Result<&'static reqwest::Client> {
    match &*HTTP_CLIENT {
        Ok(client) => Ok(client),
        Err(err) => Err(AppError::internal(err.clone())),
    }
}

// =============================================================================
// 试用 token 的内存缓存
// =============================================================================

/// 内存中的试用会话，避免每次命令都读加密存储（解密有 PBKDF2 开销）。
///
/// 缓存的**权威来源仍是设置项**：本结构只是读缓存，进程重启后从设置项重建。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrialSession {
    token: String,
    /// RFC3339 或 `YYYY-MM-DDTHH:MM:SS` 形态的过期时间，原样透传给前端展示。
    expires_at: Option<String>,
    /// 解析出的过期 Unix 秒；解析失败为 `None`。
    #[serde(default)]
    expires_at_unix: Option<i64>,
    question_limit: Option<u64>,
    register_url: Option<String>,
    registered_daily_limit: Option<u64>,
}

impl TrialSession {
    /// 过期判定：解析不出过期时间时**保守视为仍有效**。
    ///
    /// 理由：服务端限制的是它自己签发的 token，我们这边误判「已过期」只会
    /// 白白新建一个身份（消耗匿名限额、违反「禁止轮换」要求）；
    /// 而误判「未过期」最坏情况是发一次请求拿到 401，再走一次重建即可。
    fn is_expired(&self, now_unix: i64) -> bool {
        match self.expires_at_unix {
            Some(exp) => now_unix + TRIAL_EXPIRY_SKEW.as_secs() as i64 >= exp,
            None => false,
        }
    }
}

/// 试用会话的进程内缓存。
///
/// 存在的意义：`get_secret` 走加密文件 + 解密（PBKDF2 派生），对「连续几次
/// 筛选请求」而言开销可观，而 token 的生命周期是 24 小时——放进内存可让
/// 同一进程内的后续调用零解密成本。
///
/// 权威来源仍是设置项：进程重启后由 `load_persisted_trial` 重建。
#[derive(Default)]
struct TrialCache {
    current: Option<TrialSession>,
}

static TRIAL_CACHE: LazyLock<tokio::sync::Mutex<TrialCache>> =
    LazyLock::new(|| tokio::sync::Mutex::new(TrialCache::default()));

// =============================================================================
// 前端配置反序列化（结构必须与 config.ts 的 QuestionBankConfig 对齐）
// =============================================================================

/// 与 `config.ts` 的 `QuestionBankConfig` 同构。
///
/// `credentials` 是 `provider → { field.key → value }` 的两层映射
/// （`Partial<Record<QuestionBankProviderId, QuestionBankCredentials>>`）。
/// 字段名保持前端 camelCase —— 前端 `JSON.stringify(currentConfig)` 原样落库，
/// 这里加 `rename_all` 反而会读不到。
#[derive(Debug, Clone, Default, Deserialize)]
struct QuestionBankConfig {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    credentials: HashMap<String, HashMap<String, String>>,
}

/// 从前端配置解析出的题庄调用参数。
#[derive(Debug, Clone)]
struct TizhuangCredentials {
    /// 已规范化（去掉尾部 `/`）的 base URL。
    base_url: String,
    /// 非空即视为「已配置 License」→ 走 `/v1/*` 路由。
    license: Option<String>,
}

/// 读取并反序列化题库配置。
///
/// 设置项可能被手工改坏或被旧版本写入，因此**任何畸形输入都回落到默认**
/// （空配置），而不是让命令报错——与前端 `parseQuestionBankConfig` 的
/// 全防御语义保持一致。
fn read_config(state: &AppState) -> QuestionBankConfig {
    let raw = match state.database.get_secret(CONFIG_SETTING_KEY) {
        Ok(value) => value,
        Err(err) => {
            // 注意：不打印设置值本身，仅打印错误（错误里只有 key 名）。
            log::warn!("[question_bank] 读取题库配置失败，按未配置处理: {err}");
            return QuestionBankConfig::default();
        }
    };

    let Some(raw) = raw else {
        return QuestionBankConfig::default();
    };

    serde_json::from_str::<QuestionBankConfig>(&raw).unwrap_or_else(|err| {
        log::warn!("[question_bank] 题库配置 JSON 解析失败，按未配置处理: {err}");
        QuestionBankConfig::default()
    })
}

/// 从配置中取出题庄凭据（含 baseUrl / License），并做安全校验。
fn resolve_credentials(config: &QuestionBankConfig) -> Result<TizhuangCredentials> {
    match config.provider.as_deref() {
        Some("tizhuang") => {}
        Some(other) => {
            return Err(AppError::configuration(format!(
                "当前题库来源「{other}」不是题庄，请先在设置中切换到题庄"
            )))
        }
        None => {
            return Err(AppError::configuration(
                "题库未配置：请先在「刷题 → 题库设置」中选择题庄",
            ))
        }
    }

    let creds = config.credentials.get("tizhuang");

    let base_raw = creds
        .and_then(|c| c.get("baseUrl"))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE_URL);

    let base_url = normalize_base_url(base_raw)?;

    let license = creds
        .and_then(|c| c.get("accessKey"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(TizhuangCredentials { base_url, license })
}

/// 规范化并校验 base URL：仅允许 https + 白名单主机。
///
/// 拒绝 http 的理由不只是传输安全：明文 HTTP 下 `X-API-Key` 会被链路上
/// 任意中间节点读到，而这是用户的教育平台长期凭据。
fn normalize_base_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/');

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|e| AppError::validation(format!("题库接口地址不是合法 URL: {e}")))?;

    if parsed.scheme() != "https" {
        return Err(AppError::validation(
            "题库接口地址必须使用 https（凭据以请求头发送，明文传输会被链路截获）",
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::validation("题库接口地址缺少主机名"))?
        .to_ascii_lowercase();

    if !ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
    {
        return Err(AppError::validation(format!(
            "题库接口地址主机「{host}」不在允许列表内"
        )));
    }

    Ok(trimmed.to_string())
}

// =============================================================================
// 响应类型（serde 字段名严格对照实测 payload）
// =============================================================================

/// 匿名试用创建 / 查询的响应。
///
/// 实测 `POST /v1/trials` 返回：
/// ```json
/// {"trial_token":"try_xxx","question_limit":100,
///  "expires_at":"2026-10-05T07:30:20",
///  "register_url":"https://tizhuang.qcscience.cc/account?mode=register",
///  "registered_daily_limit":200,"registration_benefits":[...]}
/// ```
///
/// 注意两点：
/// 1. `trial_token` 在**配额响应里不返回**（实测 `/v1/trial/quota` 无该字段），
///    故必须 `Option`，不能因为缺字段就反序列化失败。
/// 2. `expires_at` 是**无时区本地时间字符串**，不能直接当 UTC 用；
///    解析逻辑见 `parse_expires_at`。
#[derive(Debug, Clone, Deserialize)]
struct TrialResponse {
    #[serde(default)]
    trial_token: Option<String>,
    #[serde(default)]
    question_limit: Option<u64>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    register_url: Option<String>,
    #[serde(default)]
    registered_daily_limit: Option<u64>,
}

/// `/v1/quota` 与 `/v1/trial/quota` 的响应。
#[derive(Debug, Clone, Deserialize)]
struct QuotaResponse {
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    question_limit: Option<u64>,
    #[serde(default)]
    used: Option<u64>,
    #[serde(default)]
    remaining: Option<u64>,
    #[serde(default)]
    register_url: Option<String>,
    #[serde(default)]
    registered_daily_limit: Option<u64>,
}

/// 分页包装：`GET /v1/trial/questions` 实测返回 `{"items":[...]}`，
/// **不是裸数组**。`total` 等附加字段用 `#[serde(flatten)]` 收口，
/// 既不因服务端加字段而失败，也不丢弃服务端信息。
#[derive(Debug, Clone, Deserialize)]
struct ItemsResponse {
    #[serde(default)]
    items: Vec<serde_json::Value>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// 面向前端的题目对象。
///
/// 字段与实测返回的 24 个字段**逐一对应**（`id` … `year`）。
/// 全部 `Option` + `#[serde(default)]`：上游加字段/缺字段都不应让整次搜索失败，
/// 单个题目字段缺失也不该拖垮整页。
///
/// ### 给前端的契约（前端必须遵守）
/// - `title` / `options` / `answer` / `analysis` 是**原始文本**（含 LaTeX `$...$`），
///   配合项目已有的 Markdown + KaTeX 渲染能力使用。
/// - `title_html` / `options_html` / `analysis_html` 是**不受信任的 HTML**：
///   不要 `innerHTML` 直插。非 html 版本优先。
/// - `image_urls` 是**绝对 URL 数组**，可直接引用。
/// - `subquestions` 是复合题子题，**必须与父题保持在一起**渲染。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// ⚠️ **只对 Serialize 用 camelCase**（前端读 camelCase），
//    **反序列化必须用上游原样**（上游返回 `title_html`/`image_urls` 等 snake_case）。
//    若两向都 rename_all = "camelCase"，`serde_json::from_value` 会去找
//    `titleHtml` → 全部字段解析失败 → 而调用点是
//    `filter_map(|raw| from_value(raw).ok())` **静默吞错** → 用户看到「0 道题」。
//    这是 CI run #14 的教训（当时还只缺 Deserialize 派生，加派生后此陷阱才显形）。
#[serde(rename_all(serialize = "camelCase"))]
pub struct QuestionBankQuestion {
    pub id: Option<i64>,
    pub title: Option<String>,
    pub title_html: Option<String>,
    pub options: Option<serde_json::Value>,
    pub options_html: Option<String>,
    pub answer: Option<serde_json::Value>,
    pub answer_html: Option<String>,
    pub analysis: Option<String>,
    pub analysis_html: Option<String>,
    pub question_type: Option<String>,
    pub difficulty: Option<serde_json::Value>,
    pub subject_id: Option<serde_json::Value>,
    pub grade_id: Option<serde_json::Value>,
    pub knowledges: Option<serde_json::Value>,
    pub area: Option<String>,
    pub year: Option<serde_json::Value>,
    pub paper_type: Option<String>,
    pub source: Option<String>,
    pub is_auto_gradable: Option<bool>,
    /// 来源稳定标识，可用于去重与「找同类题」的回溯。
    pub content_hash: Option<String>,
    pub has_images: Option<bool>,
    pub image_urls: Option<Vec<String>>,
    /// 复合题子题：保持上游原结构透传，本层不做结构假设
    /// （子题嵌套深度与字段由上游决定，过早建模会随上游变动而失效）。
    pub subquestions: Option<serde_json::Value>,
}

/// 搜题命令的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionBankSearchResult {
    /// 题目列表。
    pub items: Vec<QuestionBankQuestion>,
    /// 本次实际返回的父题数 —— **等于本次消费的额度**。
    ///
    /// 单独给出而不是让前端 `items.length`，是因为上层可能在未来做裁剪，
    /// 而计费口径必须唯一。
    pub billed_count: usize,
    /// 本次是否走的匿名试用路由（前端据此提示「注册可提额」）。
    pub used_trial: bool,
    /// 服务端返回的其它分页/统计字段，原样透传。
    pub extra: HashMap<String, serde_json::Value>,
}

/// 试用状态命令的返回（含是否已创建、过期时间、剩余额度）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionBankTrialStatus {
    /// 当前是否持有可用（未过期）的试用身份。
    pub active: bool,
    /// **绝不返回 token 明文**：前端只需要知道「有没有」。
    pub has_token: bool,
    pub expires_at: Option<String>,
    /// 过期时间的 unix 秒（时区已被归一化）；解析失败为 None。
    pub expires_at_unix: Option<i64>,
    pub question_limit: Option<u64>,
    pub register_url: Option<String>,
    pub registered_daily_limit: Option<u64>,
}

// =============================================================================
// 时间解析（无时区字符串的处理）
// =============================================================================

/// 解析服务端返回的 `expires_at`。
///
/// 实测格式为 `2026-10-05T07:30:20` —— **不带时区偏移**。契约上没有说明它是
/// 哪个时区，因此：
/// - 优先解析 RFC3339（带 `Z` / `+08:00` 时按真实时区换算）；
/// - 无时区时按 **UTC** 解释（`NaiveDateTime::and_utc`）。
///
/// 按 UTC 解释若与服务端实际时区不一致，只会让本地做过期预判的**时刻**有偏差；
/// 服务端始终是最终裁决者（401 时我们会重建），故该偏差不构成正确性问题，
/// 只影响提前重建的时机。
///
/// 解析失败返回 `None` —— 调用方会保守视为「未过期」（见 `TrialSession::is_expired`），
/// 避免因解析问题反复创建新匿名身份。
fn parse_expires_at(raw: Option<&str>) -> Option<i64> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.timestamp());
    }

    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.and_utc().timestamp());
    }

    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(naive.and_utc().timestamp());
    }

    // 纯日期兜底（当天 00:00:00）
    if let Ok(date) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp());
    }

    log::warn!("[question_bank] 无法解析试用过期时间格式，按未过期处理");
    None
}

// =============================================================================
// 匿名身份（持久化 + 禁止轮换）
// =============================================================================

/// 取回或创建**稳定的**匿名客户端标识。
///
/// 该标识一旦生成即永久复用：
/// - 文档明确禁止轮换身份以规避限额；
/// - 每次轮换都会让同一台设备的试用额度被重置，属于滥用；
/// - 它同时是服务端关联「同一匿名用户」的唯一依据。
///
/// 生成失败（极小概率，仅在系统熵源不可用时）不阻断流程：返回 `None`，
/// 服务端会按 IP 等其它维度识别。**不 panic**。
fn get_or_create_anonymous_client_id(state: &AppState) -> Option<String> {
    match state.database.get_secret(ANON_CLIENT_ID_SETTING_KEY) {
        Ok(Some(existing)) => {
            let trimmed = existing.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
        Ok(None) => {}
        Err(err) => {
            log::warn!("[question_bank] 读取匿名客户端标识失败，将新建: {err}");
        }
    }

    // uuid v4 的 hyphenated 形式天然是 URL-safe 字符集（[0-9a-f-]）。
    let generated = uuid::Uuid::new_v4().to_string();

    if let Err(err) = state
        .database
        .save_secret(ANON_CLIENT_ID_SETTING_KEY, &generated)
    {
        // 持久化失败仍返回本次生成值：至少本次请求可完成。
        // 但下一轮会生成新值 —— 这是可接受的降级（存储不可用时本来也保不住身份）。
        log::warn!("[question_bank] 持久化匿名客户端标识失败: {err}");
    }

    Some(generated)
}

// =============================================================================
// 试用会话的读取 / 创建（24h 复用）
// =============================================================================

/// 从设置项反序列化出已缓存的试用会话。
fn load_persisted_trial(state: &AppState) -> Option<TrialSession> {
    let raw = match state.database.get_secret(TRIAL_TOKEN_SETTING_KEY) {
        Ok(value) => value?,
        Err(err) => {
            log::warn!("[question_bank] 读取试用会话失败: {err}");
            return None;
        }
    };

    serde_json::from_str::<TrialSession>(&raw)
        .map_err(|err| log::warn!("[question_bank] 试用会话 JSON 解析失败，将重建: {err}"))
        .ok()
}

fn persist_trial(state: &AppState, session: &TrialSession) -> Result<()> {
    let encoded = serde_json::to_string(session)
        .map_err(|e| AppError::internal(format!("序列化试用会话失败: {e}")))?;

    state
        .database
        .save_secret(TRIAL_TOKEN_SETTING_KEY, &encoded)
        .map_err(|e| AppError::database(format!("保存试用会话失败: {e}")))
}

/// 取当前可用会话：**内存缓存 → 设置项 → 都没有则返回 None**。
///
/// 关键约束：**24 小时内必须复用同一 token，不得每次请求都新建**。
/// 因此本函数只做「读」和「过期判定」，创建动作只在 `ensure_trial_session`
/// 里发生一次。
async fn current_trial_session(state: &AppState) -> Option<TrialSession> {
    let now = chrono::Utc::now().timestamp();

    {
        let cache = TRIAL_CACHE.lock().await;
        if let Some(session) = cache.current.as_ref() {
            if !session.is_expired(now) {
                return Some(session.clone());
            }
        }
    }

    // 内存未命中：回设源。
    let persisted = load_persisted_trial(state)?;

    if persisted.is_expired(now) {
        // 过期会话立即从缓存摘除，但不在这里删除设置项：
        // 删除动作放到「成功创建新会话之后」，避免创建失败时两头皆空。
        let mut cache = TRIAL_CACHE.lock().await;
        cache.current = None;
        return None;
    }

    let mut cache = TRIAL_CACHE.lock().await;
    cache.current = Some(persisted.clone());
    Some(persisted)
}

/// 确保持有一个可用的试用会话；没有则创建一次。
///
/// ## 并发安全
/// 缓存里放的是「已就绪的会话」而非 in-flight future，因此两个并发调用可能
/// 各自发一次 `POST /v1/trials`。这是**有意的取舍**：用 `tokio::sync::Mutex`
/// 持有整段 HTTP 等待会引入跨 await 的锁竞争与取消安全问题，而本模块的调用
/// 是用户点击触发的低频操作，重复创建是极小概率事件，且服务端对同一
/// `X-Anonymous-Client-ID` 的重复创建不会累积成新的匿名身份。
async fn ensure_trial_session(state: &AppState) -> Result<TrialSession> {
    if let Some(session) = current_trial_session(state).await {
        return Ok(session);
    }

    // 试产路由所需凭据在**发起试用创建之前**解析：避免在网络往返之后才发现
    // baseUrl 非法或 provider 不是题庄，白跑一趟请求。
    let credentials = resolve_credentials(&read_config(state))?;

    let client_id = get_or_create_anonymous_client_id(state);

    let url = format!("{}/v1/trials", credentials.base_url);

    let mut request = http_client()?
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        // 空 JSON body：服务端要求 Content-Type: application/json
        .body("{}");

    if let Some(ref cid) = client_id {
        request = request.header("X-Anonymous-Client-ID", cid.as_str());
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::network(format!("创建题庄匿名试用失败（网络错误）: {}", classify_reqwest_error(&e))))?;

    let status = response.status();
    // 非 2xx 的响应体只用于提取 detail，不在此处保序；
    // 先固定状态码分支再消费 body，避免依赖 Response 的借用顺序。
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_error(status.as_u16(), &body, true));
    }

    let body = response.text().await.unwrap_or_default();

    let parsed: TrialResponse = serde_json::from_str(&body).map_err(|_| {
        AppError::network("题庄试用接口返回了无法解析的响应体（接口可能已变更）")
    })?;

    let token = parsed
        .trial_token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::network("题庄试用接口未返回 trial_token"))?;

    let session = TrialSession {
        token,
        expires_at_unix: parse_expires_at(parsed.expires_at.as_deref()),
        expires_at: parsed.expires_at,
        question_limit: parsed.question_limit,
        register_url: parsed.register_url,
        registered_daily_limit: parsed.registered_daily_limit,
    };

    // 先落盘再更新内存缓存：落盘失败时内存里也不留「看似可用」的会话，
    // 避免下次进程重启后身份丢失造成实际上的轮换。
    persist_trial(state, &session)?;

    {
        let mut cache = TRIAL_CACHE.lock().await;
        cache.current = Some(session.clone());
    }

    log::info!(
        "[question_bank] 已创建匿名试用会话（token 长度 {}）",
        session.token.len()
    );

    Ok(session)
}

// =============================================================================
// 通用请求
// =============================================================================

/// 认证方式：决定路由前缀与请求头。
#[derive(Debug, Clone)]
enum Auth {
    /// `GET /v1/...` + `X-API-Key`
    License(String),
    /// `GET /v1/trial/...` + `X-Trial-Token`
    Trial(String),
}

impl Auth {
    fn is_trial(&self) -> bool {
        matches!(self, Auth::Trial(_))
    }
}

/// 解析出「本次该用哪套路由」，并在需要试用时确保 token 已就绪。
///
/// 这是「有 License / 无 License 选路由」的唯一决策点：
/// 只配置了非空 `accessKey` 就走 `License` 分支，否则走 `Trial` 分支。
async fn resolve_auth(state: &AppState) -> Result<(TizhuangCredentials, Auth)> {
    let credentials = resolve_credentials(&read_config(state))?;

    let auth = match credentials.license.clone() {
        Some(license) => Auth::License(license),
        None => {
            let session = ensure_trial_session(state).await?;
            Auth::Trial(session.token)
        }
    };

    Ok((credentials, auth))
}

/// 把认证信息套到请求上。
///
/// 凭据**只进请求头**：`X-API-Key` / `X-Trial-Token` 从不拼进 URL。
fn apply_auth(request: reqwest::RequestBuilder, auth: &Auth) -> reqwest::RequestBuilder {
    match auth {
        Auth::License(license) => request.header("X-API-Key", license.as_str()),
        Auth::Trial(token) => request.header("X-Trial-Token", token.as_str()),
    }
}

/// 拼接路由：`/v1/meta/*` 免费且无 trial 变体，其余按认证方式加 `/trial` 前缀。
///
/// 实测证明这个必须是显式分支：用 `X-Trial-Token` 打 `/v1/questions` 会返回
/// `{"detail":"缺少 API Key，请使用 X-API-Key 请求头。"}` —— trial token
/// **只在 `/v1/trial/*` 路由上被识别**。
fn build_url(base_url: &str, auth: &Auth, path: &str) -> String {
    let prefix = match (auth.is_trial(), path.starts_with("/v1/meta/")) {
        // 元数据接口免费且不区分认证方式，保持原路径
        (_, true) => "/v1",
        (true, false) => "/v1/trial",
        (false, false) => "/v1",
    };
    let path = path.trim_start_matches('/');
    let path = path.strip_prefix("v1/").unwrap_or(path);
    format!("{base_url}{prefix}/{path}")
}

/// 发一次 GET，返回解析后的 JSON。
///
/// `on_trial_invalid` 为试用 token 失效时的重建回调：401/403 说明本地缓存的
/// token 已不可用（服务端主动作废、时钟偏差等），此时清缓存重建一次再重试。
async fn get_json(
    state: &AppState,
    path: &str,
    query: &[(String, String)],
) -> Result<(Auth, serde_json::Value)> {
    let (credentials, auth) = resolve_auth(state).await?;

    match send_get_json(&credentials.base_url, &auth, path, query).await {
        Ok(value) => Ok((auth, value)),
        Err(SendError::AuthExpired) if auth.is_trial() => {
            // 试用 token 已失效：清掉本地缓存后重建一次。
            log::info!("[question_bank] 试用 token 被服务端拒绝，重建匿名身份后重试一次");
            invalidate_trial(state).await;
            let refreshed = ensure_trial_session(state).await?;
            let retry_auth = Auth::Trial(refreshed.token);
            let value = send_get_json(&credentials.base_url, &retry_auth, path, query)
                .await
                .map_err(SendError::into_app_error)?;
            Ok((retry_auth, value))
        }
        Err(err) => Err(err.into_app_error()),
    }
}

/// 内部请求错误：区分「可重试的认证失效」与「直接上报的其它错误」。
enum SendError {
    /// 401 / 403：试用 token 失效，可重建后重试。
    AuthExpired,
    /// 其它 HTTP 状态（含 429）。
    Http(u16, String),
    /// 传输层错误。
    Transport(String),
    /// 响应体不是合法 JSON。
    Decode,
}

impl SendError {
    fn into_app_error(self) -> AppError {
        match self {
            SendError::AuthExpired => AppError::authentication(
                "题庄凭据已失效：若使用 License 请在设置中更新，若为匿名试用请稍后重试",
            ),
            SendError::Http(status, body) => map_http_error(status, &body, false),
            SendError::Transport(detail) => {
                AppError::network(format!("访问题庄题库失败（网络错误）: {detail}"))
            }
            SendError::Decode => {
                AppError::network("题庄题库返回了无法解析的响应体（接口可能已变更）")
            }
        }
    }
}

async fn send_get_json(
    base_url: &str,
    auth: &Auth,
    path: &str,
    query: &[(String, String)],
) -> std::result::Result<serde_json::Value, SendError> {
    let url = build_url(base_url, auth, path);

    let client = http_client().map_err(|e| SendError::Transport(e.to_string()))?;

    let mut request = client.get(&url);
    if !query.is_empty() {
        // 只承载业务筛选参数；凭据从不进入 query。
        request = request.query(query);
    }
    request = apply_auth(request, auth);

    let response = request
        .send()
        .await
        .map_err(|e| SendError::Transport(classify_reqwest_error(&e)))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(SendError::AuthExpired);
    }

    if !status.is_success() {
        return Err(SendError::Http(status.as_u16(), body));
    }

    serde_json::from_str::<serde_json::Value>(&body).map_err(|_| SendError::Decode)
}

/// 清空试用缓存（内存 + 设置项）。
async fn invalidate_trial(state: &AppState) {
    let stale = {
        let mut cache = TRIAL_CACHE.lock().await;
        cache.current.take()
    };

    if stale.is_some() {
        if let Err(err) = state.database.delete_secret(TRIAL_TOKEN_SETTING_KEY) {
            log::warn!("[question_bank] 清理失效试用会话失败: {err}");
        }
    }
}

/// 把 HTTP 错误映射成对用户可读、且**不含凭据**的 `AppError`。
///
/// 服务端错误体的 `detail` 字段本身不含凭据（是「缺少 API Key」这类说明），
/// 但仍做长度截断，避免上游返回超长/含 HTML 的内容直接进 UI。
fn map_http_error(status: u16, body: &str, is_trial_creation: bool) -> AppError {
    let detail = extract_detail(body);

    match status {
        401 | 403 => {
            if is_trial_creation {
                AppError::authentication("题庄拒绝创建匿名试用（可能该设备/IP 已被限制）")
            } else {
                AppError::authentication(
                    "题庄凭据无效：License 可能已过期或被撤销，请在题库设置中更新",
                )
            }
        }
        // ⚠️ 必须带结构化错误码，前端不得靠匹配文案识别（见下方 QUESTION_BANK_ERR_* 说明）
        429 => AppError::with_details(
            AppErrorType::Network,
            "题庄题库额度已耗尽：匿名试用 24 小时 100 题，注册后可提升至 200 题/日",
            serde_json::json!({ "code": "quota_exhausted" }),
        ),
        400 | 422 => AppError::validation(format!(
            "题庄题库拒绝了本次查询参数{}",
            detail.map(|d| format!("：{d}")).unwrap_or_default()
        )),
        404 | 410 => AppError::not_found("题庄题库接口不存在（接口可能已变更，请检查接口地址）"),
        500..=599 => AppError::network(format!(
            "题庄题库服务端错误（HTTP {status}）{}",
            detail.map(|d| format!("：{d}")).unwrap_or_default()
        )),
        _ => AppError::network(format!(
            "访问题庄题库失败（HTTP {status}）{}",
            detail.map(|d| format!("：{d}")).unwrap_or_default()
        )),
    }
}

/// 从错误响应体里取 `detail` 字段（题庄的错误体形态为 `{"detail": "..."}`）。
fn extract_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let detail = value.get("detail")?.as_str()?.trim();

    if detail.is_empty() {
        return None;
    }

    // 截断：错误体来自外部服务，不应无界进入 UI 与日志。
    const MAX: usize = 200;
    Some(if detail.chars().count() > MAX {
        detail.chars().take(MAX).collect::<String>() + "…"
    } else {
        detail.to_string()
    })
}

/// 把 reqwest 错误分类成简短原因。
///
/// **只输出类别，不输出完整错误链**：reqwest 的 `Display` 可能带上完整 URL，
/// 而 URL 虽不含凭据（我们从不把凭据放 query），仍无必要进 UI。
fn classify_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "请求超时（题庄元数据接口首次访问较慢，可稍后重试）".to_string()
    } else if err.is_connect() {
        "无法连接到题庄服务器（请检查网络）".to_string()
    } else if err.is_decode() {
        "响应解析失败".to_string()
    } else {
        "传输失败".to_string()
    }
}

// =============================================================================
// 参数构造
// =============================================================================

/// 单个筛选参数：仅在非空时进入 query。
fn push_param(query: &mut Vec<(String, String)>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            query.push((key.to_string(), trimmed.to_string()));
        }
    }
}

fn push_num(query: &mut Vec<(String, String)>, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        query.push((key.to_string(), value.to_string()));
    }
}

fn push_bool(query: &mut Vec<(String, String)>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        query.push((key.to_string(), if value { "true" } else { "false" }.to_string()));
    }
}

/// `/v1/meta/{kind}` 的合法取值。
fn normalize_meta_kind(kind: &str) -> Result<&'static str> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "subjects" => Ok("subjects"),
        "grades" => Ok("grades"),
        "editions" => Ok("editions"),
        "chapters" => Ok("chapters"),
        // 前端可能传 knowledge_points / knowledge-points 两种写法，统一归一
        "knowledge-points" | "knowledge_points" | "knowledgepoints" => Ok("knowledge-points"),
        other => Err(AppError::validation(format!(
            "不支持的元数据类型「{other}」：可选 subjects/grades/editions/chapters/knowledge-points"
        ))),
    }
}

// =============================================================================
// Tauri 命令
// =============================================================================

/// 查询题庄额度。
///
/// - 有 License → `GET /v1/quota`（`X-API-Key`）
/// - 匿名试用 → `GET /v1/trial/quota`（`X-Trial-Token`）
#[tauri::command]
pub async fn question_bank_get_quota(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let (auth, value) = get_json(state.inner(), "v1/quota", &[]).await?;

    let parsed: QuotaResponse = serde_json::from_value(value.clone()).unwrap_or(QuotaResponse {
        expires_at: None,
        question_limit: None,
        used: None,
        remaining: None,
        register_url: None,
        registered_daily_limit: None,
    });

    Ok(serde_json::json!({
        "usedTrial": auth.is_trial(),
        "expiresAt": parsed.expires_at,
        // 无时区字符串，统一换算成 unix 秒供前端安全比较
        "expiresAtUnix": parse_expires_at(parsed.expires_at.as_deref()),
        "questionLimit": parsed.question_limit,
        "used": parsed.used,
        "remaining": parsed.remaining,
        "registerUrl": parsed.register_url,
        "registeredDailyLimit": parsed.registered_daily_limit,
        "raw": value,
    }))
}

/// 拉取元数据表（免费、不消费额度）。
///
/// `kind`: `subjects` / `grades` / `editions` / `chapters` / `knowledge-points`。
///
/// 实测 `/v1/meta/subjects` 返回**裸数组**（`[{"id":1,"name":"语文","pinyin":null}]`），
/// 与搜题的 `{"items":[...]}` 形状不同 —— 这里统一包装成 `{kind, items}` 再交给前端，
/// 让前端只面对一种形状。
#[tauri::command]
pub async fn question_bank_list_meta(
    kind: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let kind = normalize_meta_kind(&kind)?;
    let path = format!("v1/meta/{kind}");

    let (auth, value) = get_json(state.inner(), &path, &[]).await?;

    // 兼容两种形状：裸数组，或 `{items: [...]}` 包装。
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(ref map) => map
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    Ok(serde_json::json!({
        "kind": kind,
        "items": items,
        "usedTrial": auth.is_trial(),
    }))
}

/// 查询当前匿名试用状态（**不创建**新身份）。
///
/// 与 `ensure_trial_session` 的区别：本命令是只读的。前端可用它在设置页
/// 显示「试用剩余额度 / 是否已注册」，而不因为用户打开设置页就触发一次
/// 匿名身份创建。
#[tauri::command]
pub async fn question_bank_trial_status(
    state: State<'_, AppState>,
) -> Result<QuestionBankTrialStatus> {
    let session = current_trial_session(state.inner()).await;

    Ok(match session {
        Some(session) => QuestionBankTrialStatus {
            active: true,
            has_token: !session.token.is_empty(),
            expires_at: session.expires_at,
            expires_at_unix: session.expires_at_unix,
            question_limit: session.question_limit,
            register_url: session.register_url,
            registered_daily_limit: session.registered_daily_limit,
        },
        None => QuestionBankTrialStatus {
            active: false,
            has_token: false,
            expires_at: None,
            expires_at_unix: None,
            question_limit: None,
            register_url: None,
            registered_daily_limit: None,
        },
    })
}

/// 主动创建（或复用）匿名试用身份，并返回其状态。
///
/// 供设置页「立即启用匿名试用」按钮调用；已持有未过期会话时**直接复用**，
/// 不会重复创建。
#[tauri::command]
pub async fn question_bank_ensure_trial(
    state: State<'_, AppState>,
) -> Result<QuestionBankTrialStatus> {
    let session = ensure_trial_session(state.inner()).await?;

    Ok(QuestionBankTrialStatus {
        active: true,
        has_token: !session.token.is_empty(),
        expires_at: session.expires_at,
        expires_at_unix: session.expires_at_unix,
        question_limit: session.question_limit,
        register_url: session.register_url,
        registered_daily_limit: session.registered_daily_limit,
    })
}

/// 搜索题目。
///
/// ## 计费
/// 实测：**按返回的父题数精确计费**（`limit=3` → `used` 0→3）。
/// 因此默认 `limit` 取 `DEFAULT_QUESTION_LIMIT`(5) 而非 100 —— 一次
/// 满额搜索会吃掉整份匿名试用额度（100 题）。前端「找同类题」场景
/// 应显式传小 limit。
///
/// ## 参数
/// 全部为可选；`limit` 会被 clamp 到 `[1, 100]`（服务端上限 100）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn question_bank_search_questions(
    subject_id: Option<i64>,
    grade_id: Option<i64>,
    question_type: Option<String>,
    difficulty_min: Option<i64>,
    difficulty_max: Option<i64>,
    year: Option<i64>,
    paper_type: Option<String>,
    keyword: Option<String>,
    knowledge_id: Option<i64>,
    knowledge_tree_id: Option<i64>,
    knowledge_tree_ids: Option<String>,
    edition_id: Option<i64>,
    chapter_id: Option<i64>,
    auto_gradable: Option<bool>,
    has_images: Option<bool>,
    offset: Option<u32>,
    limit: Option<u32>,
    random_order: Option<bool>,
    state: State<'_, AppState>,
) -> Result<QuestionBankSearchResult> {
    let mut query: Vec<(String, String)> = Vec::new();

    push_num(&mut query, "subject_id", subject_id);
    push_num(&mut query, "grade_id", grade_id);
    push_param(&mut query, "question_type", question_type);
    // 服务端契约：难度 0-5
    push_num(
        &mut query,
        "difficulty_min",
        difficulty_min.map(|v| v.clamp(0, 5)),
    );
    push_num(
        &mut query,
        "difficulty_max",
        difficulty_max.map(|v| v.clamp(0, 5)),
    );
    push_num(&mut query, "year", year);
    push_param(&mut query, "paper_type", paper_type);
    push_param(&mut query, "keyword", keyword);
    push_num(&mut query, "knowledge_id", knowledge_id);
    push_num(&mut query, "knowledge_tree_id", knowledge_tree_id);
    push_param(&mut query, "knowledge_tree_ids", knowledge_tree_ids);
    push_num(&mut query, "edition_id", edition_id);
    push_num(&mut query, "chapter_id", chapter_id);
    push_bool(&mut query, "auto_gradable", auto_gradable);
    push_bool(&mut query, "has_images", has_images);
    push_num(&mut query, "offset", offset.map(i64::from));
    push_num(
        &mut query,
        "limit",
        Some(i64::from(normalize_limit(limit))),
    );
    push_bool(&mut query, "random_order", random_order);

    let (auth, value) = get_json(state.inner(), "v1/questions", &query).await?;

    let parsed: ItemsResponse = serde_json::from_value(value)
        .map_err(|_| AppError::network("题庄搜题返回了无法解析的响应体（接口可能已变更）"))?;

    // ⚠️ 不要用 `filter_map(|raw| from_value(raw).ok())` ——
    //    它把「字段名不匹配 / 上游改结构」这类**真实故障静默变成空列表**，
    //    用户只会看到「没找到同类题」，而实际是解析全失败（永远查不出来）。
    //    这里改为：**逐条解析，失败即报错并带上位置与原因**。
    let mut items: Vec<QuestionBankQuestion> = Vec::with_capacity(parsed.items.len());
    for (idx, raw) in parsed.items.into_iter().enumerate() {
        match serde_json::from_value::<QuestionBankQuestion>(raw) {
            Ok(q) => items.push(q),
            Err(e) => {
                return Err(AppError::network(format!(
                    "题庄搜题返回体中第 {} 条无法解析（接口可能已变更）：{}",
                    idx + 1,
                    e
                )));
            }
        }
    }

    let billed_count = items.len();

    Ok(QuestionBankSearchResult {
        items,
        billed_count,
        used_trial: auth.is_trial(),
        extra: parsed.extra,
    })
}

/// `limit` 归一：默认小值，clamp 到 `[1, MAX_QUESTION_LIMIT]`。
///
/// 传 0 也归一为 1 而不是报错——用户侧「0」的真实意图通常是「给我少一点」，
/// 报错体验差且无信息量。
fn normalize_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_QUESTION_LIMIT)
        .clamp(1, MAX_QUESTION_LIMIT)
}

// =============================================================================
// 单元测试（纯函数，不触网、不依赖 Tauri runtime）
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：QuestionBankQuestion 必须能**反序列化上游的 snake_case**。
    ///
    /// CI run #14 的教训（两层）：
    /// 1. 该结构原本只 `derive(Serialize)`，缺 `Deserialize` → 编译错 E0277；
    /// 2. 补上派生后若 `rename_all = "camelCase"` 对**两个方向都生效**，
    ///    反序列化会去找 `titleHtml` 而上游给的是 `title_html` → **字段全失败**，
    ///    而调用点原先用 `filter_map(..ok())` **静默吞错** → 用户只看到「0 道题」。
    /// 故此处用真实上游形状断言，锁死「反序列化走原样字段名」。
    #[test]
    fn parses_upstream_snake_case_question() {
        let raw = serde_json::json!({
            "id": 37561799,
            "title": "题干 $x^2$",
            "title_html": "<p>题干</p>",
            "options": ["A. 1", "B. 2"],
            "answer": "A",
            "analysis": "解析",
            "question_type": "选择题",
            "difficulty": 3,
            "subject_id": 2,
            "grade_id": 8,
            "knowledges": ["一次函数"],
            "image_urls": ["https://example.com/a.png"],
            "content_hash": "abc",
            "has_images": true,
            "subquestions": []
        });
        let q: QuestionBankQuestion = serde_json::from_value(raw)
            .expect("上游 snake_case 必须能反序列化（rename_all 只应对 Serialize 生效）");
        assert_eq!(q.id, Some(37561799));
        assert_eq!(q.title.as_deref(), Some("题干 $x^2$"));
        assert_eq!(q.title_html.as_deref(), Some("<p>题干</p>"));   // ← camelCase 会在此失败
        assert_eq!(q.question_type.as_deref(), Some("选择题"));
        assert_eq!(q.image_urls.as_ref().map(|v| v.len()), Some(1));
        assert_eq!(q.content_hash.as_deref(), Some("abc"));
    }

    /// 回归：序列化给前端时必须是 **camelCase**（前端读 `billedCount` 等）。
    #[test]
    fn serializes_question_as_camel_case() {
        let q = QuestionBankQuestion {
            title_html: Some("<p>x</p>".into()),
            question_type: Some("选择题".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&q).unwrap();
        assert!(v.get("titleHtml").is_some(), "序列化必须是 camelCase：{v}");
        assert!(v.get("questionType").is_some(), "序列化必须是 camelCase：{v}");
        assert!(v.get("title_html").is_none());
    }

    #[test]
    fn build_url_uses_trial_prefix_only_for_non_meta_paths() {
        let license = Auth::License("lic".into());
        let trial = Auth::Trial("try_abc".into());

        // 有 License：直连 /v1/*
        assert_eq!(
            build_url("https://tizhuang.qcscience.cc/api", &license, "v1/questions"),
            "https://tizhuang.qcscience.cc/api/v1/questions"
        );
        assert_eq!(
            build_url("https://tizhuang.qcscience.cc/api", &license, "v1/quota"),
            "https://tizhuang.qcscience.cc/api/v1/quota"
        );

        // 匿名试用：搜题与配额走 /v1/trial/*
        assert_eq!(
            build_url("https://tizhuang.qcscience.cc/api", &trial, "v1/questions"),
            "https://tizhuang.qcscience.cc/api/v1/trial/questions"
        );
        assert_eq!(
            build_url("https://tizhuang.qcscience.cc/api", &trial, "v1/quota"),
            "https://tizhuang.qcscience.cc/api/v1/trial/quota"
        );

        // 元数据接口免费且无 trial 变体，两种认证都走 /v1/meta/*
        assert_eq!(
            build_url(
                "https://tizhuang.qcscience.cc/api",
                &trial,
                "v1/meta/subjects"
            ),
            "https://tizhuang.qcscience.cc/api/v1/meta/subjects"
        );
        assert_eq!(
            build_url(
                "https://tizhuang.qcscience.cc/api",
                &license,
                "v1/meta/subjects"
            ),
            "https://tizhuang.qcscience.cc/api/v1/meta/subjects"
        );
    }

    #[test]
    fn normalize_limit_defaults_small_and_clamps() {
        // 默认必须是 5：默认 100 会一次吃掉整份试用额度
        assert_eq!(normalize_limit(None), 5);
        assert_eq!(normalize_limit(Some(0)), 1);
        assert_eq!(normalize_limit(Some(3)), 3);
        assert_eq!(normalize_limit(Some(100)), 100);
        // 超过服务端上限必须被 clamp（否则 422）
        assert_eq!(normalize_limit(Some(1000)), 100);
    }

    #[test]
    fn normalize_meta_kind_accepts_both_spellings() {
        assert_eq!(normalize_meta_kind("subjects").unwrap(), "subjects");
        assert_eq!(normalize_meta_kind(" GRADES ").unwrap(), "grades");
        assert_eq!(
            normalize_meta_kind("knowledge_points").unwrap(),
            "knowledge-points"
        );
        assert_eq!(
            normalize_meta_kind("knowledge-points").unwrap(),
            "knowledge-points"
        );
        assert!(normalize_meta_kind("unknown-kind").is_err());
    }

    #[test]
    fn normalize_base_url_enforces_https_and_allowlist() {
        assert_eq!(
            normalize_base_url("https://tizhuang.qcscience.cc/api/").unwrap(),
            "https://tizhuang.qcscience.cc/api"
        );
        // 明文 http 必须拒绝：凭据在请求头里
        assert!(normalize_base_url("http://tizhuang.qcscience.cc/api").is_err());
        // 非白名单主机必须拒绝：防止 baseUrl 变成 SSRF 跳板
        assert!(normalize_base_url("https://evil.example.com/api").is_err());
        assert!(normalize_base_url("not-a-url").is_err());
    }

    #[test]
    fn parse_expires_at_handles_naive_and_aware() {
        // 无时区字符串按 UTC 解释
        // ⚠️ `parse_expires_at` 返回 `Option<i64>`，断言必须用 `Some(...)` 包裹 ——
        //    原稿写成裸 i64 导致 E0308（该单测从未编译过，故一直没暴露）。
        assert_eq!(
            parse_expires_at(Some("2026-10-05T07:30:20")),
            Some(
                chrono::NaiveDate::from_ymd_opt(2026, 10, 5)
                    .unwrap()
                    .and_hms_opt(7, 30, 20)
                    .unwrap()
                    .and_utc()
                    .timestamp()
            )
        );
        // 带偏移按真实时区换算（+08:00 比 UTC 早 8 小时，故时间戳更小）
        let with_offset = parse_expires_at(Some("2026-10-05T07:30:20+08:00")).unwrap();
        let as_utc = parse_expires_at(Some("2026-10-05T07:30:20")).unwrap();
        assert_eq!(as_utc - with_offset, 8 * 3600);
        // 解析不出时必须返回 None（调用方据此保守视为未过期）
        assert_eq!(parse_expires_at(Some("garbage")), None);
        assert_eq!(parse_expires_at(None), None);
        assert_eq!(parse_expires_at(Some("   ")), None);
    }

    #[test]
    fn trial_session_expiry_is_conservative_on_unknown_expiry() {
        let now = 1_700_000_000;

        let unknown = TrialSession {
            token: "try_x".into(),
            expires_at: None,
            expires_at_unix: None,
            question_limit: None,
            register_url: None,
            registered_daily_limit: None,
        };
        // 过期时间未知 → 视为未过期，避免无谓重建身份（禁止轮换）
        assert!(!unknown.is_expired(now));

        let future = TrialSession {
            expires_at_unix: Some(now + 3600),
            ..unknown.clone()
        };
        assert!(!future.is_expired(now));

        let past = TrialSession {
            expires_at_unix: Some(now - 1),
            ..unknown.clone()
        };
        assert!(past.is_expired(now));

        // 落在 60 秒提前窗口内也判过期，避免请求途中失效
        let almost = TrialSession {
            expires_at_unix: Some(now + 30),
            ..unknown
        };
        assert!(almost.is_expired(now));
    }

    #[test]
    fn extract_detail_truncates_and_tolerates_bad_bodies() {
        assert_eq!(
            extract_detail(r#"{"detail":"缺少 API Key"}"#).unwrap(),
            "缺少 API Key"
        );
        // 非 JSON、无 detail、空 detail 都不应 panic
        assert!(extract_detail("not json").is_none());
        assert!(extract_detail("{}").is_none());
        assert!(extract_detail(r#"{"detail":"   "}"#).is_none());

        let long = format!(r#"{{"detail":"{}"}}"#, "x".repeat(500));
        let truncated = extract_detail(&long).unwrap();
        assert_eq!(truncated.chars().count(), 201); // 200 + 省略号
    }

    #[test]
    fn config_deserializes_frontend_shape() {
        // 与 config.ts 的 QuestionBankConfig 同构（camelCase 原样）
        let raw = r#"{
            "provider": "tizhuang",
            "credentials": {
                "tizhuang": { "baseUrl": "https://tizhuang.qcscience.cc/api", "accessKey": "" },
                "cn21": { "accessKey": "abc" }
            }
        }"#;

        let config: QuestionBankConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(config.provider.as_deref(), Some("tizhuang"));

        let creds = resolve_credentials(&config).unwrap();
        assert_eq!(creds.base_url, "https://tizhuang.qcscience.cc/api");
        // 空字符串 accessKey 必须归一为 None → 走匿名试用
        assert!(creds.license.is_none());

        // provider 未选中时必须明确报「未配置」而不是拿默认地址硬跑
        let none: QuestionBankConfig = serde_json::from_str(r#"{"provider":null}"#).unwrap();
        assert!(resolve_credentials(&none).is_err());

        // 选中的不是题庄时也要拒绝
        let other: QuestionBankConfig =
            serde_json::from_str(r#"{"provider":"cn21","credentials":{}}"#).unwrap();
        assert!(resolve_credentials(&other).is_err());
    }

    #[test]
    fn config_deserializes_with_non_empty_license() {
        let raw = r#"{
            "provider": "tizhuang",
            "credentials": { "tizhuang": { "baseUrl": "https://tizhuang.qcscience.cc/api", "accessKey": "  lic-123  " } }
        }"#;
        let config: QuestionBankConfig = serde_json::from_str(raw).unwrap();
        let creds = resolve_credentials(&config).unwrap();
        // License 必须 trim，否则请求头带空格会被服务端判无效
        assert_eq!(creds.license.as_deref(), Some("lic-123"));
    }

    #[test]
    fn config_missing_base_url_falls_back_to_default() {
        let raw = r#"{
            "provider": "tizhuang",
            "credentials": { "tizhuang": { "accessKey": "lic" } }
        }"#;
        let config: QuestionBankConfig = serde_json::from_str(raw).unwrap();
        let creds = resolve_credentials(&config).unwrap();
        assert_eq!(creds.base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn items_response_tolerates_missing_items_and_extra_fields() {
        // 服务端返回额外分页字段时不能反序列化失败
        let parsed: ItemsResponse =
            serde_json::from_str(r#"{"items":[],"total":0,"next_offset":null}"#).unwrap();
        assert!(parsed.items.is_empty());
        assert!(parsed.extra.contains_key("total"));

        // items 缺失也应容忍
        let parsed: ItemsResponse = serde_json::from_str(r#"{}"#).unwrap();
        assert!(parsed.items.is_empty());
    }

    #[test]
    fn question_deserializes_real_payload_field_names() {
        // 字段名严格取自实测返回（snake_case，与上游一致）
        let raw = serde_json::json!({
            "id": 37561799,
            "title": "计算 $\\frac{1}{2}+\\frac{1}{3}$",
            "title_html": "<p>计算</p>",
            "options": ["A", "B"],
            "options_html": "<p>A</p>",
            "answer": ["A"],
            "answer_html": "<p>A</p>",
            "analysis": "通分",
            "analysis_html": "<p>通分</p>",
            "question_type": "single_choice",
            "difficulty": 3,
            "subject_id": 2,
            "grade_id": 3,
            "knowledges": [{"id": 1, "name": "分数"}],
            "area": "北京",
            "year": 2024,
            "paper_type": "中考真题",
            "source": "某区一模",
            "is_auto_gradable": true,
            "content_hash": "abc123",
            "has_images": true,
            "image_urls": ["https://cdn.example.com/a.png"],
            "subquestions": [{"id": 1}]
        });

        let parsed: QuestionBankQuestion = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.id, Some(37561799));
        assert_eq!(parsed.question_type.as_deref(), Some("single_choice"));
        assert_eq!(parsed.is_auto_gradable, Some(true));
        assert_eq!(parsed.content_hash.as_deref(), Some("abc123"));
        assert_eq!(parsed.image_urls.as_ref().map(Vec::len), Some(1));
        assert!(parsed.subquestions.is_some());

        // 缺字段的题目也必须能反序列化（全 Option + default）
        let sparse: QuestionBankQuestion = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(sparse.id.is_none());
        assert!(sparse.title.is_none());
    }

    #[test]
    fn quota_response_tolerates_missing_trial_token() {
        // 实测 /v1/trial/quota 不返回 trial_token —— 结构体不能因此失败
        let raw = r#"{
            "expires_at": "2026-10-05T07:31:05",
            "question_limit": 100,
            "used": 3,
            "remaining": 97,
            "registered_daily_limit": 200
        }"#;
        let parsed: QuotaResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.used, Some(3));
        assert_eq!(parsed.remaining, Some(97));
        assert_eq!(parsed.question_limit, Some(100));
    }

    #[test]
    fn query_only_carries_setup_params_and_omits_blank_values() {
        let mut query: Vec<(String, String)> = Vec::new();
        push_num(&mut query, "subject_id", Some(2));
        push_param(&mut query, "keyword", Some("  分数  ".into()));
        push_param(&mut query, "paper_type", Some("   ".into()));
        push_param(&mut query, "question_type", None);
        push_bool(&mut query, "has_images", Some(true));
        push_bool(&mut query, "auto_gradable", Some(false));

        let keys: Vec<&str> = query.iter().map(|(k, _)| k.as_str()).collect();
        // 空白值必须被丢弃，否则会被服务端当成真实筛选条件
        assert_eq!(keys, vec!["subject_id", "keyword", "has_images", "auto_gradable"]);
        assert_eq!(query[1].1, "分数");
        assert_eq!(query[2].1, "true");
        assert_eq!(query[3].1, "false");

        // 凭据相关的键绝不能出现在 query 里
        for (key, _) in &query {
            assert!(!key.contains("key"));
            assert!(!key.contains("token"));
            assert!(!key.contains("license"));
        }
    }

    #[test]
    fn difficulty_is_clamped_to_server_contract() {
        let mut query: Vec<(String, String)> = Vec::new();
        push_num(
            &mut query,
            "difficulty_min",
            Some((-5i64).clamp(0, 5)),
        );
        push_num(&mut query, "difficulty_max", Some(99i64.clamp(0, 5)));
        assert_eq!(query[0].1, "0");
        assert_eq!(query[1].1, "5");
    }

    #[test]
    fn map_http_error_never_leaks_credentials() {
        // 429 → 额度耗尽提示
        let err = map_http_error(429, r#"{"detail":"quota exhausted"}"#, false);
        assert!(err.message.contains("额度"));

        // 401 → 认证提示，且不得回显请求头内容
        let err = map_http_error(401, "", false);
        assert!(!err.message.contains("X-API-Key"));
        assert!(!err.message.contains("trial"));

        // 5xx → 服务端错误，透传 detail（已截断）
        let err = map_http_error(500, r#"{"detail":"internal"}"#, false);
        assert!(err.message.contains("internal"));
    }
}
