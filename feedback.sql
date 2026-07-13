-- ユーザーからのデータ修正フィードバックを保存するテーブル。
-- shrines テーブルとは独立 (既存データは消さない)。
--
-- status / resolved_at / admin_note は運用管理用のカラム。
-- ユーザー向けAPI (POST /feedback のレスポンス) には含めず、
-- 運用者が D1 に直接SQLを発行してステータス管理・エクスポートに使う。
-- 既存DBへは migrate_feedback_admin_columns.sql で後から追加する。
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shrine_id TEXT,
  shrine_name TEXT,
  issue_type TEXT,
  comment TEXT,
  lat REAL,
  lon REAL,
  created_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open / in_progress / resolved / wontfix 等
  resolved_at TEXT,                     -- 対応完了日時 (NULL許容)
  admin_note TEXT                       -- 運用者向けメモ (NULL許容)
);

-- POST /feedback のIPベース簡易レート制限用。
-- ip と unix秒 を記録し、直近ウィンドウ内の件数で判定する。
-- 期限切れレコードは Worker 側でリクエスト毎に削除される。
CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip_ts
  ON feedback_rate_limit (ip, ts);
