// Background auto-update via electron-updater against the GitHub release feed.
// Only active in packaged (not `npm start` dev) apps. Checks on launch and on an
// interval, so an already-installed user gets each new release in place without
// visiting the download page. Updates download silently and install on quit.

const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

let enabled = false;
let scheduled = false;

// Configure the feed. In production the packaged app knows its own repo; we
// hardcode the canonical GitHub repo here so updates resolve even across a
// renamed install.
const FEED = {
  provider: 'github',
  owner: 'mreric20051999-ai',
  repo: 'pulse-vote-hub-Desktop',
};

function isPackaged() {
  return app && app.isPackaged === true;
}

function initUpdater() {
  // Only run the updater inside the packaged (installed) app; dev runs skip it.
  if (!isPackaged()) return false;
  if (enabled) return true;

  try {
    autoUpdater.setFeedURL(FEED);
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    enabled = true;
    return true;
  } catch (err) {
    console.error('[updater] init failed:', err.message);
    return false;
  }
}

function check() {
  if (!enabled) return;
  try {
    autoUpdater.checkForUpdates().catch((err) => {
      // Transient network/GitHub errors are non-fatal: the app still runs and
      // we simply try again on the next interval.
      console.error('[updater] check failed:', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('[updater] check threw:', err.message);
  }
}

// Start the updater: check soon after launch, then once every N hours.
function startAutoUpdate() {
  if (!initUpdater()) return;
  if (scheduled) return;
  scheduled = true;

  // Delay the first check a few seconds so startup / DB init isn't contended,
  // then poll every 4 hours.
  setTimeout(check, 8000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

module.exports = { startAutoUpdate, initUpdater, check };