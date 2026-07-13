# legacy/

現行構成（GitHub Pages + Cloudflare Workers + D1）へ移行する前の旧プロトタイプ置き場。
本番では一切使用していない。参照用に保管。

- `shrine_app.py` — Streamlit製の初期プロトタイプ。
  ローカルの `shrines_data.csv` と SQLite (`my_goshuin.db`) を使う単一スクリプトで、
  現行の Workers API (`src/index.js`) やフロントエンド (`js/`) とは無関係。
