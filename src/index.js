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
 *   POST /checkin  : チェックイン (サーバー側で現在地と社寺の距離を検証して保存)
 *   POST /goshuin  : localStorage 既存データの一括移行専用 (records[] 必須)
 *   GET /goshuin?device_id=xxx : device_id に紐づく御朱印コレクションの取得
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

function isAllowedOrigin(origin) {
  return !!origin && (origin === FRONTEND_ORIGIN || LOCAL_DEV_ORIGIN_RE.test(origin));
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allow = isAllowedOrigin(origin) ? origin : FRONTEND_ORIGIN;
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

/* ---------- /goshuin のバリデーション設定 ---------- */
// device_id は UUID v4 形式のみ許可 (crypto.randomUUID() で発行される)
const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// checked_in_at は YYYY-MM-DD のみ許可 (それ以外はサーバー日付で補完)
const CHECKED_IN_AT_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GOSHUIN_RECORDS = 500; // 一括移行1リクエストあたりの上限件数
const GOSHUIN_RATE_MAX = 10; // 同一 device_id のウィンドウ内最大リクエスト数
const GOSHUIN_RATE_WINDOW_S = 60;

/* ---------- /checkin のバリデーション設定 ---------- */
const CHECKIN_RADIUS_M = 100; // チェックイン可能距離 (クライアントUIの閾値と同値)
// 日本国内のおおよその範囲。これを外れる座標は偽装か取得失敗として拒否する。
const JAPAN_BBOX = { minLat: 20, maxLat: 46, minLon: 122, maxLon: 154 };
const MAX_ACCURACY_M = 1000; // これより精度が悪い測位ではチェックインを拒否
const ACCURACY_WARN_M = 500; // これより悪い精度は警告付きで受理
// GPS精度が悪い分だけ距離判定を緩和する (accuracy の半分、ただし上限あり)。
// 上限を設けるのは「accuracy を大きく申告するほど遠くからチェックインできる」
// という不正の余地を広げないため。最大でも 100 + 100 = 200m まで。
const ACCURACY_ALLOWANCE_RATIO = 0.5;
const ACCURACY_ALLOWANCE_MAX_M = 100;

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

  // is_active=0 は再インポートで OSM 側から消えた社寺 (論理削除)。地図には出さない。
  let sql =
    "SELECT id, name, lat, lon, prefecture, type FROM shrines " +
    "WHERE is_active = 1 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
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
    "SELECT COUNT(*) AS total, SUM(is_active) AS active FROM shrines"
  ).first();
  return json(
    {
      status: "ok",
      shrines: row ? row.active || 0 : 0, // 地図に表示される有効件数
      total: row ? row.total : 0, // 論理削除を含む全件数
    },
    200,
    cors
  );
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

/**
 * device_id ベースの簡易レート制限 (/goshuin 用)。
 * feedback の isRateLimited と同方式で goshuin_rate_limit テーブルを使う。
 */
async function isGoshuinRateLimited(env, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - GOSHUIN_RATE_WINDOW_S;

  await env.DB.prepare("DELETE FROM goshuin_rate_limit WHERE ts < ?")
    .bind(windowStart)
    .run();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM goshuin_rate_limit WHERE device_id = ? AND ts >= ?"
  )
    .bind(deviceId, windowStart)
    .first();
  if (row && row.n >= GOSHUIN_RATE_MAX) return true;

  await env.DB.prepare(
    "INSERT INTO goshuin_rate_limit (device_id, ts) VALUES (?, ?)"
  )
    .bind(deviceId, now)
    .run();
  return false;
}

/**
 * POST /checkin — サーバー側で距離を検証するチェックイン。
 * body: { device_id, shrine_id, lat, lon, accuracy? }
 * shrines テーブルの正式な座標との Haversine 距離が CHECKIN_RADIUS_M 以内の
 * 場合のみ goshuin_collection へ保存する。座標偽装でUI判定を回避しても、
 * 送信座標が社寺から離れていればここで拒否される。
 */
