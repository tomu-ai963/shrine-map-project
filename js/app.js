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

const GOSHUIN_KEY = "goshuin_collection";

/* ---------- 御朱印ストレージ ---------- */
function loadGoshuin() {
  try {
    return JSON.parse(localStorage.getItem(GOSHUIN_KEY)) || [];
  } catch {
    return [];
  }
}
function hasGoshuin(id) {
  return loadGoshuin().some((g) => g.id === id);
}
function addGoshuin(shrine) {
  const list = loadGoshuin();
  if (list.some((g) => g.id === shrine.id)) return false;
  list.push({
    id: shrine.id,
    name: shrine.name,
    prefecture: shrine.prefecture,
    type: shrine.type,
    date: new Date().toISOString().slice(0, 10),
  });
  localStorage.setItem(GOSHUIN_KEY, JSON.stringify(list));
  return true;
}

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

  btn.addEventListener("click", () => {
    if (addGoshuin(shrine)) {
      toast(`🎉 ${shrine.name} の御朱印を授かりました！`);
      render();
    }
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

async function loadAround(lat, lon) {
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

/* ---------- 現在地マーカー ---------- */
let meMarker = null;
function setMe(lat, lon) {
  const el = document.createElement("div");
  el.className = "me-marker";
  if (meMarker) meMarker.remove();
  meMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
}

/* ---------- 起動: GPS取得 → 地図中心 + 近傍読込 ---------- */
function start(lat, lon, isReal) {
  map.flyTo({ center: [lon, lat], zoom: 15 });
  setMe(lat, lon);
  loadAround(lat, lon);
  if (!isReal) {
    toast("現在地を取得できないため東京駅周辺を表示しています");
  }
}

map.on("load", () => {
  if (!navigator.geolocation) {
    start(FALLBACK.lat, FALLBACK.lon, false);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => start(pos.coords.latitude, pos.coords.longitude, true),
    () => start(FALLBACK.lat, FALLBACK.lon, false),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
});
