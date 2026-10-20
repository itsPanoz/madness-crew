// Madness Crew - everything is read live from speedrun.com's public API (it allows any website to
// read it), so the site needs no server. Four requests per visit, kept for 10 minutes in the
// visitor's browser:
//   categories            the board names (new categories show up by themselves)
//   records, levels       every single-race board in one go (32 races x each per-level category)
//   records, full-game    the full-game boards
//   runs, newest verified the latest runs feed
"use strict";

const API = "https://www.speedrun.com/api/v1";
const GAME = "9d33e0dl"; // midtown1
const CACHE_KEY = "madness-crew-v1";
const CACHE_MS = 10 * 60 * 1000;

// the 32 Chicago races in game order (= speedrun.com's level order), with their race type
const LEVELS = [
  ["ywemr7dl", "Dearborn Dash", "Blitz"], ["69znyg91", "River Wild & Wacker", "Blitz"], ["r9g1ep92", "Under the El", "Blitz"],
  ["o9x38p9l", "Double-Back Blitz", "Blitz"], ["495l33dp", "Grant Park Parade", "Blitz"], ["rdq5p2dx", "Wild Blue Blitz", "Blitz"],
  ["5d7zk6wy", "Navy Pier Peel-Out", "Blitz"], ["kwj1l7wg", "Bear Cub Blitz", "Blitz"], ["owoq1kd6", "Race for a Space", "Blitz"],
  ["xd18e5wo", "Tall Tower Blitz", "Blitz"], ["ewp0mjdn", "Beginner's Luck", "Checkpoint"], ["y9m1qx95", "Tough Turns & a Tunnel", "Checkpoint"],
  ["5wk1zpd4", "North River Run", "Checkpoint"], ["592ng396", "Soldier Sneaker", "Checkpoint"], ["29v5eldv", "Freeway Flyer", "Checkpoint"],
  ["xd4r7r9m", "Nocturnal Navigator", "Checkpoint"], ["xd03r4dq", "Beat the Bridges", "Checkpoint"], ["rw6epgd7", "Crosstown Switchback", "Checkpoint"],
  ["n93y5zd0", "Perimeter Perils", "Checkpoint"], ["z98gvpwl", "Aptitude Test", "Checkpoint"], ["rdn2j7dm", "Beetle Blast-a-Thon", "Checkpoint"],
  ["ldy87rw3", "Frosty Finale", "Checkpoint"], ["gdr14lwz", "The Littler Loop", "Circuit"], ["nwlpxe9v", "Riverside Run", "Circuit"],
  ["ywemk7dl", "Tunnel Turner", "Circuit"], ["69znog91", "Downtown Driver", "Circuit"], ["r9g10p92", "Museum Marathon", "Circuit"],
  ["o9x35p9l", "South End Circuit", "Circuit"], ["495lo3dp", "City Central", "Circuit"], ["rdq522dx", "North End Navigator", "Circuit"],
  ["5d7266wy", "Old Town Twist", "Circuit"], ["kwjvo7wg", "Loop-De-Loop", "Circuit"],
];
const LEVEL = Object.fromEntries(LEVELS.map(([id, name, mode], i) => [id, { id, name, mode, order: i }]));

const CREW = window.CREW || {};
const POINTS = Array.isArray(CREW.points) && CREW.points.length ? CREW.points : [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const crewSet = new Set((CREW.members || []).map(n => String(n).toLowerCase()));
const isCrew = name => crewSet.has(String(name).toLowerCase());
const COLS = ["#d6453f", "#2e86de", "#27ae60", "#9b59b6", "#e67e22", "#16a085", "#c0392b", "#34495e"];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const pointsFor = place => POINTS[place - 1] || 0;
const FULL_X = CREW.fullGame || {};
const fullMult = cat => Number(FULL_X[cat]) || Number(CREW.fullGameOther) || 1;
function T(t) { // seconds -> 1:23.45 / 19.63
  const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, h = cs % 100;
  return m ? `${m}:${String(s).padStart(2, "0")}.${String(h).padStart(2, "0")}` : `${s}.${String(h).padStart(2, "0")}`;
}
function colour(name) { let h = 0; for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLS[h % COLS.length]; }

// ------------------------------------------------------------------ loading

async function getAll(path) { // follows speedrun.com's "next" pages
  let url = API + path, out = [];
  for (let i = 0; url && i < 10; i++) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("speedrun.com answered " + r.status);
    const j = await r.json();
    out = out.concat(j.data);
    const next = (j.pagination && j.pagination.links || []).find(l => l.rel === "next");
    url = next ? next.uri : null;
  }
  return out;
}

