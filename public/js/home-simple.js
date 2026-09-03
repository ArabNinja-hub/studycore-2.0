(function () {
  function init() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      if (window.SC && SC.icon) el.innerHTML = SC.icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 });
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
