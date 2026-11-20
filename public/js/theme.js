// Runs in <head> before first paint so there is no light/dark flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('quizhub-theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'dark' && t !== 'light') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