async function fetchRaw() {
  const [cats, levels, full, latest] = await Promise.all([
    getAll(`/games/${GAME}/categories`),
    getAll(`/games/${GAME}/records?scope=levels&top=100&max=200&embed=players`),
    getAll(`/games/${GAME}/records?scope=full-game&top=100&embed=players`),
    fetch(`${API}/runs?game=${GAME}&status=verified&orderby=verify-date&direction=desc&max=12&embed=players`)
      .then(r => { if (!r.ok) throw new Error("speedrun.com answered " + r.status); return r.json(); }).then(j => j.data),
  ]);
  return { cats, levels, full, latest, at: Date.now() };
}

async function loadRaw() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { cached = null; }
  if (cached && Date.now() - cached.at < CACHE_MS) return { raw: cached, note: "" };
  try {
    const raw = await fetchRaw();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (e) { /* full or blocked: fine */ }
    return { raw, note: "" };
  } catch (e) {
    if (cached) return { raw: cached, note: "speedrun.com didn't answer, so these are the boards from " + new Date(cached.at).toLocaleString() + "." };
    throw e;
  }
}

// ------------------------------------------------------------------ the model

const people = {};   // name -> {name, pic, flag, pts, cups[5], boards, runs[]}
const boards = [];   // {cat, catName, level, runs: [{place, name, time, date, id}]}
const fullBoards = [];
let catNames = {}, perLevelCats = [];

function picUrl(p) { // speedrun.com profile picture; ".png" before "?" gets past its bot check
  const u = p && p.assets && p.assets.image && p.assets.image.uri;
  if (!u) return "";
  return u.includes("?") ? u.replace(/\/image\?/, "/image.png?") : u.replace(/\/image$/, "/image.png");
}
function flagUrl(p) {
  const c = p && p.location && p.location.country && p.location.country.code;
  return c ? `https://flagcdn.com/w40/${c.replace("/", "-")}.png` : "";
}

function playerMap(board) {
  const m = {};
  for (const p of (board.players && board.players.data) || []) {
    if (!p.id) continue;
    const name = (p.names && p.names.international) || p.name || "?";
    m[p.id] = name;
    if (!people[name]) people[name] = { name, pic: picUrl(p), flag: flagUrl(p), pts: 0, cups: [0, 0, 0, 0, 0], boards: 0, runs: [] };
  }
  return m;
}
function runnerName(run, pm) {
  return run.players.map(q => (q.rel === "user" ? pm[q.id] : q.name) || "?").join(" & ");
}
const person = name => people[name] || (people[name] = { name, pic: "", flag: "", pts: 0, cups: [0, 0, 0, 0, 0], boards: 0, runs: [] });

