/* ============================================================
   app.js — 地図メイン (MapLibre + 近傍検索API)
   ============================================================ */

/* ---------- 設定 ---------- */
// 近傍検索 Worker の URL。
//  - ローカル確認時 : `wrangler dev` の http://127.0.0.1:8787
//  - 本番(GitHub Pages)時 : デプロイした Worker の URL に書き換える
const API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.protocol === "file:"
    ? "http://127.0.0.1:8787"
    : "https://shrine-api.inverted-triangle-leef.workers.dev"; // 本番 Worker

const SEARCH_RADIUS = 5000; // 周辺検索の半径[m]
const SEARCH_LIMIT = 100; // 取得上限
const CHECKIN_RADIUS = 100; // チェックイン可能距離[m]
const FALLBACK = { lat: 35.681, lon: 139.767 }; // GPS不可時のフォールバック(東京駅)

const ACCURACY_WARN_M = 50; // GPS精度がこれより悪ければ警告を表示
const POS_MAX_AGE_MS = 2 * 60 * 1000; // 位置情報の鮮度: 2分超は再取得してからチェックイン
const RESEARCH_MIN_MOVE_M = 2000; // 地図移動でこの距離以上ズレたら周辺を再検索

/* ---------- 御朱印ストレージ (goshuin-store.js に委譲) ---------- */
function hasGoshuin(id) {
  return GoshuinStore.has(id);
}

// 最後に取得した現在地 (POST /checkin のサーバー側距離検証に送る)
// { lat, lon, accuracy, ts } — ts は取得時刻で、鮮度判定に使う
let mePos = null;

/* ---------- GPS取得 ---------- */
function getPosition(maximumAge = 0) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy != null ? pos.coords.accuracy : null,
          ts: Date.now(),
        }),
      reject,
      { enableHighAccuracy: true, timeout: 8000, maximumAge }
    );
  });
}

// 取得した位置を反映し、精度が悪ければ警告する
function applyPosition(pos, fly) {
  mePos = pos;
  setMe(pos.lat, pos.lon);
  if (fly) map.flyTo({ center: [pos.lon, pos.lat], zoom: 15 });
  if (pos.accuracy != null && pos.accuracy > ACCURACY_WARN_M) {
    toast(`⚠️ 位置精度が低い可能性があります（±${Math.round(pos.accuracy)}m）`);
  }
}

// チェックイン用: 位置が未取得または古い (2分超) 場合は再取得してから返す
async function getFreshPosition() {
  if (mePos && Date.now() - mePos.ts <= POS_MAX_AGE_MS) return mePos;
  try {
    const pos = await getPosition();
    applyPosition(pos, false);
    return pos;
  } catch {
    return mePos; // 再取得失敗時は古い位置のまま (サーバー側判定に委ねる)
  }
}

// 起動時にサーバーと同期 (localStorage 消去後の復元・未送信分の再送)。
// 同期完了で「取得済み」判定が変わりうるが、ポップアップは開くたびに
// 再生成されるため表示は自然に追従する。
GoshuinStore.sync();

/* ---------- トースト ---------- */
let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