async function handleCheckin(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const deviceId =
    typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!DEVICE_ID_RE.test(deviceId)) {
    return json({ error: "device_id が不正です (UUID形式のみ)" }, 400, cors);
  }

  if (await isGoshuinRateLimited(env, deviceId)) {
    return json(
      { error: "リクエストが多すぎます。しばらく待ってから再度お試しください" },
      429,
      cors
    );
  }

  const shrineId =
    typeof body.shrine_id === "string" || typeof body.shrine_id === "number"
      ? String(body.shrine_id).trim()
      : "";
  if (!shrineId || shrineId.length > MAX_SHRINE_ID_LEN) {
    return json({ error: "shrine_id が不正です" }, 400, cors);
  }

  // 座標: 数値かつ日本国内のおおよその範囲のみ受け付ける
  const lat = typeof body.lat === "number" ? body.lat : NaN;
  const lon = typeof body.lon === "number" ? body.lon : NaN;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < JAPAN_BBOX.minLat ||
    lat > JAPAN_BBOX.maxLat ||
    lon < JAPAN_BBOX.minLon ||
    lon > JAPAN_BBOX.maxLon
  ) {
    return json({ error: "lat / lon が不正です (日本国内の座標のみ)" }, 400, cors);
  }

  // accuracy: 任意。数値でない・負の値は拒否。
  let accuracy = null;
  if (body.accuracy != null) {
    if (
      typeof body.accuracy !== "number" ||
      !Number.isFinite(body.accuracy) ||
      body.accuracy < 0
    ) {
      return json({ error: "accuracy が不正です" }, 400, cors);
    }
    accuracy = body.accuracy;
  }
  // 極端に精度が悪い測位は位置の信頼性がないため拒否 (再取得を促す)
  if (accuracy != null && accuracy > MAX_ACCURACY_M) {
    return json(
      {
        error: `GPS精度が悪すぎます (±${Math.round(accuracy)}m)。位置情報を再取得してからお試しください`,
      },
      403,
      cors
    );
  }

  // 論理削除済み (is_active=0) の社寺は地図に出ないため新規チェックイン不可
  const shrine = await env.DB.prepare(
    "SELECT id, name, lat, lon FROM shrines WHERE id = ? AND is_active = 1"
  )
    .bind(shrineId)
    .first();
  if (!shrine) {
    return json({ error: "存在しない shrine_id です" }, 400, cors);
  }

  // サーバー側の距離判定 (ここが本体)。
  // GPS精度が悪い分は閾値を緩和するが、上限付き (最大 200m) にして
  // accuracy の過大申告による遠隔チェックインを防ぐ。
  const allowance =
    accuracy != null
      ? Math.min(accuracy * ACCURACY_ALLOWANCE_RATIO, ACCURACY_ALLOWANCE_MAX_M)
      : 0;
  const threshold = Math.round(CHECKIN_RADIUS_M + allowance);
  const distance = Math.round(haversine(lat, lon, shrine.lat, shrine.lon));
  if (distance > threshold) {
    return json(
      {
        error: `社寺から離れすぎています (約${distance}m / ${threshold}m以内で可能)`,
        distance_m: distance,
        threshold_m: threshold,
      },
      403,
      cors
    );
  }

  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO goshuin_collection " +
      "(device_id, shrine_id, checked_in_at, created_at) " +
      "VALUES (?, ?, date('now', '+9 hours'), datetime('now'))" // チェックイン日はJST基準
  )
    .bind(deviceId, shrineId)
    .run();
  const inserted = result.meta ? result.meta.changes : 0;

  return json(
    {
      ok: true,
      inserted, // 0 なら既に取得済み
      distance_m: distance,
      // 精度が極端に悪い場合は警告のみ (閾値への加味は次のP1で扱う)
      warning:
        accuracy != null && accuracy > ACCURACY_WARN_M
          ? `GPS精度が低いため位置が不正確な可能性があります (±${Math.round(accuracy)}m)`
          : undefined,
    },
    201,
    cors
  );
}

/**
 * POST /goshuin — localStorage 既存データの一括移行専用。
 * body: { device_id, records: [{shrine_id, checked_in_at?}] }
 * 新規チェックインは距離検証付きの POST /checkin を使うこと。
 * (移行データは過去のチェックインのため位置検証はできない)
 * 同一 (device_id, shrine_id) は UNIQUE 制約 + INSERT OR IGNORE で重複登録しない。
 */