function build(raw) {
  catNames = Object.fromEntries(raw.cats.map(c => [c.id, c.name.trim()]));
  perLevelCats = raw.cats.filter(c => c.type === "per-level").map(c => c.id);
  for (const b of raw.levels) {
    if (!LEVEL[b.level]) continue;
    const pm = playerMap(b);
    const runs = b.runs.map(r => ({ place: r.place, name: runnerName(r.run, pm), time: r.run.times.primary_t, date: r.run.date || "", id: r.run.id }));
    const board = { cat: b.category, catName: catNames[b.category] || b.category, level: LEVEL[b.level], runs };
    boards.push(board);
    for (const r of runs) {
      if (r.name.includes(" & ")) continue; // co-op runs: no points
      const p = person(r.name);
      p.runs.push({ ...r, board });
      p.boards++;
      p.pts += pointsFor(r.place);
      if (r.place <= 4) p.cups[r.place]++;
    }
  }
  // full-game boards: points times the board's multiplier (crew.js); shaped like a race board so
  // player cards and the latest feed treat them the same
  raw.full.forEach((b, i) => {
    const pm = playerMap(b);
    const catName = catNames[b.category] || b.category;
    const board = {
      cat: b.category, catName, mult: fullMult(b.category), full: true,
      level: { id: b.category, name: catName, mode: "Full game", order: 100 + i },
      runs: b.runs.map(r => ({ place: r.place, name: runnerName(r.run, pm), time: r.run.times.primary_t, date: r.run.date || "", id: r.run.id })),
    };
    fullBoards.push(board);
    for (const r of board.runs) {
      if (r.name.includes(" & ")) continue;
      const p = person(r.name);
      p.runs.push({ ...r, board });
      p.boards++;
      p.pts += pointsFor(r.place) * board.mult;
      if (r.place <= 4) p.cups[r.place]++;
    }
  });
  boards.sort((a, b) => a.level.order - b.level.order);
}

// ------------------------------------------------------------------ bits

function av(name) {
  const p = people[name] || {};
  const inner = p.pic ? `<img class="pic" src="${esc(p.pic)}" alt="" loading="lazy" onerror="this.remove()">` : esc((name[0] || "?").toUpperCase());
  return `<span class="av" style="background:${colour(name)}">${inner}${p.flag ? `<img class="flag" src="${esc(p.flag)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>`;
}
const cup = p => p >= 1 && p <= 4 ? `<img class="cup" src="img/trophy-${p}.png" alt="${ord(p)}">` : "";
const placeMark = p => cup(p) || `<span class="place">${ord(p)}</span>`;
const nameBtn = name => `<button type="button" data-player="${esc(name)}">${esc(name)}</button>`;
const crewTag = name => isCrew(name) ? ` <span class="tag">crew</span>` : "";

// ------------------------------------------------------------------ standings

let table = [];
let crewOnly = false;
function renderStandings() {
  const rows = crewOnly ? table.filter(s => isCrew(s.name)) : table;
  let h = `<thead><tr><th>#</th><th>Runner</th><th class="num">Points</th><th>Trophies</th><th class="num">Boards</th></tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td colspan="5" class="loading">${crewOnly ? "Nobody from the crew list is on a board yet. Add names in crew.js." : "No runs."}</td></tr>`;
  for (const s of rows) {
    h += `<tr class="${isCrew(s.name) ? "crew" : ""}"><td class="rank">${table.indexOf(s) + 1}</td>` +
      `<td class="who">${av(s.name)}${nameBtn(s.name)}${crewTag(s.name)}</td><td class="num pts">${s.pts}</td>` +
      `<td><div class="cups">${[1, 2, 3, 4].map(p => `<span>${cup(p)}${s.cups[p]}</span>`).join("")}</div></td><td class="num">${s.boards}</td></tr>`;
  }
  $("standings-table").innerHTML = h + "</tbody>";
  $("show-all").setAttribute("aria-pressed", String(!crewOnly));
  $("show-crew").setAttribute("aria-pressed", String(crewOnly));
}

// ------------------------------------------------------------------ race grid

