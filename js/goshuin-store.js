/* ============================================================
   goshuin-store.js — 御朱印コレクションの保存・同期 (共有モジュール)

   localStorage を即時表示用キャッシュ兼オフラインフォールバックとし、
   サーバー(D1)を正とする。device_id (UUID) で匿名に紐付ける。

   記録は2種類を分離して管理する (Issue #1: 距離検証の迂回対策):
     - goshuin_collection : サーバーの距離検証 (POST /checkin) を通過した
                            確定済み記録のキャッシュ
     - goshuin_pending    : オフライン中に作成した未検証の保留記録。
                            チェックイン時点の座標を保持し、オンライン復帰後に
                            POST /checkin で位置検証してから確定へ昇格する。
                            検証を通らなかった保留記録は破棄する。
   index.html / map.html の両方から app.js / goshuin.js より先に読み込む。
   ============================================================ */

window.GoshuinStore = (() => {
  const API_BASE =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.protocol === "file:"
      ? "http://127.0.0.1:8787"
      : "https://shrine-api.inverted-triangle-leef.workers.dev";

  const KEY = "goshuin_collection"; // 確定済み (サーバー検証済み) キャッシュ
  const PENDING_KEY = "goshuin_pending"; // 未検証の保留記録
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
  function loadList(key) {
    try {
      const list = JSON.parse(localStorage.getItem(key));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function loadLocal() {
    return loadList(KEY);
  }

  function loadPending() {
    return loadList(PENDING_KEY);
  }

  function saveLocal(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function savePending(list) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  }

  // 確定済み・保留のどちらかにあれば「取得済み」扱い (重複チェックイン防止)
  function has(id) {
    return (
      loadLocal().some((g) => g.id === id) ||
      loadPending().some((g) => g.id === id)
    );
  }

  // 表示用: 確定済み + 保留 (pending:true 付き) を結合して返す
  function loadAll() {
    return [
      ...loadLocal(),
      ...loadPending().map((g) => ({ ...g, pending: true })),
    ];
  }

  /* ---------- サーバー同期 ---------- */
  function postCheckin(payload) {
    return fetch(`${API_BASE}/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function fetchAll() {
    const res = await fetch(
      `${API_BASE}/goshuin?device_id=${encodeURIComponent(getDeviceId())}`
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.results || [];
  }

  // 保留記録を1件ずつサーバーの距離検証 (POST /checkin) にかけ、確定へ昇格する。
  //   - 2xx               : 確定済みリストへ移動
  //   - 429 / 5xx / 通信断 : 保留のまま次回へ持ち越し (flushed:false で中断)
  //   - それ以外の 4xx     : 距離超過など検証不合格。保留から破棄し rejected に数える
  async function flushPending() {
    let pending = loadPending();
    let rejected = 0;
    for (const rec of [...pending]) {
      let res;
      try {
        res = await postCheckin({
          device_id: getDeviceId(),
          shrine_id: rec.id,
          lat: rec.lat,
          lon: rec.lon,
          accuracy: rec.accuracy != null ? rec.accuracy : undefined,
          checked_in_at: rec.date,
        });
      } catch {
        savePending(pending);
        return { rejected, flushed: false };
      }
      if (res.status === 429 || res.status >= 500) {
        savePending(pending);
        return { rejected, flushed: false };
      }
      if (res.ok) {
        saveRecordLocal(rec, rec.date);
      } else {
        rejected++;
        console.warn(
          `保留中の御朱印 (${rec.name || rec.id}) は位置検証を通過できず破棄されました`
        );
      }
      pending = pending.filter((g) => g.id !== rec.id);
    }
    savePending(pending);
    return { rejected, flushed: true };
  }

  // 保留記録の検証アップロード後、サーバーの内容を取得してローカルの
  // 確定済みキャッシュへマージ(和集合)する。失敗時はローカルのみ返す。
  // 戻り値: { list, synced, rejected }
  //   - list     : 確定済み + 残った保留 (pending:true 付き)
  //   - synced   : サーバーと同期できたか
  //   - rejected : 位置検証を通過できず破棄した保留記録の件数
  async function sync() {
    let synced = true;
    let rejected = 0;
    try {
      const flush = await flushPending();
      rejected = flush.rejected;
      if (!flush.flushed) synced = false;
      const server = await fetchAll();
      const merged = [...loadLocal()];
      const known = new Set(merged.map((g) => g.id));
      server.forEach((g) => {
        if (!known.has(g.id)) merged.push(g);
      });
      saveLocal(merged);
    } catch (e) {
      console.warn("御朱印のサーバー同期に失敗 (ローカルのみ表示):", e);
      synced = false;
    }
    return { list: loadAll(), synced, rejected };
  }

  /* ---------- チェックイン ---------- */
  // オフライン保留に使えるのは実測位置のみ。フォールバック位置 (app.js が
  // GPS失敗時にセットする東京駅座標, fallback:true) で保留すると復帰後の
  // 位置検証で必ず破棄され「成功演出→後から取り消し」になるため、先に断る。
  const OFFLINE_NO_POS_ERROR =
    "位置情報を取得できないため、オフラインでは記録できません。端末の位置情報の利用を許可してから再度お試しください";

  function isVerifiablePos(pos) {
    return !!pos && !pos.fallback;
  }

  function saveRecordLocal(shrine, date) {
    const list = loadLocal();
    if (list.some((g) => g.id === shrine.id)) return;
    list.push({
      id: shrine.id,
      name: shrine.name,
      prefecture: shrine.prefecture,
      type: shrine.type,
      date: date || new Date().toISOString().slice(0, 10),
    });
    saveLocal(list);
  }

  // オフライン時の保留記録。復帰後の位置検証に必要な座標を必ず持たせる。
  function savePendingRecord(shrine, pos) {
    const list = loadPending();
    if (list.some((g) => g.id === shrine.id)) return;
    list.push({
      id: shrine.id,
      name: shrine.name,
      prefecture: shrine.prefecture,
      type: shrine.type,
      date: new Date().toISOString().slice(0, 10),
      lat: pos.lat,
      lon: pos.lon,
      accuracy: pos.accuracy != null ? pos.accuracy : null,
    });
    savePending(list);
  }

  // チェックインの正式判定はサーバー (POST /checkin) が行う。
  // クライアント側の距離判定はボタン活性化などUI用の即時フィードバックに過ぎない。
  // 戻り値: { ok, offline?, error? }
  //   - サーバーが許可 → 確定済みとしてローカルにも保存し ok:true
  //   - サーバーが拒否 (距離超過など) → ローカル保存もしない ok:false
  //   - サーバー不達 (オフライン) → 座標付きの保留記録として保存し、
  //     オンライン復帰後の sync() で位置検証してから確定する ok:true, offline:true
  //     (座標が無い場合は後から検証できないため保留にもしない)
  async function checkin(shrine, pos) {
    if (has(shrine.id)) return { ok: false, error: "取得済みです" };
    // オフラインが明確なら無駄なリクエストをせず保留保存へ
    // (境内での電波不良を想定した救済。GPS測位は通信不要なので座標は取れる)
    if (navigator.onLine === false) {
      if (!isVerifiablePos(pos)) {
        return { ok: false, error: OFFLINE_NO_POS_ERROR };
      }
      savePendingRecord(shrine, pos);
      return { ok: true, offline: true };
    }
    try {
      const res = await postCheckin({
        device_id: getDeviceId(),
        shrine_id: shrine.id,
        lat: pos ? pos.lat : null,
        lon: pos ? pos.lon : null,
        accuracy: pos && pos.accuracy != null ? pos.accuracy : undefined,
      });
      if (res.ok) {
        saveRecordLocal(shrine);
        return { ok: true };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `API ${res.status}` };
    } catch (e) {
      console.warn("チェックインのサーバー送信に失敗 (オフライン保留扱い):", e);
      if (!isVerifiablePos(pos)) {
        return { ok: false, error: OFFLINE_NO_POS_ERROR };
      }
      savePendingRecord(shrine, pos);
      return { ok: true, offline: true };
    }
  }

  return { getDeviceId, loadLocal, loadAll, has, checkin, sync };
})();
