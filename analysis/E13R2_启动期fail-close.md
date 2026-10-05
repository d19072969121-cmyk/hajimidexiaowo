# E13R2 启动期 fail-close 与「重启后消失」

**任务**：task-12 追加调查（Lead 指派）：验证启动期 `is_blocked("chat_v2")` 是否解释「重启后消失」
**仓库**：`/root/workspace/repos/deep-student` 分支 `diy/m1-build-baseline`
**方法**：纯静态读代码（遵守 ≤2min/命令、不能截屏识图）
**结论一句话**：**该路径机制真实、且确实能让错题本"重启后为空"，但它是 fail-close 安全闸门（防旧 schema 被新二进制写坏），不是数据丢失；且它有自愈路径、不会"永久卡死"。是否命中用户现场，需要在真机上看一个文件是否存在 —— 见 §5 判定方法。**

---

## 1. 机制全链（源码实证）

### 1.1 门控入口

`src-tauri/src/lib.rs:1305-1307`：

```rust
#[cfg(feature = "data_governance")]
let initialize_chat_v2 =
    !data_governance_init_failed && !startup_component_health.is_blocked("chat_v2");
```

**两个条件任一为真 → chat_v2 整个不初始化。**

### 1.2 谁会标记 blocked

`lib.rs:1103-1108`（迁移回滚失败分支）：

```rust
data_governance_init_failed = true;
for component in ["vfs", "mistakes", "chat_v2", "llm_usage"] {
    startup_component_health.mark_blocked(
        component,
        format!("迁移失败后已恢复旧版数据结构: {}", error_msg),
    );
}
```

`lib.rs:1115-1121`（迁移无法建立安全状态）：

```rust
data_governance_init_failed =
    crate::data_governance::should_force_maintenance_mode_on_init_failure(&e);
if data_governance_init_failed {
    for component in ["vfs", "mistakes", "chat_v2", "llm_usage"] { mark_blocked(...) }
} else {
    startup_component_health.mark_degraded("mistakes", error_msg.clone());   // 降级而非阻断
}
```

`is_blocked` 实现（`data_governance/mod.rs:95-101`）：遍历 `components`，命中 `status == Blocked` 即真。

### 1.3 未初始化的**直接后果**（决定性）

`lib.rs:1322` 是**唯一**注册 chat_v2 数据库状态的地方：

```rust
if initialize_chat_v2 {
    match crate::chat_v2::init_chat_v2(&active_app_data_dir) {
        Ok(chat_v2_db) => {
            app.manage(chat_v2_db_arc.clone());     // ← 仅此一处
```

→ 被 blocked 时 `initialize_chat_v2 == false`，**`ChatV2Database` 永远不会 `app.manage()`**。

于是所有 chat_v2 命令（含 `chat_v2_list_sessions`、`chat_v2_create_session`）在 Tauri 提取 `State<'_, Arc<ChatV2Database>>` 时**直接失败**。

**关键**：`manage_session.rs:502-542` 的 handler **没有任何** blocked/health 检查（已 grep 确认），它不返回空数组，而是**因状态缺失而报错**。

→ 前端 `useMistakeBook.ts:196-199` 走 `catch` 分支：`setError(...)` + `setEntries([])`。
→ 而 `ReviewHubPage.tsx:383-388` 有错误态渲染（`data-testid="review-hub-error"`），显示「错题本加载失败」。

**这修正了 Lead 的一处表述**：不是"返回空数组"，而是"命令报错 + 前端显示加载失败 + 列表空"。用户若只看列表为空、不细读错误条，观感就是"题消失了"。

### 1.4 `should_force_maintenance_mode_on_init_failure`（Lead 问的 Q1）

`data_governance/mod.rs:305-313`：

```rust
pub fn should_force_maintenance_mode_on_init_failure(err: &DataGovernanceError) -> bool {
    match err {
        DataGovernanceError::Migration(migration::MigrationError::VerificationFailed { reason, .. })
            => !reason.contains("Schema fingerprint drift detected"),
        _ => true,     // ← 其余一切错误都强制维护模式
    }
}
```

**回答 Q1**：默认语义是 **fail-close**（`_ => true`）。**唯一**的例外是「Schema fingerprint drift detected」这一种校验失败 → 只降级（`mark_degraded("mistakes")`），**不阻断 chat_v2**。

⚠️ 注意：该例外只对 `mistakes` 组件降级；`chat_v2` 不在降级名单里，所以**只要走到 `if` 分支就是全阻断**。

