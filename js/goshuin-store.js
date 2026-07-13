/* ============================================================
   goshuin-store.js — 御朱印コレクションの保存・同期 (共有モジュール)

   localStorage を即時表示用キャッシュ兼オフラインフォールバックとし、
   サーバー(D1)を正とする。device_id (UUID) で匿名に紐付ける。
   index.html / goshuin.html の両方から app.js / goshuin.js より先に読み込む。
   ============================================================ */

window.GoshuinStore = (() => {
  const API_BASE =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.protocol === "file:"
      ? "http://127.0.0.1:8787"
      : "https://shrine-api.inverted-triangle-leef.workers.dev";

  const KEY = "goshuin_collection";
  const DEVICE_KEY = "goshuin_device_id";
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /* ---------- device_id ---------- */
  function generateUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // 古いブラウザ向けフォールバック (UUID v4)
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !UUID_RE.test(id)) {
      id = generateUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  /* ---------- localStorage (キャッシュ / オフラインフォールバック) ---------- */
  function loadLocal() {
    try {
      const list = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveLocal(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function has(id) {
    return loadLocal().some((g) => g.id === id);
  }

  /* ---------- サーバー同期 ---------- */
  // ローカルの全記録をサーバーへ一括アップロード。
  // サーバー側は (device_id, shrine_id) の重複を無視するため、
  // 初回移行にも失敗リトライにも同じ処理で対応できる。
  async function pushAll() {
    const list = loadLocal();
    if (list.length === 0) return;
    const res = await fetch(`${API_BASE}/goshuin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: getDeviceId(),
        records: list.map((g) => ({ shrine_id: g.id, checked_in_at: g.date })),
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
  }

  async function fetchAll() {
    const res = await fetch(
      `${API_BASE}/goshuin?device_id=${encodeURIComponent(getDeviceId())}`
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.results || [];
  }

  // ローカル→サーバーへ移行アップロード後、サーバーの内容を取得して
  // ローカルへマージ(和集合)する。失敗時はローカルのみ返す。
  async function sync() {
    try {
      await pushAll();
      const server = await fetchAll();
      const merged = [...loadLocal()];
      const known = new Set(merged.map((g) => g.id));
      server.forEach((g) => {
        if (!known.has(g.id)) merged.push(g);
      });
      saveLocal(merged);
      return { list: merged, synced: true };
    } catch (e) {
      console.warn("御朱印のサーバー同期に失敗 (ローカルのみ表示):", e);
      return { list: loadLocal(), synced: false };
    }
  }

  /* ---------- チェックイン ---------- */
  function saveRecordLocal(shrine) {
    const list = loadLocal();
    if (list.some((g) => g.id === shrine.id)) return;
    list.push({
      id: shrine.id,
      name: shrine.name,
      prefecture: shrine.prefecture,
      type: shrine.type,
      date: new Date().toISOString().slice(0, 10),
    });
    saveLocal(list);
  }

  // チェックインの正式判定はサーバー (POST /checkin) が行う。
  // クライアント側の距離判定はボタン活性化などUI用の即時フィードバックに過ぎない。
  // 戻り値: { ok, offline?, error? }
  //   - サーバーが許可 → ローカルにも保存して ok:true
  //   - サーバーが拒否 (距離超過など) → ローカル保存もしない ok:false
  //   - サーバー不達 (オフライン) → ローカルに保存し、次回 sync() の
  //     一括移行アップロードで再送する ok:true, offline:true
  async function checkin(shrine, pos) {
    if (has(shrine.id)) return { ok: false, error: "取得済みです" };
    // オフラインが明確なら無駄なリクエストをせず即ローカル保存へ
    // (境内での電波不良を想定した救済。オンライン復帰後の sync() で
    //  一括移行アップロードとしてサーバーへ再送される)
    if (navigator.onLine === false) {
      saveRecordLocal(shrine);
      return { ok: true, offline: true };
    }
    try {
      const res = await fetch(`${API_BASE}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: getDeviceId(),
          shrine_id: shrine.id,
          lat: pos ? pos.lat : null,
          lon: pos ? pos.lon : null,
          accuracy: pos && pos.accuracy != null ? pos.accuracy : undefined,
        }),
      });
      if (res.ok) {
        saveRecordLocal(shrine);
        return { ok: true };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `API ${res.status}` };
    } catch (e) {
      console.warn("チェックインのサーバー送信に失敗 (オフライン扱い):", e);
      saveRecordLocal(shrine);
      return { ok: true, offline: true };
    }
  }

  return { getDeviceId, loadLocal, has, checkin, sync };
})();