async function handleGoshuinPost(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const deviceId =
    typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!DEVICE_ID_RE.test(deviceId)) {
    return json({ error: "device_id が不正です (UUID形式のみ)" }, 400, cors);
  }

  if (await isGoshuinRateLimited(env, deviceId)) {
    return json(
      { error: "リクエストが多すぎます。しばらく待ってから再度お試しください" },
      429,
      cors
    );
  }

  // 一括移行専用: records 配列のみ受け付ける (単発チェックインは /checkin へ)
  const records = body.records;
  if (!Array.isArray(records)) {
    return json(
      { error: "records (配列) が必要です。新規チェックインは POST /checkin を使ってください" },
      400,
      cors
    );
  }
  if (records.length === 0) {
    return json({ error: "records が空です" }, 400, cors);
  }
  if (records.length > MAX_GOSHUIN_RECORDS) {
    return json(
      { error: `records は${MAX_GOSHUIN_RECORDS}件以内にしてください` },
      400,
      cors
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const normalized = [];
  for (const r of records) {
    const shrineId =
      r && (typeof r.shrine_id === "string" || typeof r.shrine_id === "number")
        ? String(r.shrine_id).trim()
        : "";
    if (!shrineId || shrineId.length > MAX_SHRINE_ID_LEN) {
      return json({ error: "shrine_id が不正です" }, 400, cors);
    }
    const checkedInAt =
      typeof r.checked_in_at === "string" && CHECKED_IN_AT_RE.test(r.checked_in_at)
        ? r.checked_in_at
        : today;
    normalized.push({ shrineId, checkedInAt });
  }

  // 全 shrine_id が shrines テーブルに実在するか確認してから書き込む
  const uniqueIds = [...new Set(normalized.map((r) => r.shrineId))];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const { results: found } = await env.DB.prepare(
    `SELECT id FROM shrines WHERE id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all();
  if (found.length !== uniqueIds.length) {
    const foundSet = new Set(found.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !foundSet.has(id));
    return json({ error: "存在しない shrine_id です", missing }, 400, cors);
  }

  // INSERT OR IGNORE で重複 (device_id, shrine_id) は黙ってスキップ
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO goshuin_collection " +
      "(device_id, shrine_id, checked_in_at, created_at) " +
      "VALUES (?, ?, ?, datetime('now'))"
  );
  const batchResults = await env.DB.batch(
    normalized.map((r) => stmt.bind(deviceId, r.shrineId, r.checkedInAt))
  );
  const inserted = batchResults.reduce(
    (n, r) => n + (r.meta ? r.meta.changes : 0),
    0
  );

  return json(
    { ok: true, received: normalized.length, inserted },
    201,
    cors
  );
}

/**
 * GET /goshuin?device_id=xxx — device_id に紐づくコレクションを取得。
 * 表示に必要な社寺情報 (name, prefecture, type) を shrines と JOIN して返す。
 */
async function handleGoshuinGet(url, env, cors) {
  const deviceId = (url.searchParams.get("device_id") || "").trim();
  if (!DEVICE_ID_RE.test(deviceId)) {
    return json({ error: "device_id が不正です (UUID形式のみ)" }, 400, cors);
  }

  const { results } = await env.DB.prepare(
    "SELECT g.shrine_id AS id, g.checked_in_at AS date, " +
      "s.name, s.prefecture, s.type " +
      "FROM goshuin_collection g " +
      "JOIN shrines s ON s.id = g.shrine_id " +
      "WHERE g.device_id = ? " +
      "ORDER BY g.checked_in_at, g.id"
  )
    .bind(deviceId)
    .all();

  return json({ count: results.length, results }, 200, cors);
}

/* ---------- ルーティング & CORS 一覧 ----------
 * 全エンドポイントの CORS 方針をここで一元管理する。
 * エンドポイントを追加するときは、この表に1行足すだけでよい。
 *
 * - CORS ヘッダー (corsHeaders) は全ルート共通: Allow-Origin は
 *   本番フロント (FRONTEND_ORIGIN) とローカル開発用 localhost のみ。
 * - access: "write" のルートは加えて、許可外の Origin ヘッダーを持つ
 *   リクエスト自体を 403 で拒否する (CORSヘッダーだけでは処理自体は
 *   実行されてしまうため)。Origin ヘッダーの無いリクエスト (curl 等) は
 *   ブラウザ経由でないため対象外 — それらへの防御は各ハンドラの
 *   バリデーション・距離検証・レート制限が担う。
 * - access: "read" は公開データの読み取り。CORSヘッダーの限定のみ。
 */
const ROUTES = [
  { method: "GET",  path: "/nearby",   access: "read",  handler: (req, url, env, cors) => handleNearby(url, env, cors) },
  { method: "GET",  path: "/health",   access: "read",  handler: (req, url, env, cors) => handleHealth(env, cors) },
  { method: "GET",  path: "/goshuin",  access: "read",  handler: (req, url, env, cors) => handleGoshuinGet(url, env, cors) },
  { method: "POST", path: "/feedback", access: "write", handler: (req, url, env, cors) => handleFeedback(req, env, cors) },
  { method: "POST", path: "/checkin",  access: "write", handler: (req, url, env, cors) => handleCheckin(req, env, cors) },
  { method: "POST", path: "/goshuin",  access: "write", handler: (req, url, env, cors) => handleGoshuinPost(req, env, cors) },
];

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
      const route = ROUTES.find(
        (r) => r.path === url.pathname && r.method === request.method
      );
      if (!route) {
        return json(
          {
            error: "Not found",
            endpoints: ROUTES.map((r) => `${r.method} ${r.path}`),
          },
          404,
          cors
        );
      }

      // 書き込み系: 許可外 Origin からのブラウザリクエストを拒否
      if (route.access === "write") {
        const origin = request.headers.get("Origin");
        if (origin && !isAllowedOrigin(origin)) {
          return json({ error: "origin not allowed" }, 403, cors);
        }
      }

      return await route.handler(request, url, env, cors);
    } catch (err) {
      return json({ error: "internal error", detail: String(err) }, 500, cors);
    }
  },
};
