-- ============================================================
-- sirube-ams-checker / スキーマ定義
-- system_code: sys_ops_ams_checker
--
-- 設計方針:
--   properties     = 物件マスタ（変わりにくい素性。将来の物件マスタの「種」）
--   status_checks  = 突合結果（巡回のたび増える観測ログ。差分ストア）
--   2テーブルは object_id で繋がる。
--   judgment に pending を持たせ「未対応媒体も可視化」を表現する。
-- ============================================================

-- 判定区分（突合結果）
DO $$ BEGIN
  CREATE TYPE judgment_t AS ENUM (
    'match',      -- AMSと媒体が一致
    'mismatch',   -- 明確に食い違う（ふれんず等で判定可能な場合）
    'vanished',   -- 媒体から掲載が消えた（AMS公開中だが要確認）
    'not_found',  -- リンク先が開けない/該当なし
    'error',      -- 取得失敗
    'pending'     -- アダプタ未実装の媒体（未対応として記録・可視化）
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 人間の承認状態
DO $$ BEGIN
  CREATE TYPE review_t AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- properties : 物件マスタ（種）
-- ============================================================
CREATE TABLE IF NOT EXISTS properties (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     TEXT        NOT NULL DEFAULT 'sirube_office',
  object_id     TEXT        NOT NULL,                 -- AMS物件ID（業務キー）
  media         TEXT        NOT NULL,                 -- freins/suumo/athome/homes/other/none
  media_url     TEXT,                                 -- 元情報URL
  freins_id     TEXT,                                 -- ふれんずID（freinsのみ）
  ams_status    TEXT,                                 -- 最後に観測したAMSステータス
  ams_price_raw TEXT,                                 -- AMS一覧から読んだ価格原文
  ams_price     BIGINT,                               -- AMS価格（円、正規化）
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT        NOT NULL DEFAULT 'active', -- active / gone（巡回で消えた）
  system_code   TEXT        NOT NULL DEFAULT 'sys_ops_ams_checker',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_properties_tenant_object UNIQUE (tenant_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_properties_media   ON properties (media);
CREATE INDEX IF NOT EXISTS idx_properties_freins  ON properties (freins_id);
CREATE INDEX IF NOT EXISTS idx_properties_status  ON properties (status);

-- ============================================================
-- status_checks : 突合結果（差分ストア・履歴）
-- ============================================================
CREATE TABLE IF NOT EXISTS status_checks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     TEXT        NOT NULL DEFAULT 'sirube_office',
  object_id     TEXT        NOT NULL,                 -- properties.object_id 参照
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- この突合の実行時刻
  ams_status    TEXT,                                 -- そのときのAMS側
  media         TEXT,                                 -- 突合した媒体
  media_status  TEXT,                                 -- 媒体側で観測した状態（取れなければnull）
  judgment      judgment_t  NOT NULL DEFAULT 'pending',
  review_status review_t    NOT NULL DEFAULT 'pending',
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  note          TEXT,                                 -- 自動メモ・特記
  run_id        TEXT,                                 -- 1回の巡回をまとめるID（バッチ識別）
  system_code   TEXT        NOT NULL DEFAULT 'sys_ops_ams_checker',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checks_object    ON status_checks (object_id);
CREATE INDEX IF NOT EXISTS idx_checks_judgment  ON status_checks (judgment);
CREATE INDEX IF NOT EXISTS idx_checks_review    ON status_checks (review_status);
CREATE INDEX IF NOT EXISTS idx_checks_run       ON status_checks (run_id);

-- ============================================================
-- 差分抽出ビュー：最新の突合で「要確認」な物件だけを出す
-- （Phase 0 の目的＝差分のある物件を抽出する、を1クエリで実現）
-- ============================================================
CREATE OR REPLACE VIEW v_latest_diffs AS
WITH latest AS (
  SELECT DISTINCT ON (object_id) *
  FROM status_checks
  ORDER BY object_id, checked_at DESC
)
SELECT
  l.object_id,
  p.media,
  p.media_url,
  p.freins_id,
  l.ams_status,
  l.media_status,
  l.judgment,
  l.review_status,
  l.checked_at,
  l.note
FROM latest l
LEFT JOIN properties p ON p.object_id = l.object_id
WHERE l.judgment IN ('mismatch', 'vanished', 'not_found', 'error')
ORDER BY l.checked_at DESC;
