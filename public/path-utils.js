(function exposePathUtils(root) {
  function safeReturnPath(value) {
    return /^\/(?:molds\/\d+|scan)?$/.test(value || '') ? value : '/';
  }

  const api = { safeReturnPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ShotPathUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