let curCat = null;
function renderGrid() {
  const bs = boards.filter(b => b.cat === curCat);
  const pts = {};
  for (const b of bs) for (const r of b.runs) if (!r.name.includes(" & ")) pts[r.name] = (pts[r.name] || 0) + pointsFor(r.place);
  const ranked = Object.keys(pts).sort((a, b) => pts[b] - pts[a]);
  const cols = ranked.slice(0, 8);
  for (const n of ranked) if (isCrew(n) && !cols.includes(n)) cols.push(n);
  let g = `<thead><tr><th>Race</th><th>Type</th>${cols.map(n => `<th class="pl${isCrew(n) ? " crewcol" : ""}"><span class="who">${esc(n)}${av(n)}</span></th>`).join("")}</tr></thead><tbody>`;
  for (const b of bs) {
    g += `<tr data-level="${b.level.id}"><td class="race"><button type="button" aria-expanded="false">${esc(b.level.name)}</button></td><td class="mode">${b.level.mode}</td>`;
    for (const n of cols) {
      const r = b.runs.find(x => x.name === n);
      g += r ? `<td class="cell p${r.place}"><span class="t">${placeMark(r.place)}${T(r.time)}</span></td>` : `<td class="empty">-</td>`;
    }
    g += "</tr>";
  }
  if (!bs.length) g += `<tr><td class="loading">No runs on this board yet.</td></tr>`;
  $("grid").innerHTML = g + "</tbody>";
  $("grid").dataset.cols = String(cols.length + 2);
  for (const btn of $("cat-tabs").children) btn.setAttribute("aria-selected", String(btn.dataset.cat === curCat));
}
function toggleBoard(tr) {
  const next = tr.nextElementSibling;
  const btn = tr.querySelector(".race button");
  if (next && next.classList.contains("board-row")) {
    next.remove(); tr.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); return;
  }
  const b = boards.find(x => x.cat === curCat && x.level.id === tr.dataset.level);
  const lines = b.runs.map(r => `<div class="board-line${isCrew(r.name) ? " crew" : ""}"><span>${placeMark(r.place)}</span>` +
    `<span class="who">${av(r.name.split(" & ")[0])}${nameBtn(r.name)}</span><span class="when">${esc(r.date)}</span><b>${T(r.time)}</b></div>`).join("");
  const row = document.createElement("tr");
  row.className = "board-row";
  row.innerHTML = `<td colspan="${$("grid").dataset.cols}"><div class="board">${lines || `<span class="none">No runs yet.</span>`}</div></td>`;
  tr.after(row); tr.classList.add("open"); btn.setAttribute("aria-expanded", "true");
}

// ------------------------------------------------------------------ player card