/* ---------- 地図初期化 ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [FALLBACK.lon, FALLBACK.lat],
  zoom: 14,
  // モバイルのピンチズームは地図領域内で有効 (MapLibre 既定値だが明示)。
  // ページ全体のズームは index.html の viewport (user-scalable=no) で
  // 意図的に止めており、地図操作とは競合しない。
  touchZoomRotate: true,
  doubleClickZoom: true,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

let shrineMarkers = [];

function clearMarkers() {
  shrineMarkers.forEach((m) => m.remove());
  shrineMarkers = [];
}

/* ---------- ポップアップ内容 (DOMで生成しボタンに直接ハンドラを付ける) ---------- */
function buildPopupContent(shrine) {
  const wrap = document.createElement("div");
  wrap.className = "popup";

  const typeLabel = shrine.type === "shrine" ? "神社" : "寺院";
  const near = shrine.distance_m <= CHECKIN_RADIUS;

  // OSM由来の name / prefecture は信頼できないため textContent で埋め込む(XSS対策)
  const ptype = document.createElement("div");
  ptype.className = "ptype";
  ptype.textContent = `${shrine.prefecture} ・ ${typeLabel}`;
  wrap.appendChild(ptype);

  const pname = document.createElement("div");
  pname.className = "pname";
  pname.textContent = shrine.name;
  wrap.appendChild(pname);

  const pdist = document.createElement("div");
  pdist.className = "pdist" + (near ? " near" : "");
  pdist.textContent = `📍 約 ${shrine.distance_m} m ${near ? "（境内エリア！）" : ""}`;
  wrap.appendChild(pdist);

  const btn = document.createElement("button");
  btn.className = "btn";

  function render() {
    if (hasGoshuin(shrine.id)) {
      btn.className = "btn btn-done";
      btn.textContent = "✅ 取得済み";
      btn.disabled = true;
    } else if (near) {
      btn.className = "btn btn-checkin";
      btn.textContent = "御朱印を授かる";
      btn.disabled = false;
    } else {
      btn.className = "btn btn-checkin";
      btn.textContent = `100m以内で解放（あと約${shrine.distance_m - CHECKIN_RADIUS}m）`;
      btn.disabled = true;
    }
  }
  render();

  // 正式なチェックイン判定はサーバー (POST /checkin) が距離検証込みで行う。
  // ボタンの活性化 (near 判定) はあくまでUI用の即時フィードバック。
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "確認中…";
    // 位置情報が古ければ再取得してから送る (鮮度対策)
    const pos = await getFreshPosition();
    const result = await GoshuinStore.checkin(shrine, pos);
    if (result.ok) {
      toast(
        result.offline
          ? `🎉 ${shrine.name} の御朱印を授かりました（オフラインのため端末に保存。オンライン復帰後に自動で同期されます）`
          : `🎉 ${shrine.name} の御朱印を授かりました！`
      );
    } else {
      toast(`⚠️ ${result.error}`);
    }
    render();
  });

  wrap.appendChild(btn);

  // 情報修正フィードバックを開くリンク
  const fb = document.createElement("button");
  fb.className = "popup-fb-link";
  fb.textContent = "✏️ 情報を修正する";
  fb.addEventListener("click", () => openFeedbackForm(shrine));
  wrap.appendChild(fb);

  return wrap;
}

/* ---------- ピン描画 ---------- */
function renderShrines(shrines) {
  clearMarkers();
  shrines.forEach((s) => {
    const el = document.createElement("div");
    el.className = "shrine-marker" + (s.type === "temple" ? " temple" : "");
    el.textContent = s.type === "shrine" ? "⛩️" : "🏯";

    const popup = new maplibregl.Popup({ offset: 20, closeButton: true }).setDOMContent(
      buildPopupContent(s)
    );

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([s.lon, s.lat])
      .setPopup(popup)
      .addTo(map);

    shrineMarkers.push(marker);
  });
}

