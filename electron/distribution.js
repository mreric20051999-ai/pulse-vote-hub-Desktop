// Creator/product console — downloads & installs.
//
// The app is fully offline-first, so there is no telemetry backend yet.
// This module keeps a *local* register of where the software is installed
// (manual entries + "this computer") and, when the creator is online, pulls
// public installer download counts from GitHub Releases.
const { app } = require('electron');
const os = require('os');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { audit } = require('./election');

// Public repo used for installer releases (download_count needs no token,
// but stays subject to GitHub's 60 req/hr unauthenticated rate limit).
const GITHUB_REPO = 'mreric20051999-ai/pulse-vote-hub-Desktop';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;

function listDeployments() {
  return db.get().prepare('SELECT * FROM deployments ORDER BY installed_at DESC, registered_at DESC').all();
}

function addDeployment(fields, actor) {
  const machine = fields && String(fields.machine_name || '').trim();
  if (!machine) return { ok: false, error: 'Machine name is required.' };
  const id = uuidv4();
  const now = Date.now();
  db.get().prepare(`
    INSERT INTO deployments (id, machine_name, location, platform, app_version, installed_at, notes, registered_by, registered_at)
    VALUES (@id, @machine_name, @location, @platform, @app_version, @installed_at, @notes, @registered_by, @registered_at)
  `).run({
    id,
    machine_name: machine,
    location: fields && String(fields.location || '').trim() || null,
    platform: fields && String(fields.platform || '').trim() || null,
    app_version: fields && String(fields.app_version || '').trim() || null,
    installed_at: fields && Number(fields.installed_at) || now,
    notes: fields && String(fields.notes || '').trim() || null,
    registered_by: actor ? actor.id : null,
    registered_at: now,
  });
  audit('distribution', `Registered install "${machine}"`);
  return { ok: true, deployment: { id, machine_name: machine } };
}

function removeDeployment(id, actor) {
  const d = db.get();
  const row = d.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Deployment not found' };
  d.prepare('DELETE FROM deployments WHERE id = ?').run(id);
  audit('distribution', `Removed install "${row.machine_name}"`);
  return { ok: true };
}

// Details for auto-registering the machine the app currently runs on.
function thisComputer(fields) {
  return {
    machine_name: os.hostname() || 'This computer',
    location: fields && String(fields.location || '').trim() || null,
    platform: `${os.platform() === 'darwin' ? 'macOS' : os.platform()} ${os.arch()}`,
    app_version: app.getVersion(),
    installed_at: Date.now(),
    notes: fields && String(fields.notes || '').trim() || null,
  };
}

// Hit the GitHub Releases API and return per-asset download counts.
function fetchReleases() {
  return new Promise((resolve) => {
    const token = (db.getConfig('github_token') || '').trim() || (process.env.PVH_GITHUB_TOKEN || '').trim();
    const headers = {
      'User-Agent': 'pulse-vote-hub-desktop',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `token ${token}`;
    const req = https.get(GITHUB_API, { headers, timeout: 12000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 403) return resolve({ ok: false, error: 'GitHub rate limit reached. Try again later.' });
        if (res.statusCode === 401) return resolve({ ok: false, error: 'GitHub token is invalid or out of scope.' });
        if (res.statusCode === 404 && !token) return resolve({ ok: false, error: 'Repo not found or private. Add a GitHub token above, or make the repo public.' });
        if (res.statusCode === 404) return resolve({ ok: false, error: 'Repo not found. Check the repo name/casing in the app constants.' });
        if (res.statusCode !== 200) return resolve({ ok: false, error: `GitHub responded with ${res.statusCode}.` });
        try {
          const releases = JSON.parse(body).map((r) => ({
            tag_name: r.tag_name,
            name: r.name || r.tag_name,
            published_at: r.published_at,
            prerelease: !!r.prerelease,
            draft: !!r.draft,
            assets: (r.assets || []).map((a) => ({
              name: a.name,
              size: a.size,
              download_count: a.download_count,
              updated_at: a.updated_at,
            })),
          }));
          resolve({ ok: true, releases, fetched_at: Date.now(), repo: GITHUB_REPO });
        } catch (e) {
          resolve({ ok: false, error: 'Could not parse the GitHub response.' });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'No internet connection. Downloads need the network.' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'The download request timed out.' }); });
  });
}

module.exports = {
  listDeployments,
  addDeployment,
  removeDeployment,
  thisComputer,
  fetchReleases,
};