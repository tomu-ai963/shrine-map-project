/* ============================================================
   goshuin.js — 御朱印帳ページ (localStorage の一覧表示)
   ============================================================ */

const GOSHUIN_KEY = "goshuin_collection";

function loadGoshuin() {
  try {
    return JSON.parse(localStorage.getItem(GOSHUIN_KEY)) || [];
  } catch {
    return [];
  }
}

function render() {
  const root = document.getElementById("goshuin-list");
  const list = loadGoshuin();

  if (list.length === 0) {
    root.innerHTML = `
      <div class="goshuin-empty">
        まだ御朱印がありません。<br />
        <a href="index.html">地図</a> から社寺を訪れて授かりましょう。
      </div>`;
    return;
  }

  // 新しい順
  list.reverse();

  const grid = document.createElement("div");
  grid.className = "goshuin-grid";

  list.forEach((g) => {
    const card = document.createElement("div");
    card.className = "goshuin-card";
    card.setAttribute("data-seal", g.type === "shrine" ? "神社" : "寺院");
    card.innerHTML = `
      <div class="g-icon">${g.type === "shrine" ? "⛩️" : "🏯"}</div>
      <div class="g-name">${g.name}</div>
      <div class="g-meta">${g.prefecture || ""}<br />${g.date}</div>
    `;
    grid.appendChild(card);
  });

  root.innerHTML = "";
  root.appendChild(grid);
}

render();
