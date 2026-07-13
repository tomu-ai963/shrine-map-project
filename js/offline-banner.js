/* ============================================================
   offline-banner.js — オンライン/オフライン状態の共通バナー

   navigator.onLine と online/offline イベントでページ全体の
   接続状態を検知し、オフライン中は控えめなバナーを常時表示する。
   index.html / goshuin.html の両方で読み込む。
   ============================================================ */

(function () {
  const banner = document.createElement("div");
  banner.id = "offline-banner";
  banner.textContent =
    "📡 オフラインです — チェックイン・送信・地図の新規読み込みは利用できません";
  document.body.appendChild(banner);

  function update() {
    banner.classList.toggle("show", navigator.onLine === false);
  }

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update(); // 初期表示 (オフライン状態でページを開いた場合)
})();
