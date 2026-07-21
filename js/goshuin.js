/* ============================================================
   goshuin.js — 御朱印帳ページ (サーバー同期 + localStorage フォールバック)

   表示手順:
     1) localStorage のキャッシュを即時表示
     2) GoshuinStore.sync() でローカル→サーバー移行 + サーバーから取得
     3) マージ結果で再描画 (オフライン時はローカルのまま)
   ============================================================ */

function render(list, notice) {
  const root = document.getElementById("goshuin-list");

  if (list.length === 0) {
    root.innerHTML = `
      <div class="goshuin-empty">
        まだ御朱印がありません。<br />
        <a href="map.html">地図</a> から社寺を訪れて授かりましょう。
      </div>`;
    return;
  }

  // 新しい順
  list = [...list].reverse();

  const grid = document.createElement("div");
  grid.className = "goshuin-grid";

  list.forEach((g) => {
    const card = document.createElement("div");
    card.className = "goshuin-card" + (g.pending ? " goshuin-pending" : "");
    card.setAttribute("data-seal", g.type === "shrine" ? "神社" : "寺院");

    // OSM由来の name / prefecture は信頼できないため textContent で埋め込む(XSS対策)
    const icon = document.createElement("div");
    icon.className = "g-icon";
    icon.textContent = g.type === "shrine" ? "⛩️" : "🏯";

    const name = document.createElement("div");
    name.className = "g-name";
    name.textContent = g.name;

    const meta = document.createElement("div");
    meta.className = "g-meta";
    meta.append(
      document.createTextNode(g.prefecture || ""),
      document.createElement("br"),
      // pending はオフライン取得の未検証記録。オンライン復帰後の
      // 位置検証 (sync) で確定するまで「確認待ち」と示す。
      document.createTextNode((g.date || "") + (g.pending ? "（確認待ち）" : ""))
    );

    card.append(icon, name, meta);
    grid.appendChild(card);
  });

  root.innerHTML = "";
  root.appendChild(grid);

  if (notice) {
    const note = document.createElement("p");
    note.className = "goshuin-notice";
    note.textContent = notice;
    root.appendChild(note);
  }
}

async function init() {
  // 1) キャッシュを即時表示 (確定済み + 保留)
  render(GoshuinStore.loadAll());

  // 2) サーバー同期 (保留分の位置検証を含む) → 3) マージ結果で再描画
  const { list, synced, rejected } = await GoshuinStore.sync();
  const notices = [];
  if (!synced) notices.push("⚠️ オフライン表示中 (サーバーと未同期)");
  if (rejected > 0) {
    notices.push(
      `⚠️ ${rejected}件の記録は位置を確認できなかったため取り消されました`
    );
  }
  render(list, notices.join(" / "));
}

// オンライン復帰したら未同期分をサーバーへ送り、最新状態で描き直す
window.addEventListener("online", init);

init();
