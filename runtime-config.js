/* Static-hosting default. The Node server replaces this response at runtime
   when the optional Glitch backend is enabled. Never put tokens in this file. */
window.REGOLITH_RUNTIME_CONFIG = Object.freeze({
  glitch: {
    enabled: false,
    titleId: '6bd2c447-1770-441b-b94b-bceed5e81e87',
    environment: 'development',
    apiOrigin: '',
    cloudSavesEnabled: false,
    analyticsEnabled: false,
    gameVersion: '1.1.3',
    buildType: 'production'
  }
});
