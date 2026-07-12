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
 *   POST /feedback : データ修正フィードバックの登録
 *
 * D1(SQLite)には空間インデックスが無いため、
 *   1) 緯度経度のバウンディングボックスで SQL 側を粗く絞り込み
 *   2) JS 側で正確な大円距離(Haversine)を計算して半径内のみ採用・距離昇順ソート
 * の2段構えで近傍検索する。
 */

const EARTH_RADIUS_M = 6371000;
const DEG_LAT_M = 111320; // 緯度1度あたりの距離[m](ほぼ一定)

/* ---------- CORS ----------
 * Allow-Origin はフロントエンド(GitHub Pages)に限定する。
 * ローカル開発時のみ localhost / 127.0.0.1 の HTTP オリジンを許可する。
 * (file:// 直開きは Origin が "null" になるため対象外。ローカル確認は
 *  `python -m http.server` 等の簡易サーバー経由で行うこと)
 */
const FRONTEND_ORIGIN = "https://tomu-ai963.github.io";
const LOCAL_DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allow =
    origin && (origin === FRONTEND_ORIGIN || LOCAL_DEV_ORIGIN_RE.test(origin))
      ? origin
      : FRONTEND_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

/* ---------- /feedback のバリデーション設定 ---------- */
// フロントエンド(app.js)が送る issue_type の許可リスト。カンマ区切りで複数指定可。
const ALLOWED_ISSUE_TYPES = new Set([
  "name_mismatch",
  "location_minor",
  "location_major",
  "not_exist",
  "comment_only",
]);
const MAX_SHRINE_ID_LEN = 64;
const MAX_SHRINE_NAME_LEN = 200;
const MAX_ISSUE_TYPE_LEN = 100;
const MAX_COMMENT_LEN = 1000;

// IPベースの簡易レート制限 (D1 に直近リクエスト時刻を記録)
const RATE_LIMIT_MAX = 5; // ウィンドウ内の最大リクエスト数
const RATE_LIMIT_WINDOW_S = 60; // ウィンドウ幅[秒]

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors,
    },
  });
}

async function handleNearby(url, env, cors) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return json({ error: "lat と lon は必須の数値です" }, 400, cors);
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

  return json(
    {
      count: Math.min(withDist.length, limit),
      radius_m: radius,
      origin: { lat, lon },
      results: withDist.slice(0, limit),
    },
    200,
    cors
  );
}

async function handleHealth(env, cors) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shrines"
  ).first();
  return json({ status: "ok", shrines: row ? row.n : 0 }, 200, cors);
}

/**
 * IPベースの簡易レート制限。
 * feedback_rate_limit テーブルに (ip, unix秒) を記録し、
 * 直近ウィンドウ内のリクエスト数が上限を超えていれば true を返す。
 */
async function isRateLimited(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW_S;

  // 期限切れレコードの掃除(テーブルの肥大化防止)
  await env.DB.prepare("DELETE FROM feedback_rate_limit WHERE ts < ?")
    .bind(windowStart)
    .run();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM feedback_rate_limit WHERE ip = ? AND ts >= ?"
  )
    .bind(ip, windowStart)
    .first();
  if (row && row.n >= RATE_LIMIT_MAX) return true;

  await env.DB.prepare("INSERT INTO feedback_rate_limit (ip, ts) VALUES (?, ?)")
    .bind(ip, now)
    .run();
  return false;
}

async function handleFeedback(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await isRateLimited(env, ip)) {
    return json(
      { error: "リクエストが多すぎます。しばらく待ってから再度お試しください" },
      429,
      cors
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  // shrine_id: 必須。長さ上限を超えるものは拒否。
  const shrineId =
    typeof body.shrine_id === "string" || typeof body.shrine_id === "number"
      ? String(body.shrine_id).trim()
      : "";
  if (!shrineId || shrineId.length > MAX_SHRINE_ID_LEN) {
    return json({ error: "shrine_id が不正です" }, 400, cors);
  }

  // issue_type: 必須。カンマ区切りの各値が許可リストに含まれること。
  const issueType = typeof body.issue_type === "string" ? body.issue_type : "";
  if (!issueType || issueType.length > MAX_ISSUE_TYPE_LEN) {
    return json({ error: "issue_type が不正です" }, 400, cors);
  }
  const issueTokens = issueType.split(",");
  if (issueTokens.some((t) => !ALLOWED_ISSUE_TYPES.has(t))) {
    return json(
      {
        error: "issue_type に許可されていない値が含まれています",
        allowed: [...ALLOWED_ISSUE_TYPES],
      },
      400,
      cors
    );
  }

  // 任意フィールド: 長さ上限を超えるものは拒否。
  const shrineName = body.shrine_name != null ? String(body.shrine_name) : null;
  if (shrineName && shrineName.length > MAX_SHRINE_NAME_LEN) {
    return json({ error: `shrine_name は${MAX_SHRINE_NAME_LEN}文字以内にしてください` }, 400, cors);
  }
  const comment = body.comment != null ? String(body.comment) : null;
  if (comment && comment.length > MAX_COMMENT_LEN) {
    return json({ error: `comment は${MAX_COMMENT_LEN}文字以内にしてください` }, 400, cors);
  }

  // 座標: 数値かつ妥当な範囲のみ受け付ける(それ以外は null)
  const lat =
    typeof body.lat === "number" && body.lat >= -90 && body.lat <= 90
      ? body.lat
      : null;
  const lon =
    typeof body.lon === "number" && body.lon >= -180 && body.lon <= 180
      ? body.lon
      : null;

  // shrine_id が shrines テーブルに実在するか確認してから書き込む
  const shrine = await env.DB.prepare("SELECT id FROM shrines WHERE id = ?")
    .bind(shrineId)
    .first();
  if (!shrine) {
    return json({ error: "存在しない shrine_id です" }, 400, cors);
  }

  const result = await env.DB.prepare(
    "INSERT INTO feedback (shrine_id, shrine_name, issue_type, comment, lat, lon, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
  )
    .bind(shrineId, shrineName, issueType, comment, lat, lon)
    .run();

  return json(
    { ok: true, id: result.meta ? result.meta.last_row_id : null },
    201,
    cors
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // CORS プリフライト (204 はボディ不可なので空ボディで返す)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      if (url.pathname === "/nearby") {
        return await handleNearby(url, env, cors);
      }
      if (url.pathname === "/health") {
        return await handleHealth(env, cors);
      }
      if (url.pathname === "/feedback" && request.method === "POST") {
        return await handleFeedback(request, env, cors);
      }
      return json(
        { error: "Not found", endpoints: ["/nearby", "/health", "POST /feedback"] },
        404,
        cors
      );
    } catch (err) {
      return json({ error: "internal error", detail: String(err) }, 500, cors);
    }
  },
};
