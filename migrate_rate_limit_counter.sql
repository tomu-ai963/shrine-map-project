-- レート制限を原子的カウンタ方式へ移行する (Issue #1 中優先度)。
--
-- 旧方式 (feedback_rate_limit / goshuin_rate_limit) の問題:
--   1) SELECT→INSERT の2段階が非原子的で、並列リクエストが同時に
--      SELECT を通過すると上限を突破できた
--   2) /checkin (旧 /goshuin) の制限キーがクライアントの自由に生成できる
--      device_id だった
--   3) 期限切れレコードの DELETE が書き込みリクエストのたびに走っていた
--
-- 新方式: (scope, ip, 固定ウィンドウ開始秒) をキーに UPSERT + RETURNING の
-- 1文で加算・判定する (src/index.js の isRateLimited)。キーは偽装できない
-- CF-Connecting-IP。掃除は Cron Trigger (scheduled) の定期バッチへ移動。
--
-- 適用手順 (旧Workerを壊さない順序で):
--   1) この CREATE 部分を本番D1へ適用
--      npx wrangler d1 execute shrines-db --remote --file=migrate_rate_limit_counter.sql
--   2) Worker をデプロイ (rate_limit_counter を使い始める)
--   3) 安定後、末尾のコメントアウトされた DROP 文を手動実行して旧テーブルを削除
--      (旧Worker稼働中に DROP すると旧コードがエラーになるため順序厳守)

CREATE TABLE IF NOT EXISTS rate_limit_counter (
  scope TEXT NOT NULL,           -- エンドポイント種別 ("feedback" | "checkin")
  ip TEXT NOT NULL,              -- クライアントIP (CF-Connecting-IP)
  window_start INTEGER NOT NULL, -- 固定ウィンドウの開始 unix秒
  n INTEGER NOT NULL,            -- ウィンドウ内のリクエスト数
  PRIMARY KEY (scope, ip, window_start)
);

-- scheduled の掃除 (window_start < cutoff) 用インデックス
CREATE INDEX IF NOT EXISTS idx_rate_limit_counter_window
  ON rate_limit_counter (window_start);

-- ▼ Workerデプロイ後の後片付け (手動実行。旧Worker稼働中は実行しないこと)
-- DROP TABLE IF EXISTS feedback_rate_limit;
-- DROP TABLE IF EXISTS goshuin_rate_limit;