**会不会"表已存在"之类误判成迁移失败？** 不会 —— 判定入口是 `DataGovernanceError::Migration(VerificationFailed{..})`，即**迁移后的 schema 校验失败**，不是"表是否已存在"。幂等建表/已应用迁移不会产生该错误。**误判风险低。**

### 1.5 持久化与自愈（Lead 问的 Q2）

- **写**：`commands.rs:61-74` `persist_migration_error` → 写 `{app_data_dir}/.last_migration_error`（JSON：`{error, timestamp}`）。`:67-73` 写入失败仅 `warn`，不阻断。
- **清**：`commands.rs:77-82` `clear_migration_error` → 删除该文件。**唯一调用点**在 `lib.rs:963` —— **初始化成功分支**。
- **读**：`commands.rs:85` `read_persisted_migration_error`，仅被 `:798` / `:1123` 用于**向用户展示错误详情**（诊断面板），**不参与启动门控**。

**回答 Q2（是否永久卡住）**：**不会永久卡住，有自愈路径。**
理由：`startup_component_health` 每次启动都由 `initialize_with_report(&active_app_data_dir)`（`lib.rs:948`）**重新计算**，**不是**从 `.last_migration_error` 读回的。所以：

- 若失败是**瞬态**（如某次启动磁盘/锁竞争、迁移中途被中断）→ 下次启动迁移成功 → `clear_migration_error` 清掉错误文件 → chat_v2 正常初始化 → **错题本恢复**。
- 若失败是**确定性**的（旧 schema 确实无法被新二进制安全迁移）→ 每次启动复现同样错误 → **每次都 blocked**，表现为"重启多少次都一样空"。这才是"重启也回不来"的真正形态。

⚠️ 修正 Lead 的一处表述：Lead 说「迁移失败一旦记录，**每次启动都会复现**（fail-close 是持久的）」。**准确说法**：复现的原因是**迁移本身每次启动都会重跑并失败**，而不是"错误文件被读回导致"。错误文件只用于展示，清掉它也不会让启动成功。

---

## 2. Android 升级场景（Lead 问的 Q4）

- 用户从旧版 APK 升级到新版：`init_chat_v2` → `ChatV2Database::new` → `build_pool` 的 `with_init` 执行 schema 迁移（`database.rs:106-112`）。
- 若新版引入了未声明兼容的旧 schema 变更 → `initialize_with_report` 报 `VerificationFailed` → 命中 `_ => true` → **必然 blocked 一次**。
- **但这是设计意图**（`lib.rs:1100-1101` 注释原文）：
  > 「新二进制不能在未声明兼容的旧 schema 上继续业务写入。**保持应用可启动以便诊断/导出，但进入 fail-close 维护模式**」

  即：宁可拒绝服务，也不写坏用户数据。**这不是 bug，是安全设计。**

**失败概率**：取决于该版本是否声明了 schema 兼容性。正常发版（迁移脚本 + 兼容声明齐全）应为 0；只有「漏写迁移」或「版本回滚」（装了旧 APK 覆盖新 schema 的库）才会命中。

---

## 3. 结论：这条路径能否解释用户症状？

**判定：机制上「能」，但当前证据不足以认定它是本次用户现场的原因。证据强度：中。**

| 维度 | 判定 |
|---|---|
| 是否能让错题本"重启后为空" | ✅ **能**（§1.3：DB 未 manage → 命令报错 → entries 空） |
| 是否解释"重启"语义 | ✅ **能**（§1.5：确定性失败每次启动复现） |
| 是否属数据丢失 | ❌ **不是**（会话仍在 `chat_v2.db`，只是读不回来） |
| 是否永久不可恢复 | ❌ **不是**（§1.5：迁移成功即自愈；且可在设置→数据治理导出/诊断） |
| 是否是**本次**用户遇到的 | ⚠️ **未证实**（§5 给判定方法） |

**为什么不能直接认定**：
1. 若真是这条路径，用户会同时看到**错误提示**「错题本加载失败」（`ReviewHubPage.tsx:383-388`），而用户原话只说"没有缓存/消失了"，**没提到报错**；
2. 该路径是**全组件阻断**（vfs/mistakes/chat_v2/llm_usage 一起挂），症状应远不止错题本 —— 整个聊天都会不可用。用户只报了错题本，**症状范围不匹配**；
3. 用户措辞像是"拍完当时能看到、重启后没了"，而 fail-close 是**启动即全线不可用**，与"拍题过程正常"矛盾。

