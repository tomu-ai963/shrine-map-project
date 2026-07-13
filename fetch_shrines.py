"""
fetch_shrines.py

Overpass API から全国(まずは関東圏)の神社・寺院を取得し、
Cloudflare D1 にインポートできる SQL ファイル(shrines.sql)を出力するバッチ。

出力カラム: id, name, lat, lon, prefecture, type(shrine/temple), is_active

id は OSM element の type + id 由来 (例: n123456, w789, r42) の安定キーで、
再インポートしても変わらない。goshuin_collection / feedback が shrine_id と
して参照しているため、この採番規則を変更してはならない。

再インポートは DROP TABLE ではなく UPSERT (INSERT ... ON CONFLICT(id) DO UPDATE)
で行い、今回の取得結果に含まれなくなった社寺は is_active=0 の論理削除にする。
これによりユーザーデータ (御朱印・フィードバック) の参照先レコードは消えない。

著名度の代理スコア(wikidata/wikipedia/heritage 等のタグ)で県ごとに上位を採用する。

使い方:
    python fetch_shrines.py                # 全国47都道府県・各30件 (約1410件)
    python fetch_shrines.py --per 50       # 1県あたりの件数を変更
    python fetch_shrines.py --out jp.sql
    python fetch_shrines.py --force        # 前回比の件数減少ガードを無視

D1 へのインポート:
    wrangler d1 execute <DB_NAME> --file=shrines.sql
    (既存DBに is_active カラムが無い場合は先に migrate_shrines_is_active.sql を適用)
"""

import argparse
import re
import sys
import time

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Overpass は User-Agent 無しのリクエストを 406 で弾くため明示する
HTTP_HEADERS = {
    "User-Agent": "shrine-map-project/1.0 (Overpass batch; contact: inverted.triangle.leef@gmail.com)",
}

# 取得対象の都道府県(全国47)。admin_level=4 でエリア検索する。
PREFECTURES = [
    "北海道",
    "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県",
    "沖縄県",
]

# religion タグ -> アプリ内の type へのマッピング
RELIGION_TO_TYPE = {
    "shinto": "shrine",
    "buddhist": "temple",
}

# name に HTML タグ片や制御文字を含むレコードは XSS の温床になるため除外する
SUSPICIOUS_NAME_RE = re.compile(r"[<>\x00-\x1f\x7f]")
MAX_NAME_LEN = 100  # 正常な社寺名としてあり得ない長さは除外

DEFAULT_PER_PREFECTURE = 30  # 1県あたりの採用件数 (×47 ≒ 1410件)
REQUEST_TIMEOUT = 90        # 1リクエストのタイムアウト(秒)
SLEEP_BETWEEN = 3           # 県ごとのリクエスト間隔(秒, API負荷対策)
MAX_RETRIES = 3


def build_query(prefecture: str) -> str:
    """指定した都道府県エリア内の神社・寺院を取得する Overpass QL を組み立てる。"""
    return f"""
[out:json][timeout:{REQUEST_TIMEOUT}];
area["name"="{prefecture}"]["admin_level"="4"]->.a;
(
  nwr["amenity"="place_of_worship"]["religion"="shinto"](area.a);
  nwr["amenity"="place_of_worship"]["religion"="buddhist"](area.a);
);
out center tags;
""".strip()


def fetch_prefecture(prefecture: str) -> list:
    """1都道府県分の elements を Overpass から取得して返す。失敗時はリトライ。"""
    query = build_query(prefecture)
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers=HTTP_HEADERS,
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json().get("elements", [])
        except (requests.RequestException, ValueError) as e:
            last_err = e
            wait = SLEEP_BETWEEN * attempt
            print(
                f"  ! {prefecture} の取得に失敗 (試行 {attempt}/{MAX_RETRIES}): {e} "
                f"-> {wait}秒待って再試行",
                file=sys.stderr,
            )
            time.sleep(wait)
    print(f"  !! {prefecture} は取得できませんでした: {last_err}", file=sys.stderr)
    return []


def notability_score(tags: dict) -> int:
    """著名度の代理スコア。著名な社寺ほど Wikipedia/Wikidata 等のタグが付く傾向。"""
    score = 0
    if tags.get("wikidata"):
        score += 3
    if tags.get("wikipedia"):
        score += 3
    if tags.get("heritage"):          # 文化財・登録有形文化財など
        score += 2
    if tags.get("website") or tags.get("contact:website"):
        score += 1
    if tags.get("name:en"):           # 多言語対応されている = 観光地化
        score += 1
    if tags.get("tourism"):
        score += 1
    return score


