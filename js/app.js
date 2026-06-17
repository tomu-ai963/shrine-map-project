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
      carto: {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
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

  wrap.innerHTML = `
    <div class="ptype">${shrine.prefecture} ・ ${typeLabel}</div>
    <div class="pname">${shrine.name}</div>
    <div class="pdist ${near ? "near" : ""}">📍 約 ${shrine.distance_m} m ${
    near ? "（境内エリア！）" : ""
  }</div>
  `;

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
