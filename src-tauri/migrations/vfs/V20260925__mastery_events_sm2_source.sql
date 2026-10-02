-- ============================================================================
-- V20260925: mastery_events.source CHECK 扩展——加入 'sm2' 源
-- ============================================================================
--
-- A2a「给 SM-2 补 mastery 回流」：题目的间隔重复复习评分（review_plans）
-- 需回写掌握度，把开环变闭环（docs 见 analysis/A2A_SM2_MASTERY_REFLUX.md）。
--
-- 为什么需要新源而不是复用 'qbank'：
--   qbank 事件代表「首次作答」，sm2 事件代表「间隔重复复习评分」。
--   A1 统一日程聚合与 A3 掌握度衰减需要区分这两类证据（复习通过 vs 再次答错
--   对掌握度的贡献权重不同），复用会导致该维度永久丢失。
--
-- SQLite 不支持 ALTER CHECK，采用 rename+recreate 模式（先例：V20260309、
-- V20260909）。必须完整保留后续迁移叠加的列与触发器：
--   - V20260719: signal REAL
--   - V20260720: device_id / local_version / updated_at / deleted_at
--     + 三个 __change_log 触发器 + 三个同步索引
--
-- outcome CHECK 保持不变（'correct'|'wrong'|'rating'）：
--   SM-2 quality 0-5 折合为 Rating(1..4) 写入，见 mastery/service.rs 的
--   sm2_quality_to_rating 映射函数。
--
-- 幂等性：重建全程 IF [NOT] EXISTS；拷贝用 INSERT OR IGNORE（id 为 PK）。
-- ============================================================================

-- 1. 建新表（source CHECK 加入 'sm2'）
CREATE TABLE IF NOT EXISTS mastery_events_new (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('qbank', 'fsrs', 'insight', 'sm2')),
    concept_key TEXT NOT NULL,
    item_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'wrong', 'rating')),
    weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0.0 AND weight <= 1.0),
    signal REAL,
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
);

-- 2. 拷贝数据
INSERT OR IGNORE INTO mastery_events_new
    (id, created_at, source, concept_key, item_id, outcome, weight, signal,
     device_id, local_version, updated_at, deleted_at)
SELECT id, created_at, source, concept_key, item_id, outcome, weight, signal,
       device_id, local_version, updated_at, deleted_at
FROM mastery_events;

-- 3. 换名
-- @danger-ack: drop_table reason="rename+recreate 重建模式（先例 V20260309/V20260909）：数据已先拷贝进 mastery_events_new，DROP 的是旧表，换名后数据完整；迁移在单事务内执行，失败整体回滚"
-- @danger-ack: table_rebuild reason="CHECK 约束扩展无法用 ALTER 完成，必须重建；INSERT OR IGNORE 按 PK 拷贝保证幂等，重建后索引与 change_log 触发器全部重建"
DROP TABLE IF EXISTS mastery_events;
ALTER TABLE mastery_events_new RENAME TO mastery_events;

-- 4. 重建索引（V20260718 两个 + V20260720 三个）
CREATE INDEX IF NOT EXISTS idx_mastery_events_concept_time
    ON mastery_events(concept_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mastery_events_item_time
    ON mastery_events(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mastery_events_local_version
    ON mastery_events(local_version);
CREATE INDEX IF NOT EXISTS idx_mastery_events_updated_at
    ON mastery_events(updated_at);
CREATE INDEX IF NOT EXISTS idx_mastery_events_device_version
    ON mastery_events(device_id, local_version);

-- 5. 重建 change_log 触发器（DROP TABLE 会连带删触发器，必须重建）
DROP TRIGGER IF EXISTS trg__change_log_mastery_events_insert;
CREATE TRIGGER trg__change_log_mastery_events_insert
AFTER INSERT ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', NEW.id, 'INSERT', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_mastery_events_update;
CREATE TRIGGER trg__change_log_mastery_events_update
AFTER UPDATE ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', NEW.id, 'UPDATE', datetime('now'));
END;

DROP TRIGGER IF EXISTS trg__change_log_mastery_events_delete;
CREATE TRIGGER trg__change_log_mastery_events_delete
AFTER DELETE ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', OLD.id, 'DELETE', datetime('now'));
END;