def element_to_record(el: dict, prefecture: str) -> dict | None:
    """Overpass の element 1件を出力レコードに変換する。除外対象なら None。"""
    tags = el.get("tags", {})
    name = (tags.get("name") or "").strip()
    if not name:
        return None  # 名前なしは地図に出せないので除外
    if len(name) > MAX_NAME_LEN or SUSPICIOUS_NAME_RE.search(name):
        return None  # HTMLタグ片・制御文字・異常な長さの名前は除外(XSS対策)

    religion = tags.get("religion")
    rec_type = RELIGION_TO_TYPE.get(religion)
    if rec_type is None:
        return None  # shinto / buddhist 以外は対象外

    # node は lat/lon を直接持つ。way/relation は out center の center を使う。
    if "lat" in el and "lon" in el:
        lat, lon = el["lat"], el["lon"]
    elif "center" in el:
        lat, lon = el["center"]["lat"], el["center"]["lon"]
    else:
        return None  # 座標が取れないものは除外

    osm_type = el.get("type", "")
    osm_id = el.get("id")
    # type+id で一意なIDにする (例: n123456, w789, r42)
    rec_id = f"{osm_type[:1]}{osm_id}"

    return {
        "id": rec_id,
        "name": name,
        "lat": lat,
        "lon": lon,
        "prefecture": prefecture,
        "type": rec_type,
        "score": notability_score(tags),
    }


def sql_escape(value: str) -> str:
    """SQL 文字列リテラル用に ' を '' へエスケープする。"""
    return value.replace("'", "''")


def write_sql(records: list, out_path: str, fetched_prefs: list) -> None:
    """レコード一覧を D1 取り込み用の UPSERT SQL ファイルに書き出す。

    - DROP TABLE は使わない。既存レコードは id (OSM由来の安定キー) で更新し、
      goshuin_collection / feedback からの shrine_id 参照を壊さない。
    - fetched_prefs (取得に成功した都道府県) について、今回の結果に含まれない
      レコードを is_active=0 の論理削除にする。取得に失敗した県は触らない
      (通信失敗で県全体を誤って論理削除しないための安全策)。
    """
    batch_size = 200  # 複数行 INSERT をまとめる単位
    by_pref = {}
    for r in records:
        by_pref.setdefault(r["prefecture"], []).append(r)

    with open(out_path, "w", encoding="utf-8") as f:
        # 先頭行の record_count は次回実行時の件数減少ガードが読み取る
        f.write(f"-- record_count: {len(records)}\n")
        f.write("-- fetch_shrines.py が生成した UPSERT 形式のインポートSQL。\n")
        f.write("-- 既存テーブルを DROP せず、含まれない社寺は is_active=0 で論理削除する。\n\n")
        f.write(
            "CREATE TABLE IF NOT EXISTS shrines (\n"
            "  id TEXT PRIMARY KEY,\n"
            "  name TEXT NOT NULL,\n"
            "  lat REAL NOT NULL,\n"
            "  lon REAL NOT NULL,\n"
            "  prefecture TEXT,\n"
            "  type TEXT,\n"
            "  is_active INTEGER NOT NULL DEFAULT 1\n"
            ");\n\n"
        )

        for start in range(0, len(records), batch_size):
            chunk = records[start:start + batch_size]
            f.write(
                "INSERT INTO shrines (id,name,lat,lon,prefecture,type,is_active) VALUES\n"
            )
            rows = []
            for r in chunk:
                rows.append(
                    "('{id}','{name}',{lat},{lon},'{pref}','{type}',1)".format(
                        id=sql_escape(r["id"]),
                        name=sql_escape(r["name"]),
                        lat=r["lat"],
                        lon=r["lon"],
                        pref=sql_escape(r["prefecture"]),
                        type=r["type"],
                    )
                )
            f.write(",\n".join(rows))
            f.write(
                "\nON CONFLICT(id) DO UPDATE SET\n"
                "  name = excluded.name,\n"
                "  lat = excluded.lat,\n"
                "  lon = excluded.lon,\n"
                "  prefecture = excluded.prefecture,\n"
                "  type = excluded.type,\n"
                "  is_active = 1;\n\n"
            )

        # 論理削除: 取得に成功した県のうち、今回の結果に含まれないレコードを無効化
        f.write("-- OSM側で見つからなくなった社寺の論理削除 (取得成功県のみ対象)\n")
        for pref in fetched_prefs:
            pref_records = by_pref.get(pref, [])
            if not pref_records:
                # 取得は成功したが採用0件 → 全件論理削除は危険なのでスキップ
                continue
            ids = ",".join(f"'{sql_escape(r['id'])}'" for r in pref_records)
            f.write(
                f"UPDATE shrines SET is_active = 0 "
                f"WHERE prefecture = '{sql_escape(pref)}' AND id NOT IN ({ids});\n"
            )


