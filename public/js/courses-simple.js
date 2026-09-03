(function () {
  function init() {
    document.querySelectorAll('[data-icon]').forEach(function (el) { if (window.SC && SC.icon) el.innerHTML = SC.icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 }); });
    var input = document.getElementById('courseSearch');
    var empty = document.getElementById('courseNoResults');
    if (!input) return;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase(), visible = 0;
      document.querySelectorAll('#courseGrid [data-search]').forEach(function (card) { var show = !q || card.dataset.search.includes(q); card.hidden = !show; if (show) visible++; });
      empty.hidden = visible !== 0;
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
