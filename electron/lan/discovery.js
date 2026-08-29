// mDNS discovery via bonjour-service: the hub advertises _pulsevote._tcp and
// clients browse for it, so no manual IP entry is required on a local network.
const os = require('os');

let activeBonjour = null;

function stopDiscovery() {
  try { if (activeBonjour) activeBonjour.destroy(); } catch (e) { /* noop */ }
  activeBonjour = null;
}

// Advertise this device as an available hub. Returns a stop() function.
function advertise({ name, port, txt = {} } = {}) {
  const Bonjour = require('bonjour-service');
  const bonjour = new Bonjour();
  activeBonjour = bonjour;
  const service = bonjour.publish({
    name: String(name || os.hostname()),
    type: 'pulsevote',
    port: Number(port) || 7380,
    txt: Object.assign({ app: 'pulse-vote-hub-desktop' }, txt),
  });
  service.on('error', (err) => {
    if (process.env.PVH_DEBUG === '1') console.error('[lan] mDNS advertise error', err.message);
  });
  return {
    service,
    stop() {
      try { bonjour.unpublishAll(() => bonjour.destroy()); } catch (e) { /* noop */ }
      if (activeBonjour === bonjour) activeBonjour = null;
    },
  };
}

// Scan for hubs for `durationMs`. Resolves to a list of
// { name, host, port, addresses } (IPv4 addresses only).
function scan(durationMs = 4000) {
  return new Promise((resolve) => {
    const Bonjour = require('bonjour-service');
    const bonjour = new Bonjour();
    activeBonjour = bonjour;
    const found = [];
    const byHostPort = new Map();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { bonjour.destroy(); } catch (e) { /* noop */ }
      resolve(found);
    };
    const timer = setTimeout(finish, durationMs);

    let svc;
    try {
      svc = bonjour.find({ type: 'pulsevote' });
    } catch (e) {
      clearTimeout(timer);
      resolve([]);
      return;
    }
    svc.on('up', (s) => {
      const addresses = (s.addresses || []).filter((a) => !a.includes(':'));
      const key = `${s.host}|${s.port}`;
      if (byHostPort.has(key)) return;
      byHostPort.set(key, true);
      found.push({ name: s.name || null, host: s.host || null, port: s.port || null, addresses });
    });
    // 'error' means the interface was torn down; finish early so clients aren't stuck.
    svc.on('error', () => finish());
  });
}

// Best-effort local IPv4 addresses (for showing a "server running at" hint).
function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

module.exports = { advertise, scan, stopDiscovery, localAddresses };