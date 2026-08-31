// CDP helper for driving the running Electron app (remote-debugging-port 9223).
// Used by test scripts to inspect/navigate/evaluate pages.
const WebSocket = require('ws');
const http = require('http');

function getJson(target) {
  return new Promise((res, rej) => {
    http.get(target, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

class CDP {
  constructor(ws, send) { this.ws = ws; this.send = send; }
  static async connect(port = 9223) {
    const ver = await getJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    let id = 0;
    const pend = {};
    ws.on('message', (m) => {
      const o = JSON.parse(m.toString());
      if (o.id && pend[o.id]) { pend[o.id](o); delete pend[o.id]; }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const i = ++id; pend[i] = res;
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    await new Promise((res) => ws.on('open', res));
    return new CDP(ws, send);
  }
  async call(method, params = {}) {
    const r = await this.send(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }
  async pages() { return getJson('http://127.0.0.1:9223/json/list'); }
  close() { this.ws.close(); }
}

module.exports = { CDP, getJson };