def read_prev_record_count(path: str) -> int | None:
    """前回出力した SQL ファイルの先頭コメントから件数を読み取る (無ければ None)。"""
    try:
        with open(path, encoding="utf-8") as f:
            m = re.match(r"-- record_count: (\d+)", f.readline())
            return int(m.group(1)) if m else None
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Overpass API から神社・寺院を取得し D1 用 SQL を出力する"
    )
    parser.add_argument(
        "--per",
        type=int,
        default=DEFAULT_PER_PREFECTURE,
        help=f"1県あたりの採用件数 (デフォルト: {DEFAULT_PER_PREFECTURE})",
    )
    parser.add_argument(
        "--out",
        default="shrines.sql",
        help="出力する SQL ファイル名 (デフォルト: shrines.sql)",
    )
    parser.add_argument(
        "--prefs",
        default="",
        help="取得対象の都道府県をカンマ区切りで指定 (省略時は全国47)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="前回出力より件数が大きく減っていても確認なしで出力する",
    )
    args = parser.parse_args()

    targets = [p.strip() for p in args.prefs.split(",") if p.strip()] or PREFECTURES

    records = []
    seen_ids = set()
    fetched_prefs = []  # 取得に成功した県 (論理削除の対象範囲)

    for pref in targets:
        print(f"[取得中] {pref} ...")
        elements = fetch_prefecture(pref)
        print(f"  -> {len(elements)} 件の素データを受信")
        if elements:
            fetched_prefs.append(pref)
        else:
            # 取得失敗県を論理削除の対象にすると県全体が消えるため除外する
            print(f"  ! {pref} は取得失敗のため論理削除の対象から除外します", file=sys.stderr)

        # 県内候補を整形・重複除去してから著名度スコアで上位 N 件を採用
        candidates = []
        seen_dedup = set()  # (name, 丸めた座標) で県内重複除去
        for el in elements:
            rec = element_to_record(el, pref)
            if rec is None:
                continue
            if rec["id"] in seen_ids:
                continue
            dedup_key = (rec["name"], round(rec["lat"], 5), round(rec["lon"], 5))
            if dedup_key in seen_dedup:
                continue
            seen_dedup.add(dedup_key)
            candidates.append(rec)

        # スコア降順 → 同点は名前順で安定ソートし、上位 N 件を採用
        candidates.sort(key=lambda r: (-r["score"], r["name"]))
        chosen = candidates[:args.per]
        for rec in chosen:
            seen_ids.add(rec["id"])
        records.extend(chosen)

        print(f"  -> 候補 {len(candidates)} 件中 {len(chosen)} 件採用 (累計 {len(records)} 件)")
        time.sleep(SLEEP_BETWEEN)

    if not records:
        print("有効なデータが取得できませんでした。", file=sys.stderr)
        sys.exit(1)

    # 件数減少ガード: 前回出力の90%を下回る場合は誤って大量に論理削除
    # してしまう恐れがあるため、--force なしでは出力しない
    prev_count = read_prev_record_count(args.out)
    if prev_count and len(records) < prev_count * 0.9 and not args.force:
        print(
            f"!! 中止: 取得件数 {len(records)} 件が前回 ({prev_count} 件) の90%を下回っています。\n"
            f"   Overpass の取得失敗などで意図せず大量の社寺が論理削除される恐れがあります。\n"
            f"   この件数で問題なければ --force を付けて再実行してください。",
            file=sys.stderr,
        )
        sys.exit(1)

    write_sql(records, args.out, fetched_prefs)

    # 内訳サマリ
    n_shrine = sum(1 for r in records if r["type"] == "shrine")
    n_temple = sum(1 for r in records if r["type"] == "temple")
    print()
    print(f"✅ {args.out} を出力しました（合計 {len(records)} 件）")
    print(f"   - shrine(神社): {n_shrine} 件")
    print(f"   - temple(寺院): {n_temple} 件")
    print()
    print("D1 へのインポート例:")
    print(f"   wrangler d1 execute <DB_NAME> --file={args.out}")


if __name__ == "__main__":
    main()