→ **倾向于：用户现场更可能是 §E13R 主报告的前端归属问题（`SIDEBAR_EXCLUDE_MODES` 漏 solver），而非启动期 fail-close。** 但两者可叠加，需真机数据区分。

---

## 4. 修复方向（不绕过 fail-close）

**原则：fail-close 本身正确，不改。** 要改的是"用户无法自救"和"失败不可见"。

1. **让失败可见且可自救（推荐，低风险）**
   现状：`data_governance` 已有诊断面板读 `read_persisted_migration_error`（`commands.rs:798/:1123`）。
   **建议**：在错题本空态/错误态中，若检测到 chat_v2 组件 blocked，直接给一键入口跳「设置 → 数据治理 → 诊断/恢复」，而不是只显示一句 `reviewHub.loadFailed`。
   —— 这是纯前端可发现性改进，**不触碰任何安全闸门**。

2. **区分致命与非致命（中风险，需产品决策）**
   现状 `_ => true` 一刀切。可考虑：仅对"会破坏数据一致性"的失败 fail-close；对"只读校验失败且可自动重建"的失败走 `mark_degraded`（已有该机制，`mark_degraded` 不下阻断）。
   ⚠️ **风险**：放宽条件必须由熟悉迁移语义的人评估，否则丧失 fail-close 的保护意义。**不建议本轮动。**

3. **加强迁移健壮性（根治方向）**
   为 Android 升级补齐 schema 兼容声明 / 迁移前自动备份，降低命中概率。属版本工程问题，超出本任务。

**本轮落地**：仅建议第 1 项中的前端提示（**未实施**，待 Lead 决策，因涉及 `ReviewHubPage.tsx` 与 overlay-auditor 的 task-13 区域可能重叠，**不擅自改**）。

---

## 5. 真机判定方法（一次命令区分两条路径）

在真机上查三个点即可判定：

1. **看错误文件是否存在**
   `{appDataDir}/.last_migration_error`
   - 存在 → 命中 fail-close 路径（§1）；同时读其 `error` 字段可得真实失败原因
   - 不存在 → **排除**该路径，回到再 E13R 主报告的前端归属问题

2. **查会话是否真在库里**（决定性）
   `sqlite3 chat_v2.db "SELECT id,mode,persist_status FROM chat_v2_sessions WHERE mode IN ('analysis','solver') ORDER BY updated_at DESC LIMIT 20;"`
   - 有行 → 数据没丢，是"读不回来/归类不一致"
   - 空 → 数据确实没写进去，需查拍题链路本身

3. **看 UI 有没有报错条**
   `data-testid="review-hub-error"` 是否出现
   - 出现 → 命令失败（支持 fail-close 路径）
   - 没出现且列表空 → 命令成功但筛选/归属问题（支持 E13R 主报告结论）

---

## 6. 证据强度自评

| 项 | 强度 | 依据 |
|---|---|---|
| `is_blocked` → chat_v2 不初始化 → DB 未 manage → 命令失败 | **高** | `lib.rs:1305-1307` + `:1322` 唯一注册点 + handler 无 blocked 检查 |
| 前端失败表现为 error 态而非静默空 | **高** | `useMistakeBook.ts:196-199` + `ReviewHubPage.tsx:383-388` |
| `should_force_maintenance_mode` 默认 fail-close | **高** | `mod.rs:305-313` 含单测佐证（`:319-340`） |
| 有自愈路径（非永久卡死） | **高** | health 每次由 `initialize_with_report` 重算（`lib.rs:948`）；`clear_migration_error` 在成功分支（`:963`） |
| 该路径 = 本次用户现场 | **未证实（倾向否定）** | §3 三条反证：无报错描述、症状范围不匹配、拍题过程正常 |

**未验证项（诚实标注）**：
- 未在真机跑过 `initialize_with_report` 失败，未见过 `.last_migration_error` 实体文件；
- 「命令在 State 缺失时的具体报错文本」是从 Tauri 语义推断（`State` 提取失败），**未实测**该字符串；
- 无 `chat_v2.db` 实例可供查库（本机 `find` 为空）。

---

## 7. 本轮改动

- `analysis/E13R2_启动期fail-close.md`（本报告）
- **生产代码：未改动**（fail-close 是安全闸门，§4 建议均需 Lead/产品决策；且 §4.1 涉及与 task-13 可能重叠的 UI 文件，不擅自改）
