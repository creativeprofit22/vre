// Sample main-process mod: logs once at startup and once per window.
// Main mods are CommonJS; export a function and the loader calls it with ctx = { app, electron, log, home, config }.
module.exports = ({ app, log, config }) => {
  log(`sample-hello: main-process mod running in Voyager ${config.version} (electron ${process.versions.electron})`);
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => log(`sample-hello: window loaded ${win.webContents.getURL()}`));
  });
};
