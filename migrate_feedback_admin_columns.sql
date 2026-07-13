-- feedback テーブルに運用管理用カラムを追加するマイグレーション。
-- 受け取ったフィードバックの対応状況を D1 上で直接管理できるようにする。
--
-- 適用手順:
--   ローカル: wrangler d1 execute shrines-db --local  --file migrate_feedback_admin_columns.sql
--   本番    : wrangler d1 execute shrines-db --remote --file migrate_feedback_admin_columns.sql
--   ※ 2回実行すると "duplicate column name" エラーになる (データは壊れない)
--   ※ これらのカラムはユーザー向けAPIレスポンスには含めない (運用者専用)
--
-- カラム:
--   status      … open / in_progress / resolved / wontfix 等の運用ステータス
--   resolved_at … 対応完了日時 (NULL許容)
--   admin_note  … 運用者向けメモ (NULL許容)
--
-- 運用例 (D1 に直接SQLを発行):
--   -- 未対応の一覧を確認
--   SELECT id, shrine_id, issue_type, comment, created_at
--     FROM feedback WHERE status = 'open' ORDER BY created_at;
--   -- 対応中に更新
--   UPDATE feedback SET status = 'in_progress', admin_note = '現地確認依頼中' WHERE id = 123;
--   -- 対応完了 (JST基準で日時を記録)
--   UPDATE feedback
--     SET status = 'resolved', resolved_at = datetime('now', '+9 hours')
--     WHERE id = 123;
--   -- エクスポート (Notion/スプレッドシート貼り付け用)
--   SELECT * FROM feedback ORDER BY created_at;

ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE feedback ADD COLUMN resolved_at TEXT;
ALTER TABLE feedback ADD COLUMN admin_note TEXT;
