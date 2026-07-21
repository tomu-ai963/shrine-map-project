-- 御朱印コレクションのサーバー側永続化テーブル。
-- 認証機構がまだ無いため、匿名の device_id (UUID) に紐付ける。
-- 将来の会員機能追加時は user_id を埋めて device_id から移行できるようにしておく。
CREATE TABLE IF NOT EXISTS goshuin_collection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  user_id TEXT,                 -- 将来の会員機能用 (現状は常に NULL)
  shrine_id TEXT NOT NULL,
  checked_in_at TEXT NOT NULL,  -- チェックイン日 (YYYY-MM-DD, JST。過去30日以内の申告のみ受理し、それ以外は本日で補完)
  created_at TEXT NOT NULL,     -- サーバー受理日時 (UTC)
  UNIQUE (device_id, shrine_id) -- 同一デバイスの同一社寺は重複登録しない
);
CREATE INDEX IF NOT EXISTS idx_goshuin_device
  ON goshuin_collection (device_id);

-- POST /checkin の device_id ベース簡易レート制限用。
-- feedback_rate_limit と同じ方式 (キーと unix秒 を記録し直近ウィンドウ内の件数で判定)。
CREATE TABLE IF NOT EXISTS goshuin_rate_limit (
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goshuin_rate_limit_device_ts
  ON goshuin_rate_limit (device_id, ts);