function renderCard(name) {
  const s = people[name];
  if (!s) return;
  const best = [...s.runs].sort((a, b) => a.place - b.place || a.board.level.order - b.board.level.order).slice(0, 8);
  const recent = [...s.runs].filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const rank = table.indexOf(s) + 1;
  const opts = table.map(x => `<option${x.name === name ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  $("card").innerHTML =
    `<div class="card-head">${av(name)}<div><h3>${esc(name)}${crewTag(name)}</h3><div class="meta">${rank ? `rank ${rank} of ${table.length}` : "no single-race runs"}</div></div>` +
    `<label for="pick" style="position:absolute;left:-9999px">Player</label><select id="pick">${opts}</select></div>` +
    `<div class="stats"><div class="stat"><b>${s.pts}</b><span>points</span></div><div class="stat"><b>${s.cups[1]}</b><span>world records</span></div>` +
    `<div class="stat"><b>${s.cups[1] + s.cups[2] + s.cups[3]}</b><span>podiums</span></div><div class="stat"><b>${s.runs.length}</b><span>boards</span></div></div>` +
    `<div class="tw"><table><thead><tr><th>Best results</th><th>Board</th><th class="num">Time</th></tr></thead><tbody>` +
    best.map(r => `<tr><td>${placeMark(r.place)}</td><td>${esc(r.board.level.name)} <span class="place">${esc(r.board.catName)}</span></td><td class="num">${T(r.time)}</td></tr>`).join("") +
    `</tbody></table></div>` +
    (recent.length ? `<div class="meta" style="color:var(--dim);font-size:13px">Latest: ${recent.map(r => `${esc(r.board.level.name)} ${T(r.time)} (${esc(r.date)})`).join(" · ")}</div>` : "");
  $("pick").addEventListener("change", e => showPlayer(e.target.value, false));
}
function showPlayer(name, scroll) {
  if (!people[name] || !people[name].runs.length) return;
  renderCard(name);
  history.replaceState(null, "", "#player=" + encodeURIComponent(name));
  if (scroll) $("player").scrollIntoView();
}

// ------------------------------------------------------------------ latest + full game

function renderLatest(raw) {
  const byRunId = {};
  for (const b of boards.concat(fullBoards)) for (const r of b.runs) byRunId[r.id] = { r, b };
  const rows = raw.latest.map(run => {
    // here the players come embedded in the run itself: users (with names) and guests
    const list = (run.players && run.players.data) || [];
    playerMap({ players: { data: list } });
    const name = list.map(p => (p.names && p.names.international) || p.name || "?").join(" & ") || "?";
    const hit = byRunId[run.id];
    const lvl = LEVEL[run.level];
    const where = (lvl ? lvl.name + " · " : "") + (catNames[run.category] || "");
    const mark = hit ? placeMark(hit.r.place) : `<span class="place">older</span>`;
    return `<div class="feed-row${isCrew(name) ? " crew" : ""}">${av(name.split(" & ")[0])}<div class="what"><b>${esc(name)}</b> <small>${esc(where)} · ${esc(run.date || "")}</small></div>` +
      `<div class="tm">${mark}${T(run.times.primary_t)}</div></div>`;
  });
  $("feed").innerHTML = rows.join("") || `<div class="feed-row"><span class="none">No runs.</span></div>`;
}
function renderFull() {
  $("fg").innerHTML = fullBoards.map(b => `<div class="fg-card"><h3>${esc(b.catName)} <span class="place">points ×${b.mult}</span></h3>` +
    (b.runs.slice(0, 5).map(r => `<div class="fg-line${isCrew(r.name) ? " crew" : ""}"><span>${placeMark(r.place)}</span><span class="who">${av(r.name.split(" & ")[0])}${esc(r.name)}</span><b class="tm">${T(r.time)}</b></div>`).join("") ||
      `<span class="none">No runs yet.</span>`) + `</div>`).join("");
}

// ------------------------------------------------------------------ start

async function start() {
  if (CREW.name) { $("site-name").textContent = CREW.name; document.title = CREW.name; }
  $("points-rule").textContent = "Points on every board: " + POINTS.join(", ") + " for 1st, 2nd, 3rd and so on. Full-game boards count extra (see Full game). Co-op runs don't score.";
  let got;
  try { got = await loadRaw(); }
  catch (e) {
    $("status").textContent = "Couldn't reach speedrun.com (" + e.message + "). Try again in a minute.";
    $("status").classList.add("err");
    return;
  }
  build(got.raw);
  table = Object.values(people).filter(s => s.boards).sort((a, b) => b.pts - a.pts || b.cups[1] - a.cups[1] || a.name.localeCompare(b.name));
  $("status").textContent = got.note || `Live from speedrun.com · ${boards.length} boards, ${table.length} runners · updated ${new Date(got.raw.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (got.note) $("status").classList.add("err");

  renderStandings();
  $("show-all").addEventListener("click", () => { crewOnly = false; renderStandings(); });
  $("show-crew").addEventListener("click", () => { crewOnly = true; renderStandings(); });

  const order = ["zd3rwedn", "xd1zxl72", "rkl6z7qk", "jdrjrw02"]; // Pro, Am, Bus, Cadillac first; new ones after
  const cats = [...new Set(boards.map(b => b.cat))].sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99));
  for (const id of cats) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.setAttribute("role", "tab"); btn.dataset.cat = id; btn.textContent = catNames[id] || id;
    btn.addEventListener("click", () => { curCat = id; renderGrid(); });
    $("cat-tabs").appendChild(btn);
  }
  curCat = cats[0];
  renderGrid();
  $("grid").addEventListener("click", e => {
    const b = e.target.closest(".race button");
    if (b) toggleBoard(b.closest("tr"));
  });

  renderLatest(got.raw);
  renderFull();

  document.body.addEventListener("click", e => {
    const b = e.target.closest("button[data-player]");
    if (b) showPlayer(b.dataset.player, true);
  });
  const m = location.hash.match(/^#player=(.+)$/);
  const want = m ? decodeURIComponent(m[1]) : null;
  const first = table.find(s => isCrew(s.name)) || table[0];
  if (want && people[want]) { renderCard(want); $("player").scrollIntoView(); }
  else if (first) renderCard(first.name);
}
start();
