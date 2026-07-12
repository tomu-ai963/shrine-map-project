"""
fetch_shrines.py

Overpass API から全国(まずは関東圏)の神社・寺院を取得し、
Cloudflare D1 にインポートできる SQL ファイル(shrines.sql)を出力するバッチ。

出力カラム: id, name, lat, lon, prefecture, type(shrine/temple)

著名度の代理スコア(wikidata/wikipedia/heritage 等のタグ)で県ごとに上位を採用する。

使い方:
    python fetch_shrines.py                # 全国47都道府県・各30件 (約1410件)
    python fetch_shrines.py --per 50       # 1県あたりの件数を変更
    python fetch_shrines.py --out jp.sql

D1 へのインポート:
    wrangler d1 execute <DB_NAME> --file=shrines.sql
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


def write_sql(records: list, out_path: str) -> None:
    """レコード一覧を D1 取り込み用の SQL ファイルに書き出す。"""
    batch_size = 200  # 複数行 INSERT をまとめる単位
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("DROP TABLE IF EXISTS shrines;\n")
        f.write(
            "CREATE TABLE shrines (\n"
            "  id TEXT PRIMARY KEY,\n"
            "  name TEXT NOT NULL,\n"
            "  lat REAL NOT NULL,\n"
            "  lon REAL NOT NULL,\n"
            "  prefecture TEXT,\n"
            "  type TEXT\n"
            ");\n\n"
        )

        for start in range(0, len(records), batch_size):
            chunk = records[start:start + batch_size]
            f.write(
                "INSERT INTO shrines (id,name,lat,lon,prefecture,type) VALUES\n"
            )
            rows = []
            for r in chunk:
                rows.append(
                    "('{id}','{name}',{lat},{lon},'{pref}','{type}')".format(
                        id=sql_escape(r["id"]),
                        name=sql_escape(r["name"]),
                        lat=r["lat"],
                        lon=r["lon"],
                        pref=sql_escape(r["prefecture"]),
                        type=r["type"],
                    )
                )
            f.write(",\n".join(rows))
            f.write(";\n\n")


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
    args = parser.parse_args()

    targets = [p.strip() for p in args.prefs.split(",") if p.strip()] or PREFECTURES

    records = []
    seen_ids = set()

    for pref in targets:
        print(f"[取得中] {pref} ...")
        elements = fetch_prefecture(pref)
        print(f"  -> {len(elements)} 件の素データを受信")

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

    write_sql(records, args.out)

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
