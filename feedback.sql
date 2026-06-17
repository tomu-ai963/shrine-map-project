-- ユーザーからのデータ修正フィードバックを保存するテーブル。
-- shrines テーブルとは独立 (既存データは消さない)。
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shrine_id TEXT,
  shrine_name TEXT,
  issue_type TEXT,
  comment TEXT,
  lat REAL,
  lon REAL,
  created_at TEXT
);
