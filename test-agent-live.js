const Database = require("/Users/macbook/pulse-vote-hub-desktop/node_modules/better-sqlite3");
const crypto = require("crypto");
const { CDP } = require("/Users/macbook/pulse-vote-hub-desktop/test-cdp-helper");
const cwd = "/Users/macbook/pulse-vote-hub-desktop";

const LIVE = "db5a631b-608d-4220-b6de-95019aa05391";
const dbPath = process.env.HOME + "/Library/Application Support/pulse-vote-hub-desktop/data/pulse-vote-hub.db";

const PRES_AMA = "5b120379-4498-4e1f-a4f8-8c77a7ceaa1d";
const SEC_KWAME = "1b116efc-8d21-4549-962e-6c7e2c2511fd";
const TRE_NANA = "13d1334b-e4f1-4aae-bfce-2fe264e78f85";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) Reset V206: set password, clear prior votes.
  const d = new Database(dbPath);
  const salt = d.prepare("SELECT value FROM config WHERE key='voter_salt'").get().value;
  const hash = crypto.scryptSync("VOTE206", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
  d.prepare("UPDATE voters SET password_hash=?, has_voted=0, ballot_cast=0 WHERE election_id=? AND voter_id=?").run(hash, LIVE, "V206");
  d.prepare("DELETE FROM votes WHERE election_id=? AND voter_id=?").run(LIVE, "V206");
  d.close();
  console.log("RESET V206 (password set, votes cleared)");

  // 2) Open the agent display.
  const cdp = await CDP.connect(9223);
  const page = (await cdp.pages()).find((p) => p.type === "page");
  const W = require(cwd + "/node_modules/ws");
  const ws = new W(page.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  ws.on("message", (m) => { const o = JSON.parse(m.toString()); if (o.id && pend[o.id]) { pend[o.id](o); delete pend[o.id]; } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.on("open", r));
  await send("Page.enable");
  await send("Page.navigate", { url: `http://localhost:7380/kiosk/agent?election=${LIVE}` });
  await sleep(2500);
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;

  const snapCards = async () => ev(`JSON.stringify({
      title: document.querySelector('.agent-title')?.textContent,
      regime: document.querySelector('#agent-refresh')?.textContent,
      recon: [...document.querySelectorAll('.agent-recon-num')].map(n=>n.textContent),
      cards: [...document.querySelectorAll('.agent-card')].map(c=>(c.querySelector('.agent-card-name').textContent+":"+c.querySelector('.agent-card-num').textContent)),
      hasOldRows: !!document.querySelector('.agent-cand'),
      hasStationsList: !!document.querySelector('.agent-stations'),
      hasMute: !!document.querySelector('#agent-mute'),
      hasBurst: !!document.querySelector('#agent-burst')
    })`);
  const obj = async (b) => JSON.parse(await snapCards());

  const before = await obj();
  console.log("\n=== STRUCTURE CHECK (new design) ===");
  console.log("title:", before.title, "| regime:", before.regime);
  console.log("old candidate-table rows present?", before.hasOldRows, "(want false)");
  console.log("per-station list present?", before.hasStationsList, "(want false)");
  console.log("mute button present?", before.hasMute, "(want true)");
  console.log("burst element present?", before.hasBurst, "(want true)");
  console.log("recon strip:", before.recon);
  console.log("cards:", before.cards);

  // 3) Insert V206's live ballot (3 rows) while the page is polling.
  const d2 = new Database(dbPath);
  const now = Date.now();
  const ins = d2.prepare("INSERT INTO votes (election_id, position_id, candidate_id, voter_id, device_id, station_id, timestamp, synced) VALUES (?,?,?,?,?,?,?,1)");
  const sel = [
    ["5f8d716d-2584-4855-821f-315af4908f15", PRES_AMA],
    ["08683af4-0895-4a68-be97-aaf8fd0993cd", SEC_KWAME],
    ["aea6eae3-2c58-4541-b030-46db28964eed", TRE_NANA],
  ];
  sel.forEach(([pos, cand]) => ins.run(LIVE, pos, cand, "V206", "hub", "0e1e568b-57cf-4194-aca1-ae8150635d65", now));
  d2.prepare("UPDATE voters SET has_voted=1, ballot_cast=1 WHERE election_id=? AND voter_id=?").run(LIVE, "V206");
  d2.close();
  console.log("\nInserted V206 ballot (Ama Serwaa/Kwame Osei/Nana Addo)");

  // 4) Poll tightly across the auto-refresh window to catch pop/celebration.
  const seenPop = {}; let burstFired = false;
  const deadline = Date.now() + 5500;
  while (Date.now() < deadline) {
    const r = await ev(`JSON.stringify({
        pop: [...document.querySelectorAll('.agent-card.pop')].map(c=>c.querySelector('.agent-card-name').textContent),
        burst: !!document.querySelector('#agent-burst.go')
      })`);
    const o = JSON.parse(r);
    o.pop.forEach((n) => (seenPop[n] = true));
    if (o.burst) burstFired = true;
    await sleep(120);
  }

  const after = await obj();
  console.log("\n=== AFTER AUTO-REFRESH ===");
  console.log("cards:", after.cards);
  console.log("recon strip:", after.recon);

  const getV = (list, name) => { const x = list.find((c) => c.startsWith(name)); return x ? +x.split(":")[1] : NaN; };
  const amaD = getV(after.cards, "Ama Serwaa") - getV(before.cards, "Ama Serwaa");
  const kwD = getV(after.cards, "Kwame Osei") - getV(before.cards, "Kwame Osei");
  const nnD = getV(after.cards, "Nana Addo") - getV(before.cards, "Nana Addo");
  const validD = +after.recon[0] - +before.recon[0];
  const turnoutD = after.recon[3].replace('%', '') - before.recon[3].replace('%', '');

  const okCounts = amaD === 1 && kwD === 1 && nnD === 1 && validD === 3;
  const okAnimation = !!seenPop["Ama Serwaa"] || !!seenPop["Kwame Osei"] || !!seenPop["Nana Addo"];
  const okBurst = burstFired;
  const okStructure = !before.hasOldRows && !before.hasStationsList && before.hasMute && before.hasBurst;

  console.log("\n===== RESULTS =====");
  console.log("Structure (no old rows/stations; has mute+burst):", okStructure ? "PASS ✔" : "FAIL ✘");
  console.log("Card counts (+1 each):", JSON.stringify({ Ama: amaD, Kwame: kwD, Nana: nnD }), "validDelta", validD, "->", okCounts ? "PASS ✔" : "FAIL ✘");
  console.log("Turnout changed:", before.recon[3], "->", after.recon[3], "(delta", turnoutD + "%)");
  console.log("Pop-in animation seen on a card:", okAnimation ? "PASS ✔" : "NOT OBSERVED (may only fire if a card increments)");
  console.log("Celebration burst fired:", okBurst ? "PASS ✔" : "NOT OBSERVED");

  const fail = !okStructure || !okCounts;
  console.log("\nOVERALL:", fail ? "FAIL ✘" : "PASS ✔");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
