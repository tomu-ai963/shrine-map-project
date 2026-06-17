/**
 * Shrine nearby-search API (Cloudflare Worker + D1)
 *
 * エンドポイント:
 *   GET /nearby?lat=35.68&lon=139.69&radius=2000&limit=50&type=shrine
 *     - lat, lon : 現在地 (必須)
 *     - radius   : 検索半径 [m] (任意, 既定 3000, 最大 50000)
 *     - limit    : 最大件数 (任意, 既定 50, 最大 200)
 *     - type     : shrine | temple で絞り込み (任意)
 *   GET /health  : 稼働確認 (件数を返す)
 *
 * D1(SQLite)には空間インデックスが無いため、
 *   1) 緯度経度のバウンディングボックスで SQL 側を粗く絞り込み
 *   2) JS 側で正確な大円距離(Haversine)を計算して半径内のみ採用・距離昇順ソート
 * の2段構えで近傍検索する。
 */

const EARTH_RADIUS_M = 6371000;
const DEG_LAT_M = 111320; // 緯度1度あたりの距離[m](ほぼ一定)

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // GitHub Pages のフロントから叩けるよう CORS を許可
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function handleNearby(url, env) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return json({ error: "lat と lon は必須の数値です" }, 400);
  }

  let radius = parseFloat(url.searchParams.get("radius")) || 3000;
  radius = Math.min(Math.max(radius, 1), 50000);

  let limit = parseInt(url.searchParams.get("limit"), 10) || 50;
  limit = Math.min(Math.max(limit, 1), 200);

  const type = url.searchParams.get("type"); // shrine | temple | null

  // バウンディングボックス算出
  const dLat = radius / DEG_LAT_M;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // 高緯度で cos が 0 に近づくと範囲が発散するため下限を設ける
  const dLon = radius / (DEG_LAT_M * Math.max(cosLat, 0.01));

  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLon = lon - dLon;
  const maxLon = lon + dLon;

  let sql =
    "SELECT id, name, lat, lon, prefecture, type FROM shrines " +
    "WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
  const bind = [minLat, maxLat, minLon, maxLon];
  if (type === "shrine" || type === "temple") {
    sql += " AND type = ?";
    bind.push(type);
  }
  // ボックス内候補に上限を設けて読み込み過多を防ぐ
  sql += " LIMIT 1000";

  const { results } = await env.DB.prepare(sql).bind(...bind).all();

  const withDist = [];
  for (const r of results) {
    const dist = haversine(lat, lon, r.lat, r.lon);
    if (dist <= radius) {
      withDist.push({ ...r, distance_m: Math.round(dist) });
    }
  }
  withDist.sort((a, b) => a.distance_m - b.distance_m);

  return json({
    count: Math.min(withDist.length, limit),
    radius_m: radius,
    origin: { lat, lon },
    results: withDist.slice(0, limit),
  });
}

async function handleHealth(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shrines"
  ).first();
  return json({ status: "ok", shrines: row ? row.n : 0 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({}, 204);
    }

    try {
      if (url.pathname === "/nearby") {
        return await handleNearby(url, env);
      }
      if (url.pathname === "/health") {
        return await handleHealth(env);
      }
      return json({ error: "Not found", endpoints: ["/nearby", "/health"] }, 404);
    } catch (err) {
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },
};
