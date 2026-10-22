// Madness Crew - one page per driver: their League racing (ratings, levels, rivals, read from the League's
// database or its demo) and their speedrun.com runs (the same requests and the same 10-minute cache as the
// Speedruns page, app.js) side by side, with the car they drive most (races sent by the game carry it).
// driver.html#d=<name> opens one driver; driver.html alone lists everyone.
"use strict";

const CFG = window.LEAGUE || {};
const CORE = window.LeagueCore;
const CREWCFG = window.CREW || {};
const POINTS = Array.isArray(CREWCFG.points) && CREWCFG.points.length ? CREWCFG.points : [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const crewSet = new Set((CREWCFG.members || []).map(n => String(n).toLowerCase()));
const isCrew = name => crewSet.has(String(name || "").toLowerCase());
const TABLES = ["players", "organisers", "seasons", "tournaments", "entries", "races", "race_results", "race_confirms", "race_list", "changes"];

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const low = s => String(s || "").toLowerCase();
const fmtDay = t => new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
function T(t) { // seconds -> 1:23.45 / 19.63
  const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, h = cs % 100;
  return m ? `${m}:${String(s).padStart(2, "0")}.${String(h).padStart(2, "0")}` : `${s}.${String(h).padStart(2, "0")}`;
}

// the stock cars' names, for "drives the … most" (model as in the car pictures, img/cars/<model>_<paint>.png)
const CAR_NAMES = {
  vpmustang99: "Mustang GT", vppanozgt: "Panoz GTR-1", vppanoz: "Panoz Roadster", vpbug: "New Beetle", vpbullet: "Mustang Fastback",
  vpford: "Ford F-350", vpcaddie: "Cadillac Eldorado", vpcop: "Police Mustang", vpbus: "City Bus", vpsemi: "Freightliner",
  vpmtruck: "Monster Truck", vppanozirt: "IRT Panoz GTR-1",
};
const carName = car => CAR_NAMES[String(car).replace(/_\d+$/, "")] || String(car).replace(/_\d+$/, "");

// ------------------------------------------------------------------ speedrun.com (same as app.js)

const API = "https://www.speedrun.com/api/v1";
const GAME = "9d33e0dl";
const CACHE_KEY = "madness-crew-v1";
const CACHE_MS = 10 * 60 * 1000;
const LEVELS = [
  ["ywemr7dl", "Dearborn Dash"], ["69znyg91", "River Wild & Wacker"], ["r9g1ep92", "Under the El"], ["o9x38p9l", "Double-Back Blitz"],
  ["495l33dp", "Grant Park Parade"], ["rdq5p2dx", "Wild Blue Blitz"], ["5d7zk6wy", "Navy Pier Peel-Out"], ["kwj1l7wg", "Bear Cub Blitz"],
  ["owoq1kd6", "Race for a Space"], ["xd18e5wo", "Tall Tower Blitz"], ["ewp0mjdn", "Beginner's Luck"], ["y9m1qx95", "Tough Turns & a Tunnel"],
  ["5wk1zpd4", "North River Run"], ["592ng396", "Soldier Sneaker"], ["29v5eldv", "Freeway Flyer"], ["xd4r7r9m", "Nocturnal Navigator"],
  ["xd03r4dq", "Beat the Bridges"], ["rw6epgd7", "Crosstown Switchback"], ["n93y5zd0", "Perimeter Perils"], ["z98gvpwl", "Aptitude Test"],
  ["rdn2j7dm", "Beetle Blast-a-Thon"], ["ldy87rw3", "Frosty Finale"], ["gdr14lwz", "The Littler Loop"], ["nwlpxe9v", "Riverside Run"],
  ["ywemk7dl", "Tunnel Turner"], ["69znog91", "Downtown Driver"], ["r9g10p92", "Museum Marathon"], ["o9x35p9l", "South End Circuit"],
  ["495lo3dp", "City Central"], ["rdq522dx", "North End Navigator"], ["5d7266wy", "Old Town Twist"], ["kwjvo7wg", "Loop-De-Loop"],
];
const LEVEL = Object.fromEntries(LEVELS.map(([id, name], i) => [id, { id, name, order: i }]));

async function getAll(path) {
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
async function loadSpeedruns() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { cached = null; }
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  try {
    const [cats, levels, full, latest] = await Promise.all([
      getAll(`/games/${GAME}/categories`),
      getAll(`/games/${GAME}/records?scope=levels&top=100&max=200&embed=players`),
      getAll(`/games/${GAME}/records?scope=full-game&top=100&embed=players`),
      fetch(`${API}/runs?game=${GAME}&status=verified&orderby=verify-date&direction=desc&max=12&embed=players`).then(r => r.json()).then(j => j.data),
    ]);
    const raw = { cats, levels, full, latest, at: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (e) { /* full or blocked: fine */ }
    return raw;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
function picUrl(p) {
  const u = p && p.assets && p.assets.image && p.assets.image.uri;
  if (!u) return "";
  return u.includes("?") ? u.replace(/\/image\?/, "/image.png?") : u.replace(/\/image$/, "/image.png");
}
// name -> {name, pic, pts, cups[5], runs[]} (points as on the Speedruns page; full-game boards multiplied)
function buildRunners(raw) {
  const people = {};
  const catNames = Object.fromEntries(raw.cats.map(c => [c.id, c.name.trim()]));
  const fullX = CREWCFG.fullGame || {};
  const person = (name, pic) => people[name] || (people[name] = { name, pic: pic || "", pts: 0, cups: [0, 0, 0, 0, 0], runs: [] });
  const add = (b, level, mult) => {
    const pm = {};
    for (const p of (b.players && b.players.data) || []) if (p.id) { pm[p.id] = (p.names && p.names.international) || p.name || "?"; person(pm[p.id], picUrl(p)); }
    for (const r of b.runs) {
      const name = r.run.players.map(q => (q.rel === "user" ? pm[q.id] : q.name) || "?").join(" & ");
      if (name.includes(" & ")) continue; // co-op: no points
      const s = person(name);
      s.runs.push({ place: r.place, time: r.run.times.primary_t, level: level.name, cat: catNames[b.category] || "", order: level.order });
      s.pts += (POINTS[r.place - 1] || 0) * mult;
      if (r.place <= 4) s.cups[r.place]++;
    }
  };
  for (const b of raw.levels) if (LEVEL[b.level]) add(b, LEVEL[b.level], 1);
  raw.full.forEach((b, i) => add(b, { name: catNames[b.category] || "Full game", order: 100 + i },
    Number(fullX[b.category]) || Number(CREWCFG.fullGameOther) || 1));
  return people;
}

// ------------------------------------------------------------------ the League

async function loadLeague() {
  if (CFG.supabaseUrl && CFG.supabaseKey && window.supabase) {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
    const out = {};
    await Promise.all(TABLES.map(async t => {
      let rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(t).select("*").range(from, from + 999);
        if (error) throw new Error(t + ": " + error.message);
        rows = rows.concat(data);
        if (data.length < 1000) break;
      }
      out[t] = rows;
    }));
    return out;
  }
  return window.LeagueDemo.loadAll();
}

// ------------------------------------------------------------------ page

let RUN = {}, L = null, tab = "overview";

function findDriver(name) {
  const n = low(name);
  const lp = L ? [...L.P.values()].find(p => !p.hidden && (low(p.name) === n || low(p.src_name) === n)) : null;
  const srcName = lp ? (lp.src_name || lp.name) : name;
  const sp = Object.values(RUN).find(r => low(r.name) === low(srcName)) || null;
  return lp || sp ? { name: lp ? lp.name : sp.name, lp, sp } : null;
}

function usualCar(lp) {
  if (!lp || !L) return null;
  const count = new Map();
  for (const r of L.races) for (const x of r.results) if (x.player_id === lp.id && x.car) count.set(x.car, (count.get(x.car) || 0) + 1);
  let best = null;
  for (const [car, n] of count) if (!best || n > best.n) best = { car, n };
  return best;
}

const chip = (place, field) => `<span class="dchip${place <= 3 ? ` p${place}` : ""}">${place}</span>${field ? `<small> of ${field}</small>` : ""}`;

function render(name) {
  const d = name && findDriver(name);
  if (!d) return renderList(name);
  const { lp, sp } = d;
  const car = usualCar(lp);
  const rated = L ? [...L.P.values()].filter(p => !p.hidden && p.races >= (CFG.ladderMinRaces || 3)).sort((a, b) => b.ratingValue - a.ratingValue) : [];
  const rank = lp ? rated.indexOf(lp) + 1 : 0;
  const table = Object.values(RUN).sort((a, b) => b.pts - a.pts);
  const srank = sp ? table.indexOf(sp) + 1 : 0;
  const pic = (lp && lp.avatar_url) || (sp && sp.pic) || "";
  const lv = lp && lp.lv;
  const lvText = lv ? (lv.master ? `${lv.rank.name} · Master level ${lv.masterLevel}` : `${lv.prestige ? `Prestige ${lv.prestige} · ` : ""}Level ${lv.level}${lv.canPrestige ? " · ready to prestige" : ""}`) : "";
  document.title = `${d.name} · Madness Crew`;

  const nums = [
    lp && lp.races ? [`League rating`, lp.ratingValue, rank ? `#${rank}` : ""] : [`League rating`, "–", "no races yet"],
    lp ? [`League wins`, lp.wins, `of ${lp.races}`] : [`League wins`, "–", "not on the League"],
    sp ? [`Speedrun points`, sp.pts, `${ord(srank)}`] : [`Speedrun points`, "–", "no runs"],
    sp ? [`Board wins`, sp.cups[1], `of ${sp.runs.length}`] : [`Board wins`, "–", ""],
  ];

  const leagueHalf = lp ? `
      <div class="drow"><span>Races</span><span>${lp.races}</span></div>
      <div class="drow"><span>Podium rate</span><span>${lp.races ? Math.round(100 * lp.podiums / lp.races) + "%" : "–"}</span></div>
      <div class="drow"><span>Last 5</span><span>${lp.recent.slice(0, 5).map(r => r.place).join(" · ") || "–"}</span></div>
      <div class="drow"><span>Rival</span><span>${lp.rival && L.P.get(lp.rival.id) ? `<a href="#d=${encodeURIComponent(L.P.get(lp.rival.id).name)}">${esc(L.P.get(lp.rival.id).name)}</a> (${lp.rival.w}–${lp.rival.l})` : "–"}</span></div>
      ${lv ? `<div class="dxp"><small>${esc(lvText)}</small><div class="dbar"><i style="width:${lv.need ? Math.round(100 * lv.into / lv.need) : 100}%"></i></div></div>` : ""}`
    : `<p class="none">Not on the League yet.</p>`;
  const best = sp ? [...sp.runs].sort((a, b) => a.place - b.place || a.order - b.order)[0] : null;
  const speedHalf = sp ? `
      <div class="drow"><span>Rank</span><span>${ord(srank)} of ${table.length}</span></div>
      <div class="drow"><span>Boards run</span><span>${sp.runs.length}</span></div>
      <div class="drow"><span>Best board</span><span>${best ? `${esc(best.level)} · ${esc(best.cat)} (${ord(best.place)})` : "–"}</span></div>
      <div class="dcups">${[1, 2, 3, 4].map(i => `<div><img src="img/trophy-${i}.png" alt="${ord(i)}"><b>${sp.cups[i]}</b><small>${ord(i)}</small></div>`).join("")}</div>`
    : `<p class="none">No speedrun.com runs${lp ? " under this name" : ""}.</p>`;

  const panels = {
    overview: `<div class="dhalves"><div><h3><i class="g"></i>League</h3>${leagueHalf}</div><div><h3><i class="y"></i>Speedruns</h3>${speedHalf}</div></div>`,
    league: lp ? `<div class="dpanel"><table class="dt"><thead><tr><th>Place</th><th>Race</th><th>Car</th><th class="r">When</th></tr></thead><tbody>${
      lp.recent.slice(0, 40).map(r => {
        const mine = r.race.results.find(x => x.player_id === lp.id) || {};
        return `<tr><td>${chip(r.place, r.field)}</td><td>${esc([r.race.city, r.race.mode, r.race.race_name].filter(Boolean).join(" · ") || "Race")}${r.race.imported ? ` <small class="dim">Challonge</small>` : ""}</td>` +
          `<td>${mine.car ? `<img class="dcar-s" src="img/cars/${esc(mine.car)}.png" alt="${esc(carName(mine.car))}" title="${esc(carName(mine.car))}" onerror="this.remove()">` : ""}</td><td class="r dim">${fmtDay(r.race.at)}</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="none">No races yet.</td></tr>`}</tbody></table></div>`
      : `<p class="none dpanel">Not on the League yet.</p>`,
    speedruns: sp ? `<div class="dpanel"><table class="dt"><thead><tr><th>Place</th><th>Race</th><th>Board</th><th class="r">Time</th></tr></thead><tbody>${
      [...sp.runs].sort((a, b) => a.order - b.order || a.place - b.place).map(r =>
        `<tr><td>${chip(r.place)}</td><td>${esc(r.level)}</td><td class="dim">${esc(r.cat)}</td><td class="r num">${T(r.time)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="none dpanel">No speedrun.com runs.</p>`,
    h2h: lp ? `<div class="dpanel"><table class="dt"><thead><tr><th>Against</th><th class="r">Races together</th><th class="r">Won–lost</th><th class="r">1v1 matches</th></tr></thead><tbody>${
      [...lp.h2h.values()].filter(h => L.P.get(h.id) && !L.P.get(h.id).hidden).sort((a, b) => b.races - a.races).map(h =>
        `<tr${lp.rival && lp.rival.id === h.id ? ` class="rival"` : ""}><td><a href="#d=${encodeURIComponent(L.P.get(h.id).name)}">${esc(L.P.get(h.id).name)}</a></td><td class="r num">${h.races}</td><td class="r num">${h.w}–${h.l}</td><td class="r num">${h.mw + h.ml ? `${h.mw}–${h.ml}` : "–"}</td></tr>`).join("") ||
      `<tr><td colspan="4" class="none">No races with anyone yet.</td></tr>`}</tbody></table></div>`
      : `<p class="none dpanel">Not on the League yet.</p>`,
  };

  $("driver").innerHTML = `<div class="dpage">
    <div class="dhero">
      <div class="dav">${pic ? `<img src="${esc(pic)}" alt="" onerror="this.remove()">` : ""}<span>${esc(d.name[0].toUpperCase())}</span></div>
      <div class="dname"><b>${esc(d.name)}${isCrew(d.name) || (lp && isCrew(lp.src_name)) ? ` <img class="crewbadge" src="img/logo.png" alt="Madness Crew" title="Madness Crew">` : ""}</b>
        <span>${[isCrew(d.name) ? "Madness Crew" : "", lvText, car ? `drives the ${esc(carName(car.car))} most` : ""].filter(Boolean).join(" · ")}</span></div>
      ${car ? `<img class="dcar" src="img/cars/${esc(car.car)}.png" alt="${esc(carName(car.car))}" width="256" height="128" onerror="this.remove()">` : ""}
    </div>
    <div class="dnums">${nums.map(([k, v, e]) => `<div><small>${k}</small><b class="num">${v}</b><em>${esc(e)}</em></div>`).join("")}</div>
    <div class="dtabs" role="tablist">${[["overview", "Overview"], ["league", "League races"], ["speedruns", "Speedrun PBs"], ["h2h", "Head-to-head"]].map(([k, t]) =>
      `<button type="button" role="tab" aria-selected="${k === tab}" data-tab="${k}">${t}</button>`).join("")}</div>
    ${panels[tab]}
    <p class="dfoot"><a href="driver.html">All drivers</a>${lp ? ` · <a href="league.html#p=${lp.id}">League profile</a>` : ""}${sp ? ` · <a href="index.html#player=${encodeURIComponent(sp.name)}">Speedrun card</a>` : ""}</p>
  </div>`;
  $("status").textContent = "";
}

function renderList(missing) {
  document.title = "Drivers · Madness Crew";
  const names = new Map();
  if (L) for (const p of L.P.values()) if (!p.hidden) names.set(low(p.src_name || p.name), p.name);
  for (const r of Object.values(RUN)) if (!names.has(low(r.name))) names.set(low(r.name), r.name);
  const list = [...names.values()].sort((a, b) => (isCrew(b) - isCrew(a)) || a.localeCompare(b));
  $("driver").innerHTML = `${missing ? `<p class="status">No driver called “${esc(missing)}”.</p>` : ""}
    <div class="sec-head"><h2>Drivers</h2><p class="sub">Everyone on the League or the speedrun.com boards. Crew first.</p></div>
    <div class="dlist">${list.map(n => `<a href="#d=${encodeURIComponent(n)}">${esc(n)}${isCrew(n) ? ` <img class="crewbadge" src="img/logo.png" alt="Madness Crew">` : ""}</a>`).join("")}</div>`;
  $("status").textContent = "";
}

function current() {
  const m = location.hash.match(/^#d=(.+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  render(current());
});
window.addEventListener("hashchange", () => { tab = "overview"; render(current()); window.scrollTo(0, 0); });

(async () => {
  const notes = [];
  await Promise.all([
    loadSpeedruns().then(raw => { RUN = buildRunners(raw); }).catch(e => notes.push("speedrun.com didn't answer (" + e.message + ")")),
    loadLeague().then(D => { L = CORE.compute(D, CFG, POINTS); }).catch(e => notes.push("the League didn't load (" + e.message + ")")),
  ]);
  render(current());
  if (notes.length) $("status").textContent = "Some numbers are missing: " + notes.join("; ") + ".";
})();