/* ---------- 近傍検索API呼び出し ---------- */
async function fetchNearby(lat, lon) {
  const url = `${API_BASE}/nearby?lat=${lat}&lon=${lon}&radius=${SEARCH_RADIUS}&limit=${SEARCH_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

let lastSearch = null; // 最後に周辺検索した中心 (moveend 再検索の判定用)

async function loadAround(lat, lon) {
  lastSearch = { lat, lon };
  try {
    const shrines = await fetchNearby(lat, lon);
    renderShrines(shrines);
    if (shrines.length === 0) {
      toast("周辺に登録された社寺が見つかりませんでした");
    } else {
      toast(`周辺の社寺 ${shrines.length} 件を表示中`);
    }
  } catch (e) {
    toast("⚠️ 近傍APIに接続できません（wrangler dev / デプロイ先を確認）");
    console.error(e);
  }
}

// クライアント側の距離計算 (moveend 再検索の判定用。チェックイン判定はサーバー側)
function distanceM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/* ---------- フィードバックフォーム ---------- */
let fbEls = null; // モーダルのDOM参照(初回生成後キャッシュ)
let fbShrine = null; // 対象の社寺
let fbLocSeverity = ""; // 位置ズレの選択 "minor" | "major" | ""

function buildFeedbackModal() {
  const overlay = document.createElement("div");
  overlay.className = "fb-overlay";
  overlay.innerHTML = `
    <div class="fb-modal" role="dialog" aria-modal="true">
      <div class="fb-head">
        <span class="fb-title">情報を修正する</span>
        <button class="fb-close" aria-label="閉じる">×</button>
      </div>
      <div class="fb-target"></div>

      <label class="fb-label">神社・寺院名のズレ</label>
      <input type="text" class="fb-name" placeholder="正しい名前があれば入力" />

      <label class="fb-label">位置のズレ</label>
      <div class="fb-loc">
        <button type="button" class="fb-loc-btn" data-sev="minor">少しズレてる</button>
        <button type="button" class="fb-loc-btn" data-sev="major">大きくズレてる</button>
      </div>

      <label class="fb-check">
        <input type="checkbox" class="fb-notexist" />
        <span>この場所には存在しない</span>
      </label>

      <label class="fb-label">自由コメント</label>
      <textarea class="fb-comment" rows="3" placeholder="お気づきの点をご自由に"></textarea>

      <button class="btn btn-checkin fb-submit">送信する</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const els = {
    overlay,
    target: overlay.querySelector(".fb-target"),
    name: overlay.querySelector(".fb-name"),
    locBtns: overlay.querySelectorAll(".fb-loc-btn"),
    notexist: overlay.querySelector(".fb-notexist"),
    comment: overlay.querySelector(".fb-comment"),
    submit: overlay.querySelector(".fb-submit"),
    close: overlay.querySelector(".fb-close"),
  };

  els.close.addEventListener("click", closeFeedbackForm);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFeedbackForm();
  });
  els.locBtns.forEach((b) => {
    b.addEventListener("click", () => {
      const sev = b.dataset.sev;
      fbLocSeverity = fbLocSeverity === sev ? "" : sev; // トグル
      els.locBtns.forEach((x) =>
        x.classList.toggle("active", x.dataset.sev === fbLocSeverity)
      );
    });
  });
  els.submit.addEventListener("click", submitFeedback);

  return els;
}

function openFeedbackForm(shrine) {
  if (!fbEls) fbEls = buildFeedbackModal();
  fbShrine = shrine;
  fbLocSeverity = "";

  // リセット
  fbEls.name.value = "";
  fbEls.comment.value = "";
  fbEls.notexist.checked = false;
  fbEls.locBtns.forEach((x) => x.classList.remove("active"));
  fbEls.submit.disabled = false;
  fbEls.submit.textContent = "送信する";

  const typeLabel = shrine.type === "shrine" ? "神社" : "寺院";
  fbEls.target.textContent = `対象: ${shrine.name}（${shrine.prefecture}・${typeLabel}）`;
  fbEls.overlay.classList.add("show");
}

function closeFeedbackForm() {
  if (fbEls) fbEls.overlay.classList.remove("show");
  fbShrine = null;
}

async function submitFeedback() {
  if (!fbShrine) return;

  // フィードバックにはローカル保存の救済がないため、オフラインでは送信しない
  if (navigator.onLine === false) {
    toast("📡 オフラインです。接続を確認してから再度お試しください");
    return;
  }

  const nameFix = fbEls.name.value.trim();
  const freeComment = fbEls.comment.value.trim();
  const notExist = fbEls.notexist.checked;

  // issue_type を組み立て
  const issues = [];
  if (nameFix) issues.push("name_mismatch");
  if (fbLocSeverity === "minor") issues.push("location_minor");
  if (fbLocSeverity === "major") issues.push("location_major");
  if (notExist) issues.push("not_exist");

  if (issues.length === 0 && !freeComment) {
    toast("修正したい内容を入力してください");
    return;
  }

  // comment に名前修正候補も含めて保存(スキーマを変えない)
  const commentParts = [];
  if (nameFix) commentParts.push(`正しい名前候補: ${nameFix}`);
  if (freeComment) commentParts.push(freeComment);

  const payload = {
    shrine_id: fbShrine.id,
    shrine_name: fbShrine.name,
    issue_type: issues.join(",") || "comment_only",
    comment: commentParts.join(" / ") || null,
    lat: fbShrine.lat,
    lon: fbShrine.lon,
  };

  fbEls.submit.disabled = true;
  fbEls.submit.textContent = "送信中…";
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    closeFeedbackForm();
    toast("ありがとうございます！データ改善に役立てます");
  } catch (e) {
    console.error(e);
    fbEls.submit.disabled = false;
    fbEls.submit.textContent = "送信する";
    toast("⚠️ 送信に失敗しました。時間をおいて再度お試しください");
  }
}

