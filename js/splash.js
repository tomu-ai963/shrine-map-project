/* ============================================================
   splash.js — 起動スプラッシュ (goshuin.html)

   PWA起動 (= 新しいブラウザセッション) ごとに1回だけ表紙風
   スプラッシュを表示し、ホールド後にフェードアウトする。
   地図⇔御朱印帳のタブ移動では再表示しない (sessionStorage で判定)。

   スプラッシュ要素の直後に同期読み込みされるため、再訪時は
   初回描画の前に非表示にでき、ちらつきが出ない。
   ============================================================ */

(function () {
  var splash = document.getElementById("splash");
  if (!splash) return;

  var KEY = "goshuin-splash-shown";
  try {
    if (sessionStorage.getItem(KEY)) {
      splash.hidden = true;
      return;
    }
    sessionStorage.setItem(KEY, "1");
  } catch (e) {
    // プライベートモード等で sessionStorage 不可の場合は毎回表示
  }

  var HOLD_MS = 1600; // 表示ホールド時間
  var FADE_MS = 600; // CSS の transition (0.55s) より僅かに長く

  setTimeout(function () {
    splash.classList.add("hide");
    setTimeout(function () {
      splash.hidden = true;
    }, FADE_MS);
  }, HOLD_MS);
})();
