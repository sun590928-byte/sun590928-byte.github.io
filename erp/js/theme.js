// 主題：跟隨系統，可手動切換（記在本機）；並防止本系統被嵌入其他網站的框架中（點擊劫持）
(function () {
  try {
    var t = localStorage.getItem('wuyue-erp:theme');
    if (t) document.documentElement.dataset.theme = t;
  } catch (e) {}
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try {
      window.top.location = window.self.location.href;
    } catch (e) {}
  }
})();