/* ---------- 新規追加申請フォーム ----------
 * 地図に未登録の神社・寺院を申請する。既存の feedback と同じ
 * POST /feedback を issue_type: new_shrine / new_temple で使う。
 * 位置は自動取得 (現在地優先、取得不可なら地図中心) で手入力させない。 */
let nsEls = null; // モーダルのDOM参照(初回生成後キャッシュ)
let nsType = "shrine"; // 種別の選択 "shrine" | "temple"
let nsPos = null; // 申請位置 { lat, lon } (現在地 or 地図中心)
let nsOpenSeq = 0; // 開閉のたびに増やし、古い位置取得の結果を捨てる

function buildNewShrineModal() {
  const overlay = document.createElement("div");
  overlay.className = "fb-overlay";
  overlay.innerHTML = `
    <div class="fb-modal" role="dialog" aria-modal="true">
      <div class="fb-head">
        <span class="fb-title">神社・寺院の追加申請</span>
        <button class="fb-close" aria-label="閉じる">×</button>
      </div>
      <div class="ns-pos"></div>

      <label class="fb-label">種別</label>
      <div class="ns-type">
        <button type="button" class="ns-type-btn" data-type="shrine">⛩️ 神社</button>
        <button type="button" class="ns-type-btn" data-type="temple">🏯 寺院</button>
      </div>

      <label class="fb-label">名前（必須）</label>
      <input type="text" class="ns-name" placeholder="例: ○○神社" />

      <label class="fb-label">自由コメント</label>
      <textarea class="ns-comment" rows="3" placeholder="場所の目印などあればご自由に"></textarea>

      <button class="btn btn-checkin ns-submit">この場所で申請する</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const els = {
    overlay,
    pos: overlay.querySelector(".ns-pos"),
    typeBtns: overlay.querySelectorAll(".ns-type-btn"),
    name: overlay.querySelector(".ns-name"),
    comment: overlay.querySelector(".ns-comment"),
    submit: overlay.querySelector(".ns-submit"),
    close: overlay.querySelector(".fb-close"),
  };

  els.close.addEventListener("click", closeNewShrineForm);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeNewShrineForm();
  });
  els.typeBtns.forEach((b) => {
    b.addEventListener("click", () => {
      nsType = b.dataset.type;
      els.typeBtns.forEach((x) =>
        x.classList.toggle("active", x.dataset.type === nsType)
      );
    });
  });
  els.submit.addEventListener("click", submitNewShrine);

  return els;
}

async function openNewShrineForm() {
  if (!nsEls) nsEls = buildNewShrineModal();
  const seq = ++nsOpenSeq;

  // リセット (種別は神社を既定に)
  nsType = "shrine";
  nsEls.typeBtns.forEach((x) =>
    x.classList.toggle("active", x.dataset.type === "shrine")
  );
  nsEls.name.value = "";
  nsEls.comment.value = "";
  nsEls.submit.textContent = "この場所で申請する";

  // 位置は自動取得。取得完了まで送信は不可にする。
  nsPos = null;
  nsEls.submit.disabled = true;
  nsEls.pos.textContent = "📡 現在地を取得中…";
  nsEls.overlay.classList.add("show");

  const pos = await getFreshPosition();
  // 取得待ちの間に閉じて開き直した場合は古い結果を捨てる
  if (seq !== nsOpenSeq) return;
  if (pos) {
    nsPos = { lat: pos.lat, lon: pos.lon };
    nsEls.pos.textContent = "📍 現在地の位置で申請します（位置の入力は不要です）";
  } else {
    const c = map.getCenter();
    nsPos = { lat: c.lat, lon: c.lng };
    nsEls.pos.textContent =
      "📍 現在地を取得できないため、地図の中心位置で申請します";
  }
  nsEls.submit.disabled = false;
}

function closeNewShrineForm() {
  nsOpenSeq++;
  if (nsEls) nsEls.overlay.classList.remove("show");
}

async function submitNewShrine() {
  // フィードバックと同様にローカル保存の救済がないため、オフラインでは送信しない
  if (navigator.onLine === false) {
    toast("📡 オフラインです。接続を確認してから再度お試しください");
    return;
  }
  if (!nsPos) return; // 位置取得前 (ボタンは disabled のはずだが念のため)

  const name = nsEls.name.value.trim();
  if (!name) {
    toast("神社・寺院の名前を入力してください");
    return;
  }
  const comment = nsEls.comment.value.trim();

  const payload = {
    shrine_id: null,
    shrine_name: name,
    issue_type: nsType === "temple" ? "new_temple" : "new_shrine",
    comment: comment || null,
    lat: nsPos.lat,
    lon: nsPos.lon,
  };

  nsEls.submit.disabled = true;
  nsEls.submit.textContent = "送信中…";
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    closeNewShrineForm();
    toast("ありがとうございます！確認のうえ地図への追加を検討します");
  } catch (e) {
    console.error(e);
    nsEls.submit.disabled = false;
    nsEls.submit.textContent = "この場所で申請する";
    toast("⚠️ 送信に失敗しました。時間をおいて再度お試しください");
  }
}

/* ---------- 現在地マーカー ---------- */
let meMarker = null;
function setMe(lat, lon) {
  const el = document.createElement("div");
  el.className = "me-marker";
  if (meMarker) meMarker.remove();
  meMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
}

/* ---------- 現在地の再取得ボタン ---------- */
const locateBtn = document.createElement("button");
locateBtn.id = "locate-btn";
locateBtn.type = "button";
document.body.appendChild(locateBtn);

function setLocating(loading) {
  locateBtn.disabled = loading;
  locateBtn.textContent = loading ? "📡 現在地を取得中…" : "📍 現在地を再取得";
}
setLocating(false);

async function relocate() {
  setLocating(true);
  try {
    const pos = await getPosition(); // maximumAge=0: キャッシュを使わず取り直す
    applyPosition(pos, true);
    loadAround(pos.lat, pos.lon);
  } catch (e) {
    toast("⚠️ 現在地を取得できませんでした（位置情報の許可を確認してください）");
    console.error(e);
  } finally {
    setLocating(false);
  }
}
locateBtn.addEventListener("click", relocate);

/* ---------- 新規追加申請ボタン (index.html に常設) ---------- */
document
  .getElementById("add-shrine-btn")
  .addEventListener("click", openNewShrineForm);

/* ---------- オンライン/オフライン状態の案内 ----------
 * 常設バナーは offline-banner.js が担当。ここでは地図ページ固有の案内
 * (タイル読み込み・同期) をトーストで補足する。 */
window.addEventListener("offline", () => {
  toast("📡 オフラインのため新しい地図タイルや周辺検索が読み込めません（表示済みの地図は閲覧できます）");
});
window.addEventListener("online", () => {
  toast("📶 オンラインに復帰しました。未同期の御朱印を同期しています…");
  GoshuinStore.sync(); // オフライン中にローカル保存したチェックインを再送
});

/* ---------- 地図移動後の周辺再検索 ---------- */
map.on("moveend", () => {
  if (!lastSearch) return;
  const c = map.getCenter();
  if (distanceM(c.lat, c.lng, lastSearch.lat, lastSearch.lon) > RESEARCH_MIN_MOVE_M) {
    loadAround(c.lat, c.lng);
  }
});

/* ---------- 起動: GPS取得 → 地図中心 + 近傍読込 ---------- */
function start(pos, isReal) {
  applyPosition(pos, true);
  loadAround(pos.lat, pos.lon);
  if (!isReal) {
    toast("現在地を取得できないため東京駅周辺を表示しています");
  }
}

map.on("load", async () => {
  setLocating(true); // GPS取得中のローディング表示
  try {
    // 起動時は30秒以内のキャッシュ位置を許容して表示を早める
    const pos = await getPosition(30000);
    start(pos, true);
  } catch {
    start({ lat: FALLBACK.lat, lon: FALLBACK.lon, accuracy: null, ts: Date.now() }, false);
  } finally {
    setLocating(false);
  }
});
