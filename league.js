// Madness Crew League - the page. Reads every table from Supabase (or the demo data), hands them to
// league-core.js to work out ratings, levels and brackets, and draws the result. Writes go straight
// to Supabase, whose own rules (supabase/schema.sql) decide who may do what; the buttons here only
// show what those rules would allow.
"use strict";

const CFG = window.LEAGUE || {};
const CORE = window.LeagueCore;
const CREWCFG = window.CREW || {};
const POINTS = Array.isArray(CREWCFG.points) && CREWCFG.points.length ? CREWCFG.points : [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
const crewSet = new Set((CREWCFG.members || []).map(n => String(n).toLowerCase()));
const TABLES = ["players", "organisers", "seasons", "tournaments", "entries", "races", "race_results", "race_confirms", "race_list", "changes"];

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const fmtDay = t => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
const fmtWhen = t => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const COLS = ["#d6453f", "#2e86de", "#27ae60", "#9b59b6", "#e67e22", "#16a085", "#c0392b", "#34495e"];
function colour(name) { let h = 0; for (const c of String(name).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLS[h % COLS.length]; }

// ---------------------------------------------------------------- the store (Supabase or demo)

function supabaseStore() {
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const store = {
    demo: false, user: null,
    async init() {
      const { data } = await sb.auth.getSession();
      this.setUser(data.session);
      sb.auth.onAuthStateChange((_e, s) => { const was = this.user && this.user.id; this.setUser(s); if ((this.user && this.user.id) !== was) refresh(); });
    },
    setUser(s) {
      const u = s && s.user;
      const m = (u && u.user_metadata) || {};
      this.user = u ? { id: u.id, name: (m.custom_claims && m.custom_claims.global_name) || m.full_name || m.name || "driver", avatar: m.avatar_url || "" } : null;
    },
    async loadAll() {
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
    },
    async insert(t, rows) { const { data, error } = await sb.from(t).insert(rows).select(); if (error) throw new Error(error.message); return data; },
    async update(t, match, patch) {
      let q = sb.from(t).update(patch);
      for (const k in match) q = q.eq(k, match[k]);
      const { error } = await q; if (error) throw new Error(error.message);
    },
    async remove(t, match) {
      let q = sb.from(t).delete();
      for (const k in match) q = q.eq(k, match[k]);
      const { error } = await q; if (error) throw new Error(error.message);
    },
    async pendingClaims() { const { data, error } = await sb.rpc("pending_claims"); if (error) throw new Error(error.message); return data || []; },
    // the private key Madness HUD sends your online races with (supabase/game-results.sql, -v3.sql)
    async gameKey(rotate) { const { data, error } = await sb.rpc("my_game_key", { rotate: !!rotate }); if (error) throw new Error(error.message); return data; },
    // a race file from Madness HUD (Madness HUD results\*.json), sent with your own game key like the game does
    async submitRace(race) {
      const key = await this.gameKey(false);
      const { data, error } = await sb.rpc("submit_game_race", { p_key: key, p_race: race });
      if (error) throw new Error(error.message);
      return data;
    },
    signIn() { return sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + location.pathname } }); },
    async signOut() { await sb.auth.signOut(); this.user = null; },
    onChange(cb) { sb.channel("league").on("postgres_changes", { event: "*", schema: "public" }, cb).subscribe(); },
  };
  return store;
}

const LIVE = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
const store = LIVE ? supabaseStore() : window.LeagueDemo;

// ---------------------------------------------------------------- state

let D = null;      // raw tables
let L = null;      // worked out by league-core
let me = null;     // my player row (from L.P), if signed in and linked
let isOrg = false;
let ladderSort = "rating";
// Racing and Cops & Robbers are rated apart (Robin 2026-10-22): the ladder's switch, the records' switch.
// Level and XP stay one number for everything (they come from L, every game).
let ladderKind = "race", recKind = "race";
try { ladderKind = localStorage.getItem("madness-league-kind") || "race"; } catch (e) { /* private window: fine */ }
let LK = { race: null, cnr: null };   // the League worked out on racing only / Cops & Robbers only
let openRace = null;                  // the race opened under its row in Latest races
let openT = null;  // open tournament id
let openP = null;  // open profile id
let seasonPick = null;
let showOldT = false; // every finished tournament in the list, not just the latest
let claims = [];      // organisers: who asked to be which driver

const P = id => L.P.get(id);
// drivers an organiser removed keep their name in old tournaments and race results (plain text, no
// profile), but leave every list, record and head-to-head
const nameOf = id => (P(id) ? P(id).name : "?");
const drivers = () => [...L.P.values()].filter(p => !p.hidden);
const isCrew = p => p && (crewSet.has(String(p.src_name || "").toLowerCase()) || crewSet.has(String(p.name).toLowerCase()));
const crewTag = p => isCrew(p) ? ` <img class="crewbadge" src="img/logo.png" alt="Madness Crew" title="Madness Crew">` : "";

// Cops & Robbers games (and C&R tournaments) on their own, or everything else (racing)
const isCnR = mode => mode === "Cops & Robbers";
function splitData(D, cnr) {
  const races = D.races.filter(r => isCnR(r.mode) === cnr);
  const ids = new Set(races.map(r => r.id));
  const tours = D.tournaments.filter(t => isCnR(t.settings && t.settings.mode) === cnr);
  const tids = new Set(tours.map(t => t.id));
  return { ...D, races, tournaments: tours, entries: D.entries.filter(e => tids.has(e.tournament_id)),
    race_results: D.race_results.filter(x => ids.has(x.race_id)), race_confirms: D.race_confirms.filter(x => ids.has(x.race_id)) };
}
// one driver's numbers for a kind of game ("all" = everything); a driver who never played that kind gets zeros
const NONE = { races: 0, wins: 0, podiums: 0, ratingValue: 0, recent: [], bestStreak: null, tournaments: [], h2h: new Map(), rival: null };
const statOf = (p, kind) => kind === "all" || !LK[kind] ? p : (LK[kind].P.get(p.id) || NONE);
const gamesWord = kind => kind === "race" ? "races" : "games"; // Overall mixes both, so it counts games too

async function refresh() {
  try {
    D = await store.loadAll();
    L = CORE.compute(D, CFG, POINTS);
    LK = { race: CORE.compute(splitData(D, false), CFG, POINTS), cnr: CORE.compute(splitData(D, true), CFG, POINTS) };
  } catch (e) {
    setStatus("Couldn't load the league (" + e.message + "). Try again in a minute.", true);
    return;
  }
  const u = store.user;
  isOrg = !!(u && L.organisers.has(u.id));
  me = u ? [...L.P.values()].find(p => p.user_id === u.id) || null : null;
  claims = [];
  if (isOrg) try { claims = await store.pendingClaims(); } catch (e) { /* the list just stays empty */ }
  renderAll();
}
function setStatus(text, err) { $("status").textContent = text; $("status").classList.toggle("err", !!err); }

// ---------------------------------------------------------------- emblems (inline SVG, no images)

function emblem(lv, px) {
  const c = lv.rank.colour;
  const s = px || 28;
  let body;
  if (lv.master) {
    body = `<path d="M4 25 L6 9 L12 16 L16 5 L20 16 L26 9 L28 25 Z" fill="${c}" stroke="#2b1d00" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<rect x="4" y="25" width="24" height="4" rx="1" fill="#ff7a1a" stroke="#2b1d00" stroke-width="1.2"/>` +
      `<circle cx="16" cy="18" r="2.4" fill="#ff4d5e"/>`;
  } else if (lv.prestige === 0) {
    const n = Math.min(5, 1 + Math.floor((lv.level - 1) / 10));
    const tier = ["#7d8b81", "#9fb3a5", "#46dc5a", "#3d8bfd", "#ecd628"][n - 1];
    body = `<path d="M16 2 L28 6 V16 C28 23 22 28 16 30 C10 28 4 23 4 16 V6 Z" fill="#1d2b22" stroke="${tier}" stroke-width="2"/>`;
    for (let i = 0; i < n; i++) {
      const y = 22 - i * 3.6;
      body += `<path d="M9 ${y} L16 ${y - 4} L23 ${y}" fill="none" stroke="${tier}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  } else {
    // a star in the prestige colour with the prestige number; more points every few prestiges
    const pts = lv.prestige >= 7 ? 8 : lv.prestige >= 4 ? 6 : 5;
    let d = "";
    for (let i = 0; i < pts * 2; i++) {
      const r = i % 2 ? 6.5 : 14, a = (Math.PI * i) / pts - Math.PI / 2;
      d += (i ? "L" : "M") + (16 + r * Math.cos(a)).toFixed(1) + " " + (16 + r * Math.sin(a)).toFixed(1) + " ";
    }
    body = `<path d="${d}Z" fill="${c}" stroke="#101410" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<text x="16" y="20.5" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="800" font-size="${lv.prestige >= 10 ? 9.5 : 12}" fill="#101410">${lv.prestige}</text>`;
  }
  const label = lv.master ? `${lv.rank.name} ${lv.masterLevel}` : lv.prestige ? `Prestige ${lv.prestige} (${lv.rank.name}), level ${lv.level}` : `Level ${lv.level}`;
  return `<svg class="emb" width="${s}" height="${s}" viewBox="0 0 32 32" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${body}</svg>`;
}
const lvText = lv => lv.master ? `Master ${lv.masterLevel}` : (lv.prestige ? `P${lv.prestige} · ` : "") + `Lv ${lv.level}`;
const nameStyle = p => p.lv.prestige >= 1 ? ` style="color:${p.lv.rank.colour}"` : "";
function who(p, opts) {
  const o = opts || {};
  if (p.hidden) return `<span class="who former" title="No longer in the League">${esc(p.name)}</span>`;
  const av = p.avatar_url ? `<img class="pic" src="${esc(p.avatar_url)}" alt="" loading="lazy" onerror="this.remove()">` : esc((p.name[0] || "?").toUpperCase());
  return `<span class="who">${o.noEmblem ? "" : emblem(p.lv, o.size || 24)}<span class="av" style="background:${colour(p.name)}">${av}</span>` +
    `<button type="button" data-act="profile" data-id="${p.id}"${nameStyle(p)}>${esc(p.name)}</button>${crewTag(p)}</span>`;
}
const placeChip = (place, field) => place == null ? `<span class="chip dnf" title="did not finish">DNF</span>` :
  `<span class="chip p${Math.min(place, 4)}" title="${ord(place)} of ${field}">${place}</span>`;

// ---------------------------------------------------------------- account + me

function renderAccount() {
  const a = $("account");
  if (store.demo) {
    const opts = D.players.filter(p => p.user_id && !p.hidden).map(p => `<option value="${esc(p.user_id || "")}"${store.user && store.user.id === p.user_id ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    const guest = `<option value="u-guest"${store.user && store.user.id === "u-guest" ? " selected" : ""}>a new Discord user</option>`;
    a.innerHTML = `<label class="mini">Try as <select id="demo-as"><option value="">nobody (signed out)</option>${guest}${opts}</select></label>` +
      `<label class="mini"><input type="checkbox" id="demo-org"${isOrg ? " checked" : ""}> organiser</label>`;
    return;
  }
  if (store.user) {
    a.innerHTML = `${store.user.avatar ? `<img class="me-av" src="${esc(store.user.avatar)}" alt="">` : ""}<span class="mini">${esc(store.user.name)}${isOrg ? " · organiser" : ""}</span>` +
      `<button type="button" class="btn ghost" data-act="signout">Sign out</button>`;
  } else {
    a.innerHTML = `<button type="button" class="btn discord" data-act="signin">Sign in with Discord</button>`;
  }
}

function renderMe() {
  const s = $("me");
  if (!store.user) { s.hidden = true; return; }
  s.hidden = false;
  if (!me) {
    const asked = D.players.find(p => !p.user_id && p.claim_by === store.user.id);
    if (asked) {
      s.innerHTML = `<div class="card"><h3 class="h3">Waiting for an organiser</h3>
        <p class="sub">You asked to be <b>${esc(asked.name)}</b>. Once an organiser approves it, the driver and all its old races are yours.</p>
        <div class="row"><button type="button" class="btn ghost" data-act="claim-cancel" data-id="${asked.id}">Cancel the request</button></div></div>`;
      return;
    }
    const free = drivers().filter(p => !p.user_id && !p.claim_by).sort((a, b) => a.name.localeCompare(b.name));
    s.innerHTML = `<div class="card"><h3 class="h3">Link your driver</h3>
      <p class="sub">Raced on our Challonge, or an organiser already added you? Claim your name so your old races come with you${isOrg ? "" : ". An organiser approves it first"}. New here? Make a new driver.</p>
      <div class="row">${free.length ? `<label>Claim <select id="claim-pick">${free.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
      <button type="button" class="btn" data-act="claim">${isOrg ? "That's me" : "That's me, ask an organiser"}</button><span class="mini">or</span>` : ""}
      <label>New driver <input id="new-name" maxlength="32" value="${esc(store.user.name)}"></label>
      <button type="button" class="btn" data-act="create-me">Create</button></div></div>`;
    return;
  }
  const lv = me.lv;
  const pct = lv.need ? Math.round((100 * lv.into) / lv.need) : 100;
  const R = CORE.levelRules(CFG);
  const nextP = Math.min(lv.prestige + 1, R.maxPrestige);
  const prestigeBtn = lv.canPrestige
    ? `<button type="button" class="btn hot" data-act="prestige">Prestige to ${esc(CORE.PRESTIGES[nextP].name)}</button>`
    : "";
  const ch = me.thisWeek.map(c => `<div class="chal${c.got >= c.goal ? " done" : ""}"><span>${esc(c.text)}</span><span class="mini">${c.got}/${c.goal} · ${c.xp} XP</span>` +
    `<span class="bar"><i style="width:${Math.round((100 * c.got) / c.goal)}%"></i></span></div>`).join("");
  const wk = CORE.weekStart(L.nowWeek);
  s.innerHTML = `<div class="card me-card">
    <div class="me-head">${emblem(lv, 72)}<div>
      <h3 class="h3"${nameStyle(me)}>${esc(me.name)}${crewTag(me)}</h3>
      <div class="meta">${esc(lv.master ? `${lv.rank.name} · Master level ${lv.masterLevel}` : `${lv.title} · ${lv.prestige ? `Prestige ${lv.prestige} ${lv.rank.name} · ` : ""}Level ${lv.level}`)} · rating ${me.ratingValue}</div>
      <div class="lvbar" title="${lv.into} / ${lv.need} XP"><i style="width:${pct}%"></i></div>
      <div class="mini">${lv.need ? `${lv.into.toLocaleString()} / ${lv.need.toLocaleString()} XP to ${lv.master ? "the next Master level" : "level " + (lv.level + 1)}` : "Max level: prestige to start again with a new emblem."} · ${me.xp.toLocaleString()} XP in total</div>
    </div><div class="me-actions">${prestigeBtn}<button type="button" class="btn" data-act="report">Report a race</button>
      <button type="button" class="btn ghost" data-act="upload">Upload race files</button>
      <button type="button" class="btn ghost" data-act="profile" data-id="${me.id}">My profile</button></div></div>
    <div><div class="mini" style="margin-bottom:6px">This week's challenges (from ${fmtDay(wk)}, same for everyone)</div><div class="chals">${ch}</div></div>
  </div>`;
}

// ---------------------------------------------------------------- ladder

function renderLadder() {
  const min = CFG.ladderMinRaces || 3;
  const all = drivers();
  const k = ladderKind, S = p => statOf(p, k), word = gamesWord(k);
  let ranked, rest = [];
  if (ladderSort === "rating") {
    ranked = all.filter(p => S(p).races >= min).sort((a, b) => S(b).ratingValue - S(a).ratingValue || S(b).wins - S(a).wins);
    rest = all.filter(p => S(p).races < min).sort((a, b) => S(b).races - S(a).races || a.name.localeCompare(b.name));
  } else if (ladderSort === "level") {
    ranked = all.slice().sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
  } else {
    ranked = all.filter(p => S(p).races).sort((a, b) => S(b).wins - S(a).wins || S(b).podiums - S(a).podiums || S(b).ratingValue - S(a).ratingValue);
    rest = all.filter(p => !S(p).races);
  }
  const which = k === "race" ? "racing" : k === "cnr" ? "Cops & Robbers" : "every game, racing and Cops & Robbers together";
  $("ladder-sub").textContent = ladderSort === "rating"
    ? `Skill rating from ${which}. It needs ${min} ${word} to get a place; new drivers start at 1000.`
    : ladderSort === "level" ? "Everyone by total XP, prestige included (one level for racing and Cops & Robbers)." : `Most wins in ${which}.`;
  for (const b of document.querySelectorAll("[data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === ladderSort));
  for (const b of document.querySelectorAll("[data-kind]")) b.setAttribute("aria-pressed", String(b.dataset.kind === ladderKind));
  const row = (p, i) => {
    const s = S(p);
    const form = s.recent.slice(0, 5).map(r => placeChip(r.place, r.field)).join("");
    return `<tr class="${isCrew(p) ? "crew" : ""}${me && p.id === me.id ? " mine" : ""}"><td class="rank">${i == null ? "–" : i + 1}</td><td>${who(p)}</td>` +
      `<td class="num pts">${s.races ? s.ratingValue : "–"}</td><td class="lv">${esc(lvText(p.lv))}</td><td class="num">${s.races}</td><td class="num">${s.wins}</td>` +
      `<td class="num">${s.races ? Math.round((100 * s.podiums) / s.races) + "%" : "–"}</td><td><span class="form">${form}</span></td></tr>`;
  };
  let h = `<thead><tr><th>#</th><th>Driver</th><th class="num">Rating</th><th>Level</th><th class="num">${word === "games" ? "Games" : "Races"}</th><th class="num">Wins</th><th class="num">Podium</th><th>Last 5</th></tr></thead><tbody>`;
  h += ranked.map((p, i) => row(p, i)).join("");
  if (rest.length) h += `<tr class="divider"><td colspan="8">${ladderSort === "rating" ? `Fewer than ${min} ${word}` : `No ${word} yet`}</td></tr>` + rest.map(p => row(p, null)).join("");
  if (!all.length) h += `<tr><td colspan="8" class="loading">No drivers yet. Sign in and create yours.</td></tr>`;
  $("ladder-table").innerHTML = h + "</tbody>";
}

// ---------------------------------------------------------------- tournaments

const STATUS = { signup: "Sign-up open", checkin: "Check-in", live: "Live", done: "Finished" };
function tourSort(a, b) {
  const o = { live: 0, checkin: 1, signup: 2, done: 3 };
  return o[a.status] - o[b.status] || (a.status === "done" ? String(b.starts_at).localeCompare(String(a.starts_at)) : String(a.starts_at).localeCompare(String(b.starts_at)));
}
function renderTourList() {
  $("new-tournament").hidden = !isOrg;
  // finished ones beyond the latest few fold away (the Challonge history alone is 25)
  const all = D.tournaments.slice().sort(tourSort);
  const keep = all.filter(t => t.status !== "done").length + 6;
  const ts = showOldT ? all : all.filter((t, i) => i < keep || t.id === openT);
  const more = all.length - ts.length;
  $("tlist").innerHTML = ts.map(t => {
    const v = L.tours.get(t.id);
    const n = D.entries.filter(e => e.tournament_id === t.id).length;
    const champ = (v.awarded || v.raceOnly) && v.places.find(x => x.place === 1);
    return `<button type="button" class="tcard${openT === t.id ? " open" : ""}" data-act="open-t" data-id="${t.id}">
      <span class="st ${t.status}">${STATUS[t.status]}</span><b>${esc(t.name)}</b>
      <span class="mini">${esc(CORE.FORMATS[t.format])} · ${n} driver${n === 1 ? "" : "s"}${t.starts_at ? " · " + fmtWhen(t.starts_at) : ""}</span>
      ${champ ? `<span class="mini win">Won by ${esc(nameOf(champ.id))}</span>` : ""}</button>`;
  }).join("") + (more ? `<button type="button" class="tcard more" data-act="old-t"><b>+ ${more} older</b><span class="mini">Show every finished tournament</span></button>` : "") ||
    `<p class="none">No tournaments yet.${isOrg ? " Make one with New tournament." : ""}</p>`;
  renderTour();
}

function matchBox(t, m, v) {
  const nm = id => id === null ? `<i class="bye">bye</i>` : id === undefined ? `<i class="tbd">waiting</i>` : esc(nameOf(id));
  const side = (id, wins) => `<div class="side${m.done && m.winner === id && id ? " won" : ""}${me && id === me.id ? " mine" : ""}"><span>${nm(id)}</span><b>${m.a != null && m.b != null ? wins : ""}</b></div>`;
  const ready = m.a && m.b && !m.done && t.status === "live";
  const can = ready && (isOrg || (me && (me.id === m.a || me.id === m.b)));
  const pend = v.pending.some(r => r.match_key === m.key);
  return `<div class="match${m.done ? " done" : ""}${ready ? " ready" : ""}">${m.table ? `<div class="mlabel">table ${m.table}</div>` : ""}${side(m.a, m.winsA)}${side(m.b, m.winsB)}` +
    (can ? `<button type="button" class="btn small" data-act="report" data-t="${t.id}" data-key="${esc(m.key)}" data-players="${m.a},${m.b}">Report</button>` : "") +
    (pend ? `<div class="mini warn">result waiting to be verified</div>` : "") + `</div>`;
}

// ---------------------------------------------------------------- brackets: the whole tree on wide
// screens, one round at a time on phones; tapping a driver lights up their path

const BK = { W: 188, H: 56, SLOT: 34, PITCH: 236, HEAD: 26, PAD: 14 };
let follow = null;      // player id whose matches are lit up
const roundPick = {};   // tournament id -> which round the phone view shows
const seedPick = { t: null, sel: null }; // bracket preview before Start: tap two drivers to swap their seeds

// every match with a short code (A, B, C… like Challonge), a section (W winners, L losers, P placement),
// a column, and src: where each side came from ([match key, loser?])
function bracketModel(v, t) {
  // a score tournament played over single races shows the scores instead of race wins
  if (t && t.settings && t.settings.scoring === "scores" && (t.settings.bestOf || 1) === 1 && v.kind === "bracket") {
    const show = m => (m.scoreA != null ? { ...m, winsA: m.scoreA, winsB: m.scoreB } : m);
    v = { ...v, rounds: v.rounds.map(r => r.map(show)), final: v.final.map(show), losers: v.losers.map(r => r.map(show)) };
  }
  if (v.kind === "imported") {
    const ms = v.rounds.flat();
    const reset = m => m.src[0] && m.src[1] && m.src[0][0] === m.src[1][0];
    return ms.map(m => ({ ...m, sec: m.r > 0 ? "W" : m.r < 0 ? "L" : "P", col: Math.abs(m.r) - 1 + (reset(m) ? 1 : 0) }));
  }
  const k = v.rounds.length;
  const colOf = m => +m.key.slice(1).split("-")[0] - 1;
  const ms = [...v.rounds.flat().map(m => ({ ...m, sec: "W", col: colOf(m) })), ...v.final.map((m, i) => ({ ...m, sec: "W", col: k + i })),
    ...v.losers.flat().map(m => ({ ...m, sec: "L", col: colOf(m) }))]
    .filter(m => m.a !== null && m.b !== null); // byes aren't matches: that driver just shows up a round later
  const letter = i => (i >= 26 ? letter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));
  ms.forEach((m, i) => { m.code = letter(i); });
  return ms;
}

// each match sits between the two matches that feed it; a side with no feeding match in this section
// (a bye, or a driver dropping in from the winners' side) takes one slot
function treeLayout(part) {
  const byKey = new Map(part.map(m => [m.key, m]));
  const feed = (m, i) => { const s = m.src[i]; return s && !s[1] && byKey.has(s[0]) && s[0] !== m.key ? byKey.get(s[0]) : null; };
  const fed = new Set(part.flatMap(m => [feed(m, 0), feed(m, 1)]).filter(Boolean).map(m => m.key));
  const pos = new Map();
  let slot = 0;
  const place = m => {
    if (pos.has(m.key)) return pos.get(m.key);
    pos.set(m.key, null); // guards a reset match fed twice by the same final
    const ys = [0, 1].map(i => { const c = feed(m, i); return c && pos.get(c.key) !== null ? place(c) : (slot++ + 0.5) * BK.SLOT; });
    pos.set(m.key, (ys[0] + ys[1]) / 2);
    return pos.get(m.key);
  };
  part.filter(m => !fed.has(m.key)).sort((a, b) => b.col - a.col).forEach(place);
  return { pos, height: slot * BK.SLOT };
}

function canReport(t, m) {
  const ready = m.a && m.b && !m.done && t.status === "live";
  return ready && (isOrg || (me && (me.id === m.a || me.id === m.b)));
}
function bkName(id, v) {
  if (id === null) return `<span class="bk-nm"><i class="bye">bye</i></span>`;
  if (id === undefined) return `<span class="bk-nm"><i class="tbd">waiting</i></span>`;
  const seed = v.seeds.indexOf(id) + 1;
  if (seedPick.t) return `<span class="bk-nm${seedPick.sel === id ? " me" : ""}" role="button" tabindex="0" data-act="seed-pick" data-t="${seedPick.t}" data-id="${id}" title="Tap another driver to swap">${seed ? `<small>${seed}</small>` : ""}${esc(nameOf(id))}</span>`;
  if (P(id) && P(id).hidden) return `<span class="bk-nm former" title="No longer in the League">${seed ? `<small>${seed}</small>` : ""}${esc(nameOf(id))}</span>`;
  return `<span class="bk-nm${follow === id ? " me" : ""}${me && me.id === id ? " mine" : ""}" role="button" tabindex="0" data-act="follow" data-id="${id}">${seed ? `<small>${seed}</small>` : ""}${esc(nameOf(id))}</span>`;
}
function bkRows(v, m, byKey) {
  const row = (id, wins, s) => {
    // always three cells, so the score lines up on the right
    const from = `<span class="from">${s && s[1] && byKey.get(s[0]) ? `from ${esc(byKey.get(s[0]).code)}` : ""}</span>`;
    const shown = m.a != null && m.b != null && (m.done || wins) ? wins : "";
    return `<div class="bk-row${m.done && id && m.winner === id ? " w" : ""}">${bkName(id, v)}${from}<b>${shown}</b></div>`;
  };
  return row(m.a, m.winsA, m.src[0]) + row(m.b, m.winsB, m.src[1]);
}
function bkClass(t, v, m) {
  const lit = follow && (m.a === follow || m.b === follow);
  return `${m.done ? " done" : ""}${canReport(t, m) ? " ready" : ""}${v.pending.some(r => r.match_key === m.key) ? " pend" : ""}${lit ? " hl" : ""}`;
}
const reportBtn = (t, m, cls) => canReport(t, m) ? `<button type="button" class="${cls}" data-act="report" data-t="${t.id}" data-key="${esc(m.key)}" data-players="${m.a},${m.b}">Report</button>` : "";

function bracketTree(t, v, ms) {
  const byKey = new Map(ms.map(m => [m.key, m]));
  const hasL = ms.some(m => m.sec === "L");
  let html = "", svg = "", y0 = 0, w = 0;
  for (const [sec, title] of [["W", hasL ? "Winners' bracket" : ""], ["L", "Losers' bracket"]]) {
    const part = ms.filter(m => m.sec === sec);
    if (!part.length) continue;
    const L = treeLayout(part);
    if (title) html += `<div class="bk-sect" style="top:${y0}px">${title}</div>`;
    const top = y0 + (title ? 32 : 0) + BK.HEAD;
    const heads = new Map();
    for (const m of part) {
      const x = BK.PAD + m.col * BK.PITCH, y = top + L.pos.get(m.key);
      heads.set(m.col, heads.get(m.col) || m.label);
      html += `<div class="bk-m${bkClass(t, v, m)}" style="left:${x}px;top:${y - BK.H / 2}px"><span class="bk-id">${esc(m.code)}</span><div class="bk-rows">${bkRows(v, m, byKey)}</div>${reportBtn(t, m, "bk-go")}</div>`;
      m.src.forEach((s, i) => {
        const c = s && !s[1] && byKey.get(s[0]);
        if (!c || c.sec !== sec || c === m || !L.pos.has(c.key)) return;
        const x1 = BK.PAD + c.col * BK.PITCH + BK.W, y1 = top + L.pos.get(c.key), y2 = y + (i ? 13 : -13), mx = (x1 + x) / 2;
        svg += `<path class="${follow && c.winner === follow ? "hl" : ""}" d="M${x1} ${y1}H${mx}V${y2}H${x}"/>`;
      });
      w = Math.max(w, x + BK.W + BK.PAD);
    }
    for (const [c, l] of heads) html += `<div class="bk-col" style="left:${BK.PAD + c * BK.PITCH}px;top:${top - BK.HEAD + 4}px">${esc(l)}</div>`;
    y0 = top + L.height + 22;
  }
  const place = ms.filter(m => m.sec === "P");
  const placeHtml = place.length ? `<h4 class="lbh">Placement matches</h4><div class="bk-place">${place.map(m =>
    `<div><div class="bk-col">${esc(m.label)}</div><div class="bk-m${bkClass(t, v, m)}"><span class="bk-id">${esc(m.code)}</span><div class="bk-rows">${bkRows(v, m, byKey)}</div></div></div>`).join("")}</div>` : "";
  return `<div class="bk-stage"><div class="bk-tree${follow ? " has-hl" : ""}" style="width:${w}px;height:${y0}px"><svg width="${w}" height="${y0}" aria-hidden="true">${svg}</svg>${html}</div></div>${placeHtml}`;
}

function bracketCards(t, v, ms) {
  const byKey = new Map(ms.map(m => [m.key, m]));
  const rank = m => ({ W: 0, L: 1, P: 2 }[m.sec]) * 1000 + m.col;
  const groups = [];
  for (const m of ms.slice().sort((a, b) => rank(a) - rank(b))) {
    const g = groups.find(x => x.label === m.label);
    if (g) g.ms.push(m); else groups.push({ label: m.label, sec: m.sec, ms: [m] });
  }
  if (!groups.length) return "";
  // phones open on the round being played, or the last one when it's over
  let i = roundPick[t.id];
  if (i == null || i >= groups.length) {
    i = groups.findIndex(g => g.ms.some(m => m.a && m.b && !m.done));
    if (i < 0) i = groups.findIndex(g => g.sec !== "P" && g.ms.some(m => !m.done));
    if (i < 0) i = groups.filter(g => g.sec !== "P").length - 1;
  }
  const next = (m, loser) => ms.find(x => x.src.some(s => s && s[0] === m.key && s[1] === loser));
  const who = id => id ? `<b>${esc(nameOf(id))}</b>` : "The winner";
  const card = m => {
    const wn = next(m, false), ln = next(m, true);
    const win = m.done ? m.winner : null, lose = m.done ? m.loser : null;
    const goes = wn ? `${who(win)} goes to ${esc(wn.label)} (${esc(wn.code)})` : m.sec === "P" ? `${who(win)} takes ${esc(m.label.replace(/ match.*/, ""))}` : `${who(win)} wins the tournament`;
    const drops = ln ? `${lose ? who(lose) : "The loser"} drops to ${esc(ln.label)} (${esc(ln.code)})` : `${lose ? who(lose) : "The loser"} is out`;
    return `<div class="bk-card${bkClass(t, v, m)}"><div class="bk-ctop"><span>Match ${esc(m.code)}</span><span>${esc(m.label)}</span></div>${bkRows(v, m, byKey)}` +
      `<div class="bk-next"><span>${goes}</span><span>${drops}</span></div>${reportBtn(t, m, "btn small")}` +
      (v.pending.some(r => r.match_key === m.key) ? `<div class="mini warn">result waiting to be verified</div>` : "") + `</div>`;
  };
  return `<div class="bk-chips" role="group" aria-label="Rounds">${groups.map((g, n) => `<button type="button" class="${g.sec === "L" ? "lb" : ""}" aria-pressed="${n === i}" data-act="bk-round" data-t="${t.id}" data-i="${n}">${esc(g.label)}</button>`).join("")}</div>` +
    `<div class="bk-cards${follow ? " has-hl" : ""}">${groups[i].ms.map(card).join("")}</div>` +
    `<div class="bk-pager"><button type="button" class="btn ghost small" data-act="bk-round" data-t="${t.id}" data-i="${i - 1}"${i ? "" : " disabled"}>← Previous round</button>` +
    `<button type="button" class="btn ghost small" data-act="bk-round" data-t="${t.id}" data-i="${i + 1}"${i < groups.length - 1 ? "" : " disabled"}>Next round →</button></div>`;
}

function bracketView(t, v) {
  const ms = bracketModel(v, t);
  const fol = follow && P(follow) ? `<div class="bk-follow">Following <b>${esc(nameOf(follow))}</b><button type="button" class="btn ghost small" data-act="profile" data-id="${follow}">Profile</button><button type="button" class="btn ghost small" data-act="unfollow">Stop following</button></div>`
    : seedPick.t ? `<p class="mini">${seedPick.sel ? `Now tap who <b>${esc(nameOf(seedPick.sel))}</b> swaps places with.` : "Tap two drivers to swap their places."}</p>`
    : `<p class="mini">Tap a driver's name to follow their path.${ms.some(m => canReport(t, m)) ? " Matches you can report are lit up." : ""}</p>`;
  return fol + `<div class="bk-wide">${bracketTree(t, v, ms)}</div><div class="bk-narrow">${bracketCards(t, v, ms)}</div>`;
}

function standingsTable(rows, cols) {
  return `<div class="tw"><table><thead><tr><th>#</th><th>Driver</th>${cols.map(c => `<th class="num">${c[0]}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r, i) => `<tr class="${me && r.id === me.id ? "mine" : ""}"><td class="rank">${i + 1}</td><td>${P(r.id) ? who(P(r.id), { size: 20 }) : "?"}</td>${cols.map(c => `<td class="num">${c[1](r)}</td>`).join("")}</tr>`).join("") +
    `</tbody></table></div>`;
}

function renderTour() {
  const box = $("tview");
  const t = D.tournaments.find(x => x.id === openT);
  if (!t) { box.innerHTML = ""; return; }
  const v = L.tours.get(t.id);
  const st = t.settings || {};
  const entries = D.entries.filter(e => e.tournament_id === t.id);
  const mine = me && entries.find(e => e.player_id === me.id);
  const open = t.status === "signup" || t.status === "checkin";

  const facts = [t.format === "imported" ? `${st.original || "Tournament"} on Challonge` : CORE.FORMATS[t.format]];
  if (["single_elim", "double_elim", "round_robin", "swiss"].includes(t.format)) facts.push(`best of ${st.bestOf || 1}`);
  if (t.format === "heats") facts.push(`heats of ${v.heatSize}, top ${v.advance} go through, final over ${st.finalRaces || 1} race${(st.finalRaces || 1) > 1 ? "s" : ""}`);
  if (t.format === "points") facts.push(st.races ? `${st.races} races` : "races until the organiser ends it");
  if (t.format === "swiss") facts.push(`${v.total} rounds`);
  if (t.format === "double_elim") facts.push(st.gfReset === false ? "no grand final reset" : "grand final reset");
  if (st.scoring === "scores") facts.push("results by score");
  if (st.city) facts.push(st.city);
  if (st.mode) facts.push(st.mode);
  const season = D.seasons.find(s => s.id === t.season_id);
  if (season) facts.push(season.name);

  let acts = "";
  if (me && open && !mine) acts += `<button type="button" class="btn" data-act="signup" data-t="${t.id}">Sign up</button>`;
  if (mine && t.status === "checkin" && !mine.checked_in) acts += `<button type="button" class="btn hot" data-act="checkin" data-t="${t.id}">Check in</button>`;
  if (mine && open) acts += `<button type="button" class="btn ghost" data-act="dropout" data-t="${t.id}">Drop out</button>`;
  if (!store.user && open) acts += `<span class="mini">Sign in to sign up.</span>`;
  if (isOrg) acts += `<button type="button" class="btn ghost" data-act="org-edit-t" data-t="${t.id}">✎ Edit</button>`;
  if (isOrg && t.format === "imported") acts += `<button type="button" class="btn ghost danger" data-act="del-t" data-t="${t.id}">Delete</button>`;
  else if (isOrg) {
    if (t.status === "signup") acts += `<button type="button" class="btn ghost" data-act="status" data-t="${t.id}" data-s="checkin">Open check-in</button>`;
    if (open) acts += `<button type="button" class="btn hot" data-act="start" data-t="${t.id}">Start</button>`;
    if (t.status === "live") acts += `<button type="button" class="btn" data-act="status" data-t="${t.id}" data-s="done">Mark finished</button>`;
    if (t.status === "done") acts += `<button type="button" class="btn ghost" data-act="status" data-t="${t.id}" data-s="live">Reopen</button>`;
    acts += `<button type="button" class="btn ghost danger" data-act="del-t" data-t="${t.id}">Delete</button>`;
  }

  // who's in
  // before Start, organisers set the seeds: arrows here, By rating / Shuffle, or swap two in the preview
  const seeding = isOrg && open && t.format !== "imported";
  const seedList = v.seeds.map((id, i) => {
    const e = entries.find(x => x.player_id === id);
    return `<li><span class="seed">${i + 1}</span>${P(id) ? who(P(id), { size: 18 }) : "?"}${t.status === "checkin" ? (e && e.checked_in ? ` <span class="ok">checked in</span>` : ` <span class="mini">not checked in</span>`) : ""}` +
      (seeding ? ` <span class="seedctl"><button type="button" class="x" data-act="seed-move" data-t="${t.id}" data-id="${id}" data-d="-1" aria-label="Seed higher"${i ? "" : " disabled"}>▲</button>` +
        `<button type="button" class="x" data-act="seed-move" data-t="${t.id}" data-id="${id}" data-d="1" aria-label="Seed lower"${i < v.seeds.length - 1 ? "" : " disabled"}>▼</button>` +
        `<button type="button" class="x" data-act="kick" data-t="${t.id}" data-id="${id}" title="Remove">×</button></span>` : "") + `</li>`;
  }).join("");
  const seedTools = seeding && v.seeds.length > 1 ? `<div class="row seedtools"><button type="button" class="btn ghost small" data-act="seed-rating" data-t="${t.id}">By rating</button>` +
    `<button type="button" class="btn ghost small" data-act="seed-shuffle" data-t="${t.id}">Shuffle</button></div>` : "";
  const benched = open ? "" : entries.filter(e => e.seed == null).map(e => esc(nameOf(e.player_id))).join(", ");
  const addable = isOrg && open ? drivers().filter(p => !entries.some(e => e.player_id === p.id)).sort((a, b) => a.name.localeCompare(b.name)) : [];

  let body = "";
  if (!v.started) {
    const manual = entries.some(e => e.seed != null);
    body = `<p class="mini">${seeding
      ? `Set the seeds with the arrows, By rating or Shuffle${v.kind === "bracket" ? ", or tap two drivers in the preview to swap them" : ""}. Everything locks when you press Start.`
      : `${t.format === "points" || t.format === "heats" ? "Heats and seeds" : "The bracket"} are locked when the organiser presses Start.`} ` +
      `${manual ? "Seeded by the organiser." : `Seeded by rating for now${t.status === "checkin" ? ", checked-in drivers first; anyone not checked in by Start sits it out" : ""}.`}</p>`;
    if (v.kind === "bracket" && v.seeds.length >= 2) {
      seedPick.t = seeding ? t.id : null;
      body += `<h4>Bracket preview</h4>${bracketView(t, v)}`;
      seedPick.t = null;
    }
  } else if (v.kind === "points") {
    const can = t.status === "live" && (isOrg || (me && v.seeds.includes(me.id)));
    body = standingsTable(v.table, [["Points", r => `<b class="pts">${r.pts}</b>`], ["Wins", r => r.wins], ["Races", r => r.races]]) +
      `<p class="mini">${v.races.length}${v.planned ? ` of ${v.planned}` : ""} races counted. Points per place: ${POINTS.join(", ")}.</p>` +
      (can ? `<button type="button" class="btn" data-act="report" data-t="${t.id}" data-players="${v.seeds.join(",")}">Report a race</button>` : "");
  } else if (v.kind === "heats") {
    body = v.rounds.map(rd => `<div class="hround"><h4>${rd.final ? "Final" : `Round ${rd.round}`}</h4><div class="heats">` + rd.heats.map(hh => {
      const can = t.status === "live" && (isOrg || (me && hh.players.includes(me.id)));
      const label = rd.final ? `Final · ${hh.races.length}/${hh.need} races` : `Heat ${hh.heat} · top ${hh.advance} go through`;
      return `<div class="heat${hh.done ? " done" : ""}"><div class="mlabel">${label}</div>` +
        hh.table.map((r, i) => `<div class="hline${!rd.final && hh.done && i < hh.advance ? " adv" : ""}${me && r.id === me.id ? " mine" : ""}"><span class="seed">${i + 1}</span><span>${esc(nameOf(r.id))}</span><b>${r.races ? r.pts : ""}</b></div>`).join("") +
        (can && (!hh.done || rd.final) ? `<button type="button" class="btn small" data-act="report" data-t="${t.id}" data-round="${rd.round}" data-heat="${hh.heat || 1}" data-players="${hh.players.join(",")}">Report ${rd.final ? "a final race" : "heat"}</button>` : "") + `</div>`;
    }).join("") + `</div></div>`).join("");
  } else if (v.kind === "imported") {
    const link = `<p class="mini">Brought over from Challonge.${v.raceOnly ? " A free-for-all was one race, so it counts as a race: rating and race XP, no tournament XP or season points." : ""} <a href="${esc(st.url)}" target="_blank" rel="noopener">See the original</a></p>`;
    if (v.rounds.length) {
      body = bracketView(t, v) + link;
    } else {
      // free for all: one race, everyone's finishing place
      const rows = v.places.slice().sort((a, b) => a.place - b.place);
      body = `<div class="tw"><table><thead><tr><th>#</th><th>Driver</th></tr></thead><tbody>` +
        rows.map(r => `<tr class="${me && r.id === me.id ? "mine" : ""}"><td class="rank">${r.place}</td><td>${P(r.id) ? who(P(r.id), { size: 20 }) : "?"}</td></tr>`).join("") +
        `</tbody></table></div>` + link;
    }
  } else if (v.kind === "bracket") {
    body = bracketView(t, v);
  } else {
    body = standingsTable(v.table, [["W", r => `<b class="pts">${r.w}</b>`], ["L", r => r.l], ["Races", r => `${r.rw}-${r.rl}`]].concat(t.format === "swiss" ? [["Opp. wins", r => r.buch]] : [])) +
      v.rounds.map(ms => `<div class="hround"><h4>${esc(ms.length ? ms[0].label : "")}${ms.bye ? ` <span class="mini">· bye: ${esc(nameOf(ms.bye))}</span>` : ""}</h4><div class="heats">${ms.map(m => matchBox(t, m, v)).join("")}</div></div>`).join("") +
      (t.format === "swiss" && !v.done && v.rounds.length < v.total ? `<p class="mini">The next round is paired when this one is finished.</p>` : "");
  }

  let result = "";
  if (v.done) {
    const top = v.places.slice().sort((a, b) => a.place - b.place).slice(0, 4);
    result = `<div class="podium">${top.map(x => `<div class="pod p${Math.min(x.place, 4)}"><img class="cup" src="img/trophy-${Math.min(x.place, 4)}.png" alt="">${esc(ord(x.place))}<b>${esc(nameOf(x.id))}</b></div>`).join("")}</div>` +
      (t.status !== "done" ? `<p class="mini">All results are in.${isOrg ? " Mark it finished to hand out XP and season points." : " XP and season points come when an organiser marks it finished."}</p>` : "");
  }
  const pend = v.pending.map(r => raceLine(r)).join("");

  box.innerHTML = `<div class="card tcard-open">
    <div class="sec-head"><h3 class="h3">${esc(t.name)}</h3><span class="st ${t.status}">${STATUS[t.status]}</span><p class="sub">${facts.map(esc).join(" · ")}${t.starts_at ? " · starts " + fmtWhen(t.starts_at) : ""}</p></div>
    ${st.rules ? `<p class="rules">${esc(st.rules)}</p>` : ""}
    <div class="row">${acts}</div>
    ${result}
    <div class="tgrid"><div><h4>Drivers (${v.seeds.length})</h4>${seedTools}<ol class="entrants">${seedList || `<li class="none">Nobody yet.</li>`}</ol>
      ${benched ? `<p class="mini">Sat out: ${benched}</p>` : ""}
      ${addable.length ? `<div class="row"><select id="add-driver">${addable.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select><button type="button" class="btn small" data-act="add-entry" data-t="${t.id}">Add</button></div>` : ""}
    </div><div class="tbody">${body}</div></div>
    ${pend ? `<h4>Waiting to be verified</h4><div class="feed">${pend}</div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- races feed

function raceLine(r, openable) {
  const t = r.tournament_id && D.tournaments.find(x => x.id === r.tournament_id);
  const res = r.results.map(x => `<span class="${me && x.player_id === me.id ? "mine" : ""}">${x.dnf ? "DNF" : x.place + "."} ${esc(nameOf(x.player_id))}${x.score != null ? ` <b class="rscore">${x.score}</b>` : ""}</span>`);
  const shown = res.slice(0, 4).join(" ") + (res.length > 4 ? ` <span class="mini">+${res.length - 4}</span>` : "");
  const canConfirm = !r.counted && isOrg;
  const canDelete = store.user && (isOrg || (store.user.id === r.entered_by && !r.confirms.length));
  const where = [t ? t.name : "Casual", r.city, r.mode, r.race_name].filter(Boolean).map(esc).join(" · ");
  const open = openable && openRace === r.id;
  return `<div class="feed-row race${r.counted ? "" : " pending"}${open ? " open" : ""}"><span class="mini when">${fmtWhen(r.at)}</span>` +
    `<div class="what"${openable ? ` data-act="race-open" data-id="${r.id}" role="button" tabindex="0" aria-expanded="${open}" title="${open ? "Close" : "See the whole race"}"` : ""}>` +
    `<small>${where}${openable ? ` <span class="opener">${open ? "▲" : "▼"}</span>` : ""}</small><div class="res">${shown}</div>${r.note ? `<small>${esc(r.note)}</small>` : ""}</div>` +
    `<div class="ra">${r.counted ? "" : `<span class="mini warn">not verified yet</span>`}` +
    (canConfirm ? `<button type="button" class="btn small" data-act="confirm" data-id="${r.id}">Verify</button>` : "") +
    (isOrg && !r.imported ? `<button type="button" class="x" data-act="edit-race" data-id="${r.id}" title="Edit this race">✎</button>` : "") +
    (canDelete ? `<button type="button" class="x" data-act="del-race" data-id="${r.id}" title="Delete this race">×</button>` : "") + `</div></div>`;
}
// newest SENT-IN first: a race typed in today tops the list even when it was played long ago
// (Challonge imports keep their played date, so they stay below everything sent in since)
const sentAt = r => (!r.imported && Date.parse(r.created_at)) || r.at;
const bySent = () => L.races.slice().sort((a, b) => sentAt(b) - sentAt(a));
function renderRaces() {
  $("report-casual").hidden = !(me || isOrg);
  const list = bySent().slice(0, 15);
  $("race-feed").innerHTML = list.map(r => raceLine(r, true) + (openRace === r.id ? raceDetail(r) : "")).join("") ||
    `<div class="feed-row"><span class="none">No races yet.</span></div>`;
}

// a race opened from Latest races: every driver's place, score, time and car, and where it came from
const fmtTime = ms => { const cs = Math.round(ms / 10), m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60; return `${m}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const CAR_NAMES = { vpmustang99: "Mustang GT", vppanozgt: "Panoz GTR-1", vppanoz: "Panoz Roadster", vpbug: "New Beetle", vpbullet: "Mustang Fastback",
  vpford: "Ford F-350", vpcaddie: "Cadillac Eldorado", vpcop: "Police Mustang", vpbus: "City Bus", vpsemi: "Freightliner", vpmtruck: "Monster Truck", vppanozirt: "IRT Panoz GTR-1" };
const carName = car => CAR_NAMES[String(car).replace(/_\d+$/, "")] || String(car).replace(/_\d+$/, "");
function raceDetail(r) {
  const t = r.tournament_id && D.tournaments.find(x => x.id === r.tournament_id);
  const by = r.entered_by && [...L.P.values()].find(p => p.user_id === r.entered_by);
  const scores = r.results.some(x => x.score != null), times = r.results.some(x => x.time_ms), cars = r.results.some(x => x.car);
  const rows = r.results.slice().sort((a, b) => a.place - b.place).map(x => `<tr${me && x.player_id === me.id ? ` class="mine"` : ""}>` +
    `<td>${x.dnf ? `<span class="dnf">DNF</span>` : placeChip(x.place, 0)}</td><td>${P(x.player_id) && !P(x.player_id).hidden ? who(P(x.player_id), { size: 18 }) : esc(nameOf(x.player_id))}</td>` +
    (scores ? `<td class="num">${x.score != null ? x.score : "–"}</td>` : "") +
    (times ? `<td class="num">${x.time_ms ? fmtTime(x.time_ms) : "–"}</td>` : "") +
    (cars ? `<td>${x.car ? `<img class="rcar" src="img/cars/${esc(x.car)}.png" alt="${esc(carName(x.car))}" title="${esc(carName(x.car))}" onerror="this.remove()">` : ""}</td>` : "") + `</tr>`).join("");
  const facts = [t ? t.name : "Casual race", fmtWhen(r.at), by ? `entered by ${esc(by.name)}` : "", r.source === "game" ? "sent by the game" : r.imported ? "from Challonge" : "",
    r.counted ? "counted" : "waiting to be verified"].filter(Boolean);
  return `<div class="race-detail"><div class="tw"><table class="rtable"><thead><tr><th>Place</th><th>Driver</th>${scores ? `<th class="num">Score</th>` : ""}${times ? `<th class="num">Time</th>` : ""}${cars ? `<th>Car</th>` : ""}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div><p class="mini">${facts.join(" · ")}</p></div>`;
}

// ---------------------------------------------------------------- seasons

function renderSeasons() {
  if (!L.seasons.length) { $("season-tabs").innerHTML = ""; $("season-table").innerHTML = `<tbody><tr><td class="loading">No seasons yet.</td></tr></tbody>`; return; }
  if (!seasonPick || !L.seasons.some(s => s.season.id === seasonPick)) seasonPick = L.seasons[0].season.id;
  $("season-tabs").innerHTML = L.seasons.map(s => `<button type="button" role="tab" data-act="season" data-id="${s.season.id}" aria-selected="${s.season.id === seasonPick}">${esc(s.season.name)}</button>`).join("") +
    (isOrg ? `<button type="button" data-act="new-season">+ season</button>` : "");
  const s = L.seasons.find(x => x.season.id === seasonPick);
  $("season-sub").textContent = `Points from finished tournaments: ${CFG.seasonPoints.join(", ")} for 1st, 2nd, 3rd…, ${CFG.seasonEntry} for everyone else. ${s.season.starts_on ? "Started " + fmtDay(s.season.starts_on) + "." : ""}`;
  $("season-table").innerHTML = `<thead><tr><th>#</th><th>Driver</th><th class="num">Points</th><th class="num">Played</th><th class="num">Won</th><th class="num">Best</th></tr></thead><tbody>` +
    (s.table.filter(r => !P(r.id).hidden).map((r, i) => `<tr class="${me && r.id === me.id ? "mine" : ""}"><td class="rank">${i + 1}</td><td>${who(P(r.id), { size: 20 })}</td><td class="num pts">${r.pts}</td><td class="num">${r.played}</td><td class="num">${r.wins}</td><td class="num">${ord(r.best)}</td></tr>`).join("") ||
      `<tr><td colspan="6" class="loading">No finished tournaments this season yet.</td></tr>`) + "</tbody>";
}

// ---------------------------------------------------------------- profile

// a driver's racing and Cops & Robbers numbers side by side (each rated on its own)
function kindBoxes(p) {
  const min = CFG.ladderMinRaces || 3;
  const box = (k, title, cls) => {
    const s = statOf(p, k), word = gamesWord(k);
    const rated = drivers().filter(x => statOf(x, k).races >= min).sort((a, b) => statOf(b, k).ratingValue - statOf(a, k).ratingValue);
    const rank = rated.indexOf(p) + 1;
    return `<div class="kbox ${cls}"><h4>${title}</h4>` +
      `<div class="krow"><span>Rating</span><span>${s.races ? s.ratingValue : "–"}${rank ? ` · ${ord(rank)}` : ""}</span></div>` +
      `<div class="krow"><span>${word === "games" ? "Games" : "Races"}</span><span>${s.races}</span></div>` +
      `<div class="krow"><span>Wins</span><span>${s.wins}</span></div>` +
      `<div class="krow"><span>Podium rate</span><span>${s.races ? Math.round(100 * s.podiums / s.races) + "%" : "–"}</span></div></div>`;
  };
  return `<div class="kboxes">${box("race", "Racing", "kr")}${box("cnr", "Cops &amp; Robbers", "kc")}</div>`;
}

// drivers that races made (sent by the game, or typed into a report): a quick delete for typos and one-offs
const low = s => String(s || "").toLowerCase();
function newDriversHtml() {
  const made = drivers().filter(p => p.source).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!made.length) return `<h3 class="h3">New drivers from races</h3><p class="mini">None. Names a race brings in that aren't on the League show up here, to keep or delete.</p>`;
  return `<h3 class="h3">New drivers from races (${made.length})</h3>
    <p class="mini">Made when a race had a name nobody on the League uses. Keep the real ones; delete typos and one-off names (their places in those races go too). If it's someone who's already here under another name, use Merge, or add it to their "Also races as" names.</p>
    <div class="olist">${made.map(p => `<div class="trow"><span>${who(p, { size: 18 })} <span class="mini">· ${p.source === "game" ? "from the game" : "typed in a report"} · ${fmtDay(p.created_at)} · ${p.races} ${p.races === 1 ? "race" : "races"}</span></span>
      <span class="acts"><button type="button" class="btn ghost small" data-act="org-keep" data-id="${p.id}">Keep</button>
      <button type="button" class="btn ghost small danger" data-act="org-delete" data-id="${p.id}">Delete</button></span></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- game key (races sent by the game)

let gameKey = "";   // shown on your own profile once asked for
function gameKeyHtml() {
  return `<div class="gamekey"><h4>Game key</h4>
    <p class="mini">Every online race you are in (MM1 2026 with Madness HUD) goes to the League by itself: paste this into Madness HUD's Settings &gt; Race board &gt; League key. Keep it private, like a password.</p>
    ${gameKey ? `<div class="row"><code id="gk-text">${esc(gameKey)}</code><button type="button" class="btn small" data-act="game-key-copy">Copy</button>
      <button type="button" class="btn ghost small" data-act="game-key-new">Make a new key</button></div>
      <p class="mini">A new key stops the old one working (do that if someone else saw it).</p>`
    : `<button type="button" class="btn small" data-act="game-key">Show my game key</button>`}</div>`;
}
async function showGameKey(rotate) {
  if (rotate && !confirm("Make a new game key? The old one stops working, so paste the new one into the race board settings.")) return;
  try { gameKey = await store.gameKey(rotate); } catch (e) { setStatus("Couldn't get your game key (" + e.message + ").", true); return; }
  renderProfile();
}
function copyGameKey() {
  const done = () => setStatus("Game key copied.");
  if (navigator.clipboard) navigator.clipboard.writeText(gameKey).then(done, () => selectKey());
  else selectKey();
}
function selectKey() {
  const el = $("gk-text");
  if (!el) return;
  const r = document.createRange(); r.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  setStatus("Press Ctrl+C to copy the selected key.");
}

function renderProfile() {
  const s = $("profile");
  const p = openP && P(openP);
  if (!p || p.hidden) { s.hidden = true; return; }
  s.hidden = false;
  const lv = p.lv;
  const rated = drivers().filter(x => x.races >= (CFG.ladderMinRaces || 3)).sort((a, b) => b.ratingValue - a.ratingValue);
  const rank = rated.indexOf(p) + 1;
  const peak = peakOf(p) || (p.races ? 0 : 1000);
  const xb = p.xpBy;
  const src = `<a href="driver.html#d=${encodeURIComponent(p.name)}">Driver page</a>` +
    (p.src_name ? ` · <a href="index.html#player=${encodeURIComponent(p.src_name)}">Speedrun card</a>` : "");
  const canEdit = isOrg || (me && me.id === p.id);
  s.innerHTML = `<div class="sec-head"><h2>Driver</h2><button type="button" class="btn ghost small" data-act="close-p">Close</button></div>
  <div class="card">
    <div class="me-head">${emblem(lv, 72)}<div><h3 class="h3"${nameStyle(p)}>${esc(p.name)}${crewTag(p)}</h3>
      <div class="meta">${esc(lv.master ? `${lv.rank.name} · Master level ${lv.masterLevel}` : `${lv.title} · ${lv.prestige ? `Prestige ${lv.prestige} ${lv.rank.name} · ` : ""}Level ${lv.level}`)}${rank ? ` · ladder ${ord(rank)}` : ""} ${src}</div></div>
      ${canEdit || isOrg ? `<div class="me-actions">${canEdit ? `<button type="button" class="btn ghost small" data-act="edit-player" data-id="${p.id}">Edit</button>` : ""}` +
        `${isOrg ? `<button type="button" class="btn ghost small" data-act="org-merge" data-id="${p.id}">Merge</button><button type="button" class="btn ghost small danger" data-act="org-remove" data-id="${p.id}">Remove</button>` : ""}</div>` : ""}</div>
    <div class="stats">
      <div class="stat"><b>${p.races ? p.ratingValue : "–"}</b><span>rating (peak ${peak || "–"})</span></div>
      <div class="stat"><b>${p.races}</b><span>races</span></div>
      <div class="stat"><b>${p.wins}</b><span>wins</span></div>
      <div class="stat"><b>${p.podiums}</b><span>podiums</span></div>
      <div class="stat"><b>${p.beaten}</b><span>drivers beaten</span></div>
      <div class="stat"><b>${p.dnfs}</b><span>DNFs</span></div>
      <div class="stat"><b>${p.xp.toLocaleString()}</b><span>total XP</span></div>
      <div class="stat"><b>${p.tournaments.filter(x => x.place === 1).length}</b><span>tournaments won</span></div>
      <div class="stat"><b>${p.bestStreak ? p.bestStreak.n : 0}</b><span>longest win streak${p.streak > 1 ? ` (on ${p.streak} now)` : ""}</span></div>
    </div>
    ${kindBoxes(p)}
    ${me && me.id === p.id ? gameKeyHtml() : ""}
    ${ratingGraph(p)}
    ${rivalHtml(p)}
    ${h2hHtml(p)}
    <p class="mini">XP from racing ${xb.races.toLocaleString()} · wins &amp; podiums ${xb.wins.toLocaleString()} · first race of the day ${xb.daily.toLocaleString()} · match wins ${xb.matches.toLocaleString()} · tournaments ${xb.tournaments.toLocaleString()} · weekly challenges ${xb.challenges.toLocaleString()}</p>
    <div class="twocol">
      <div><h4>Tournaments</h4><div class="feed">${p.tournaments.slice().reverse().map(x => `<div class="feed-row"><span>${x.place <= 4 ? `<img class="cup" src="img/trophy-${x.place}.png" alt="">` : ""}${ord(x.place)}</span><div class="what">${esc(x.t.name)}</div><span class="mini">of ${x.of}</span></div>`).join("") || `<div class="feed-row"><span class="none">None finished yet.</span></div>`}</div></div>
      <div><h4>Recent races</h4><div class="feed">${p.recent.slice(0, 10).map(r => `<div class="feed-row">${placeChip(r.place, r.field)}<div class="what">${esc([r.race.city, r.race.mode, r.race.race_name].filter(Boolean).join(" · ") || "Race")} <small>of ${r.field} · ${fmtDay(r.race.at)}</small></div><span class="mini">${r.race.imported ? "Challonge" : `+${r.xp} XP`}</span></div>`).join("") || `<div class="feed-row"><span class="none">No races yet.</span></div>`}</div></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- rivalries (on profiles)

let h2hAll = false; // the profile's head-to-head list: top 5 or everyone
const MIN_RATED = () => CFG.ladderMinRaces || 3;
// highest rating once they had enough races for the ladder (a new driver's first races swing a lot)
const peakOf = p => p.history.slice(MIN_RATED() - 1).reduce((m, h) => Math.max(m, h.rating), 0);
const rec = (w, l) => `<span class="wl"><b>${w}</b>–${l}</span>`;

function ratingGraph(p) {
  const h = p.history;
  if (h.length < 2) return "";
  const W = 640, H = 150, L = 40, B = 20, T = 10;
  const rs = h.map(x => x.rating), lo = Math.floor(Math.min(...rs) / 100) * 100, hi = Math.ceil(Math.max(...rs) / 100) * 100 || lo + 100;
  const x = i => L + (i / (h.length - 1)) * (W - L - 6), y = r => T + (1 - (r - lo) / (hi - lo || 1)) * (H - T - B);
  const step = (hi - lo) / 100 > 6 ? 200 : 100;
  let grid = "";
  for (let r = lo; r <= hi; r += step) grid += `<line x1="${L}" x2="${W - 6}" y1="${y(r)}" y2="${y(r)}"/><text x="${L - 6}" y="${y(r) + 4}" text-anchor="end">${r}</text>`;
  const pts = h.map((pt, i) => `${x(i).toFixed(1)},${y(pt.rating).toFixed(1)}`).join(" ");
  const pk = rs.indexOf(Math.max(...rs));
  return `<div class="rgraph"><h4>Rating over ${h.length} races</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating from ${rs[0]} to ${rs[rs.length - 1]}, peak ${rs[pk]}">` +
    `<g class="grid">${grid}</g><polygon class="area" points="${x(0)},${H - B} ${pts} ${x(h.length - 1)},${H - B}"/><polyline points="${pts}"/>` +
    `<circle cx="${x(h.length - 1)}" cy="${y(rs[rs.length - 1])}" r="4"/>` +
    `<text class="lab" x="${Math.min(x(h.length - 1) - 6, W - 10)}" y="${Math.max(y(rs[rs.length - 1]) - 8, 12)}" text-anchor="end">${rs[rs.length - 1]}</text>` +
    `<text class="dates" x="${L}" y="${H - 4}">${fmtDay(h[0].at)}</text><text class="dates" x="${W - 6}" y="${H - 4}" text-anchor="end">${fmtDay(h[h.length - 1].at)}</text></svg></div>`;
}

function rivalHtml(p) {
  const r = p.rival;
  if (!r || !P(r.id)) return "";
  const lead = r.w === r.l ? "dead level" : r.w > r.l ? `${esc(p.name)} leads by ${r.w - r.l}` : `${esc(nameOf(r.id))} leads by ${r.l - r.w}`;
  return `<div class="rival"><span class="mini">Rival</span>${who(P(r.id))}<span>${rec(r.w, r.l)} in ${r.races} races together · ${lead}` +
    `${r.mw + r.ml ? ` · 1v1 matches ${rec(r.mw, r.ml)}` : ""}</span></div>`;
}

function h2hHtml(p) {
  const all = [...p.h2h.values()].filter(h => P(h.id) && !P(h.id).hidden).sort((a, b) => b.races - a.races || (b.mw + b.ml) - (a.mw + a.ml));
  if (!all.length) return "";
  const shown = h2hAll ? all : all.slice(0, 5);
  return `<div><h4>Head-to-head</h4><div class="tw"><table class="h2h"><thead><tr><th>Against</th><th class="num">Races together</th><th class="num">Won–lost</th><th class="num">1v1 matches</th></tr></thead><tbody>` +
    shown.map(h => `<tr${p.rival && p.rival.id === h.id ? ` class="is-rival"` : ""}><td>${who(P(h.id), { size: 18 })}</td><td class="num">${h.races}</td><td class="num">${rec(h.w, h.l)}</td><td class="num">${h.mw + h.ml ? rec(h.mw, h.ml) : "–"}</td></tr>`).join("") +
    `</tbody></table></div>${all.length > 5 ? `<button type="button" class="btn ghost small" data-act="h2h-all">${h2hAll ? "Show top 5" : `Show all ${all.length}`}</button>` : ""}</div>`;
}

// ---------------------------------------------------------------- records / hall of fame

function renderRecords() {
  const ps = drivers();
  // the record tiles are for racing or for Cops & Robbers (the switch); the wall, seasons and prestige roll cover everything
  const S = p => statOf(p, recKind), word = gamesWord(recKind);
  for (const b of document.querySelectorAll("[data-reckind]")) b.setAttribute("aria-pressed", String(b.dataset.reckind === recKind));
  const rated = ps.filter(p => S(p).races >= MIN_RATED());
  const top = (list, score) => list.filter(p => score(p) > 0).sort((a, b) => score(b) - score(a))[0];
  const tile = (title, p, value, detail) => `<div class="rtile"><span class="mini">${title}</span>${p ? who(p, { size: 22 }) : `<span class="none">Nobody yet</span>`}<b>${p ? value : ""}</b>${detail ? `<small>${detail}</small>` : ""}</div>`;
  const wins = top(ps, p => S(p).wins), races = top(ps, p => S(p).races), streak = top(ps, p => S(p).bestStreak ? S(p).bestStreak.n : 0);
  const peak = top(rated, p => peakOf(S(p))), tw = top(ps, p => S(p).tournaments.filter(x => x.place === 1).length);
  const u = LK[recKind] ? LK[recKind].upset : L.upset;
  const label = recKind === "cnr" ? "Cops & Robbers" : "race";
  const records = [
    tile(`Most ${label} wins`, wins, wins && S(wins).wins, wins && `from ${S(wins).races} ${word}`),
    tile(`Most ${word}`, races, races && S(races).races),
    tile("Longest win streak", streak, streak && `${S(streak).bestStreak.n} wins in a row`, streak && `${fmtDay(S(streak).bestStreak.from)} – ${fmtDay(S(streak).bestStreak.to)}`),
    tile("Highest peak rating", peak, peak && peakOf(S(peak))),
    tile("Most tournament wins", tw, tw && S(tw).tournaments.filter(x => x.place === 1).length),
    u && P(u.winner) ? `<div class="rtile"><span class="mini">Biggest upset</span>${who(P(u.winner), { size: 22 })}<b>+${u.gap}</b><small>${u.wr} beat ${esc(nameOf(u.loser))} (${u.lr}) · ${esc([D.tournaments.find(t => t.id === u.race.tournament_id)?.name, fmtDay(u.race.at)].filter(Boolean).join(" · "))}</small></div>` : tile("Biggest upset", null),
  ].join("");

  // champions: every tournament that hands out placings, newest first, and trophies per driver
  const champs = D.tournaments.map(t => ({ t, v: L.tours.get(t.id) })).filter(x => x.v.awarded)
    .map(x => ({ ...x, at: Date.parse(x.t.starts_at) || 0, podium: x.v.places.slice().sort((a, b) => a.place - b.place) }))
    .sort((a, b) => b.at - a.at);
  const cups = new Map();
  for (const c of champs) for (const x of c.podium) if (x.place <= 3) { const r = cups.get(x.id) || cups.set(x.id, [0, 0, 0]).get(x.id); r[x.place - 1]++; }
  const cupRows = [...cups.entries()].filter(([id]) => P(id) && !P(id).hidden).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || b[1][2] - a[1][2]);
  // the wall is a record, so a removed driver's wins stay on their tournament pages, not here
  const wall = champs.filter(c => { const w = c.podium.find(x => x.place === 1); return !(w && P(w.id) && P(w.id).hidden); }).map(c => { const w = c.podium.find(x => x.place === 1); return `<button type="button" class="champ" data-act="open-t" data-id="${c.t.id}"><img class="cup" src="img/trophy-1.png" alt=""><span><b>${esc(w ? nameOf(w.id) : "?")}</b><small>${esc(c.t.name)} · ${fmtDay(c.at)}${c.t.format === "imported" ? " · Challonge" : ""}</small></span></button>`; }).join("");

  // seasons: the winner of every finished season, the leader of the running one
  const today = new Date().toISOString().slice(0, 10);
  const seasons = L.seasons.map(s => {
    const lead = s.table.find(r => !P(r.id).hidden);
    const over = s.season.ends_on && s.season.ends_on < today;
    return `<div class="rtile"><span class="mini">${esc(s.season.name)} · ${over ? "champion" : "leading"}</span>${lead ? who(P(lead.id), { size: 22 }) : `<span class="none">No finished tournaments yet</span>`}<b>${lead ? lead.pts + " pts" : ""}</b></div>`;
  }).join("");

  // prestige roll: first driver to unlock each prestige (enough XP for it), from their race history
  const R = CORE.levelRules(CFG);
  const roll = [];
  for (let n = 1; n <= R.maxPrestige + 1; n++) {
    const first = ps.filter(p => p.unlocks[n]).sort((a, b) => a.unlocks[n] - b.unlocks[n])[0];
    const rank = n > R.maxPrestige ? CORE.MASTER : CORE.PRESTIGES[n];
    const fake = { prestige: Math.min(n, R.maxPrestige), level: 1, master: n > R.maxPrestige, masterLevel: 1, rank };
    roll.push(`<div class="proll${first ? "" : " empty"}">${emblem(fake, 30)}<span style="color:${rank.colour}">${esc(n > R.maxPrestige ? rank.name : `P${n} ${rank.name}`)}</span>` +
      `${first ? `<span>${who(first, { size: 18, noEmblem: true })}<small>${fmtDay(first.unlocks[n])}</small></span>` : `<small class="none">Nobody yet</small>`}</div>`);
  }

  $("records-body").innerHTML = `
    <div class="card"><h3 class="h3">All-time records</h3><div class="rtiles">${records}</div></div>
    <div class="card"><h3 class="h3">Champions wall</h3>
      <div class="twocol"><div class="champs">${wall || `<p class="none">No finished tournaments yet.</p>`}</div>
      <div><h4>Trophy cabinet</h4><div class="tw"><table><thead><tr><th>Driver</th><th class="num">1st</th><th class="num">2nd</th><th class="num">3rd</th></tr></thead><tbody>${cupRows.map(([id, c]) => `<tr><td>${who(P(id), { size: 18 })}</td><td class="num pts">${c[0]}</td><td class="num">${c[1]}</td><td class="num">${c[2]}</td></tr>`).join("")}</tbody></table></div></div></div></div>
    <div class="card"><h3 class="h3">Season winners</h3><div class="rtiles">${seasons || `<p class="none">No seasons yet.</p>`}</div></div>
    <div class="card"><h3 class="h3">Prestige roll</h3><p class="mini">The first driver to earn enough XP for each prestige.</p><div class="prolls">${roll.join("")}</div></div>`;
}

// ---------------------------------------------------------------- ranks explainer

function renderRanks() {
  const x = CFG.xp, R = CORE.levelRules(CFG);
  const fake = (prestige, level, master) => ({ prestige, level, master, masterLevel: 1, rank: master ? CORE.MASTER : CORE.PRESTIGES[prestige] });
  const lvl = [1, 11, 21, 31, 41].map(l => `<div class="embrow">${emblem(fake(0, l), 40)}<span>Levels ${l}–${Math.min(l + 9, R.max)}</span></div>`).join("");
  const pres = CORE.PRESTIGES.slice(1).map((p, i) => `<div class="embrow">${emblem(fake(i + 1, 1), 40)}<span style="color:${p.colour}">P${i + 1} ${esc(p.name)}</span></div>`).join("") +
    `<div class="embrow">${emblem(fake(R.maxPrestige, R.max, true), 40)}<span style="color:${CORE.MASTER.colour}">${CORE.MASTER.name}</span></div>`;
  const titles = CORE.LEVEL_TITLES.map(([l, t]) => `<li><b>${l}</b> ${esc(t)}</li>`).join("");
  $("ranks-body").innerHTML = `
  <div class="card"><h3 class="h3">Earning XP</h3><ul class="xp">
    <li>Finish a race <b>${x.finish}</b> (didn't finish ${x.dnf})</li><li>Every driver you beat <b>+${x.perBeaten}</b></li>
    <li>Win <b>+${x.win}</b>, 2nd or 3rd <b>+${x.podium}</b></li><li>First race of the day <b>+${x.firstOfDay}</b></li>
    <li>Win a bracket match <b>+${x.matchWin}</b></li><li>Tournament 1st / 2nd / 3rd / 4th <b>${x.tournament.join(" / ")}</b>, anyone else who finishes <b>${x.tournamentEntry}</b></li>
    <li>Weekly challenges <b>300–500</b> each, three new ones every Monday</li></ul>
    <p class="mini">Only races with 2 or more drivers that an organiser has verified count. XP never goes down.</p></div>
  <div class="card"><h3 class="h3">Levels</h3><p class="mini">${R.max} levels, ${R.perPrestige.toLocaleString()} XP from 1 to ${R.max} (about ${Math.round(R.perPrestige / 300)} races). Each level costs a bit more than the last.</p>
    <ul class="titles">${titles}</ul><div class="embs">${lvl}</div></div>
  <div class="card"><h3 class="h3">Prestige</h3><p class="mini">At level ${R.max} you can prestige: back to level 1 with a new emblem and your name in the prestige colour. Extra XP carries over. After prestige ${R.maxPrestige} at level ${R.max} you become a ${CORE.MASTER.name} and keep earning Master levels every ${R.masterStep.toLocaleString()} XP.</p>
    <div class="embs">${pres}</div></div>`;
}

// ---------------------------------------------------------------- organiser panel

// tabs: Drivers (add, rename, merge, remove, bring back, claims), Races (enter, edit, delete), Tournaments
// (new, edit, delete, seasons), Race list (what the report box offers), Changes (everything organisers did)
let orgTab = "drivers", orgFind = "", raceFilter = "", racesShown = 30;
const rlPick = { city: null, mode: "Checkpoint" };

// one line in the change log
const logChange = what => store.insert("changes", [{ what, who: (me && me.name) || (store.user && store.user.name) || "organiser" }]);
const raceText = r => r.results.map(x => `${x.dnf ? "DNF" : x.place + "."} ${nameOf(x.player_id)}${x.score != null ? " " + x.score : ""}`).join(", ");
const raceWhere = r => { const t = r.tournament_id && D.tournaments.find(x => x.id === r.tournament_id); return [t ? t.name : "casual race", r.city, r.mode, r.race_name].filter(Boolean).join(" · ") + " on " + fmtDay(r.at); };

// the report box's race list for a city and mode, as [[heading, [names]]]
function raceGroups(city, mode) {
  const rows = (D.race_list || []).filter(r => r.city === city && r.mode === mode).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const out = [];
  for (const r of rows) { const g = out.find(x => x[0] === (r.grp || "")); if (g) g[1].push(r.name); else out.push([r.grp || "", [r.name]]); }
  return out;
}

function orgDriverRows() {
  const f = orgFind.trim().toLowerCase();
  const match = p => !f || p.name.toLowerCase().includes(f);
  const row = (p, acts) => `<div class="trow${p.hidden ? " gone" : ""}"><span>${p.hidden ? `<span class="who former">${esc(p.name)}</span>` : who(p, { size: 18 })}` +
    ` <span class="mini">· ${p.races} race${p.races === 1 ? "" : "s"}${p.user_id ? " · signed in" : ""}</span></span><span class="acts">${acts}</span></div>`;
  const live = drivers().filter(match).sort((a, b) => a.name.localeCompare(b.name));
  const gone = [...L.P.values()].filter(p => p.hidden && match(p)).sort((a, b) => a.name.localeCompare(b.name));
  return live.map(p => row(p, `<button type="button" class="btn ghost small" data-act="org-rename" data-id="${p.id}">Rename</button>` +
      `<button type="button" class="btn ghost small" data-act="org-merge" data-id="${p.id}">Merge</button>` +
      `<button type="button" class="btn ghost small danger" data-act="org-remove" data-id="${p.id}">Remove</button>`)).join("") +
    (live.length ? "" : `<p class="none">No driver called that.</p>`) +
    (gone.length ? `<h4>Removed (${gone.length})</h4>` + gone.map(p => row(p, `<button type="button" class="btn small" data-act="org-restore" data-id="${p.id}">Bring back</button>`)).join("") : "");
}

function renderOrganiser() {
  const s = $("organiser");
  s.hidden = !isOrg;
  if (!isOrg) return;
  const tabs = [["drivers", "Drivers"], ["races", "Races"], ["tournaments", "Tournaments"], ["racelist", "Race list"], ["changes", "Changes"]];
  let body = "";
  if (orgTab === "drivers") {
    body = `<div class="row"><label>Find <input id="org-find" type="search" maxlength="32" placeholder="driver name" value="${esc(orgFind)}"></label>
      <label>Add a driver <input id="org-new-driver" maxlength="32" placeholder="name"></label><button type="button" class="btn ghost" data-act="org-add-driver">Add</button></div>
      <p class="mini">Merge joins two names that are one person. Removed drivers keep their name in old tournaments and races, and leave everything else.</p>
      <div class="olist" id="org-dlist">${orgDriverRows()}</div>
      ${newDriversHtml()}
      <h3 class="h3">Claims to approve${claims.length ? ` (${claims.length})` : ""}</h3>
      ${claims.length ? `<div class="feed">${claims.map(c => `<div class="feed-row"><div class="what"><b>${esc(c.discord_name || "someone")}</b> <span class="mini">on Discord wants to be</span> <b>${esc(nameOf(c.player_id))}</b></div>
        <div class="ra"><button type="button" class="btn small" data-act="claim-ok" data-id="${c.player_id}" data-u="${esc(c.user_id)}" data-av="${esc(c.avatar_url || "")}">Approve</button>
        <button type="button" class="btn ghost small" data-act="claim-no" data-id="${c.player_id}">Reject</button></div></div>`).join("")}</div>`
        : `<p class="mini">Nobody is waiting. When someone signs in and claims an existing driver (like their Challonge name), it shows up here.</p>`}`;
  } else if (orgTab === "races") {
    const list = bySent().filter(r => !raceFilter || r.results.some(x => x.player_id === raceFilter));
    body = `<div class="row"><button type="button" class="btn" data-act="report">Enter a casual race</button><button type="button" class="btn ghost" data-act="upload">Upload race files</button>
      <label>Races with <select id="org-rfilter"><option value="">everyone</option>${drivers().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}"${p.id === raceFilter ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label></div>
      <p class="mini">✎ opens a race already filled in. Challonge races can't be edited, since their brackets came from Challonge.</p>
      <div class="feed">${list.slice(0, racesShown).map(raceLine).join("") || `<div class="feed-row"><span class="none">No races.</span></div>`}</div>
      ${list.length > racesShown ? `<button type="button" class="btn ghost small" data-act="org-more-races">Show more (${list.length - racesShown} older)</button>` : ""}`;
  } else if (orgTab === "tournaments") {
    body = `<div class="row"><button type="button" class="btn" data-act="new-tournament">New tournament</button><button type="button" class="btn ghost" data-act="new-season">New season</button></div>
      <div class="olist">${D.tournaments.slice().sort(tourSort).map(t => `<div class="trow"><span><b>${esc(t.name)}</b> <span class="mini">· ${esc(STATUS[t.status])} · ${esc(t.format === "imported" ? "Challonge" : CORE.FORMATS[t.format])}${t.starts_at ? " · " + fmtDay(t.starts_at) : ""}</span></span>
        <span class="acts"><button type="button" class="btn ghost small" data-act="open-t" data-id="${t.id}">Open</button><button type="button" class="btn ghost small" data-act="org-edit-t" data-t="${t.id}">✎ Edit</button>
        <button type="button" class="btn ghost small danger" data-act="del-t" data-t="${t.id}">Delete</button></span></div>`).join("") || `<p class="none">No tournaments yet.</p>`}</div>`;
  } else if (orgTab === "racelist") {
    if (!rlPick.city) rlPick.city = CFG.cities[0];
    const groups = raceGroups(rlPick.city, rlPick.mode);
    const rows = (D.race_list || []).filter(r => r.city === rlPick.city && r.mode === rlPick.mode).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    body = `<p class="mini">These are the races the report box offers for Circuit, Checkpoint and Blitz. Renaming a race also renames every race already saved with that name.</p>
      <div class="row"><label>City <select id="rl-city">${CFG.cities.map(c => `<option${c === rlPick.city ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Mode <select id="rl-mode">${RACE_MODES.map(c => `<option${c === rlPick.mode ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label></div>
      <div class="olist">${rows.map(r => `<div class="trow"><span>${esc(r.name)}${r.grp ? ` <span class="mini">· ${esc(r.grp)}</span>` : ""} <span class="mini">· used ${D.races.filter(x => x.city === r.city && x.mode === r.mode && x.race_name === r.name).length}×</span></span>
        <span class="acts"><button type="button" class="btn ghost small" data-act="rl-rename" data-id="${r.id}">Rename</button><button type="button" class="btn ghost small danger" data-act="rl-del" data-id="${r.id}">×</button></span></div>`).join("") ||
        `<p class="none">No races for ${esc(rlPick.city)} ${esc(rlPick.mode)} yet. The report box will just ask for a name.</p>`}</div>
      <div class="row"><label>New race <input id="rl-name" maxlength="60" placeholder="e.g. Lakefront Loop"></label>
      <label>Heading (optional) <input id="rl-grp" maxlength="30" placeholder="${esc(groups.length && groups[0][0] ? groups[0][0] : "e.g. Spring")}"></label>
      <button type="button" class="btn" data-act="rl-add">Add</button></div>`;
  } else {
    const ch = (D.changes || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    body = `<p class="mini">Everything organisers changed, newest first. Entries can't be edited or deleted.</p>
      <div class="feed">${ch.slice(0, 200).map(c => `<div class="feed-row"><span class="mini when">${fmtWhen(c.created_at)}</span><div class="what"><b>${esc(c.who || "organiser")}</b> ${esc(c.what)}</div></div>`).join("") ||
        `<div class="feed-row"><span class="none">Nothing changed yet.</span></div>`}</div>`;
  }
  s.innerHTML = `<div class="sec-head"><h2>Organiser</h2><p class="sub">Only organisers see this.</p></div>
  <div class="card"><div class="otabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${orgTab === k}" data-act="org-tab" data-id="${k}">${l}${k === "drivers" && claims.length ? ` <span class="badge">${claims.length}</span>` : ""}</button>`).join("")}</div>
  <div class="obody">${body}</div></div>`;
}

// ---------------------------------------------------------------- organiser actions

function renameDriverDialog(p) {
  openDialog("Rename driver", `<label class="block">Name <input id="e-name" maxlength="32" value="${esc(p.name)}"></label>
    <p class="mini">The new name shows everywhere, old tournaments included.</p>`, "Rename", async () => {
    const name = $("e-name").value.trim();
    if (!name) throw new Error("Type a name.");
    if (name === p.name) return;
    if (D.players.some(x => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a driver called ${name}.`);
    await store.update("players", { id: p.id }, { name });
    await logChange(`renamed ${p.name} to ${name}`);
  });
}

// merge: everything of `from` moves to `into`, then `from` is deleted
function mergeDialog(from) {
  const others = drivers().filter(p => p.id !== from.id).sort((a, b) => a.name.localeCompare(b.name));
  openDialog(`Merge ${from.name}`, `<label class="block">Into <select id="m-into">${others.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
    <p class="mini">Use this when two names are the same person. Every race and tournament of <b>${esc(from.name)}</b> moves to the driver you pick, and the name ${esc(from.name)} disappears. Ratings are worked out again.</p>`, "Merge", async () => {
    const into = P($("m-into").value);
    const raceIds = new Set(D.race_results.filter(r => r.player_id === from.id).map(r => r.race_id));
    const both = D.race_results.filter(r => r.player_id === into.id && raceIds.has(r.race_id)).length;
    if (both) throw new Error(`${from.name} and ${into.name} raced each other ${both} time${both === 1 ? "" : "s"}, so they can't be the same person.`);
    const tIds = new Set(D.entries.filter(e => e.player_id === from.id).map(e => e.tournament_id));
    if (D.entries.some(e => e.player_id === into.id && tIds.has(e.tournament_id))) throw new Error(`${from.name} and ${into.name} were both in the same tournament, so they can't be the same person.`);
    if (from.user_id && into.user_id) throw new Error("Both drivers are signed in with Discord. Remove one of them instead.");
    for (const r of D.race_results.filter(r => r.player_id === from.id)) await store.update("race_results", { race_id: r.race_id, player_id: from.id }, { player_id: into.id });
    for (const e of D.entries.filter(e => e.player_id === from.id)) await store.update("entries", { tournament_id: e.tournament_id, player_id: from.id }, { player_id: into.id });
    // Challonge brackets name the drivers inside the tournament itself
    for (const t of D.tournaments.filter(t => t.format === "imported" && JSON.stringify(t.settings).includes(from.id)))
      await store.update("tournaments", { id: t.id }, { settings: JSON.parse(JSON.stringify(t.settings).split(from.id).join(into.id)) });
    if (from.user_id) { await store.update("players", { id: from.id }, { user_id: null }); await store.update("players", { id: into.id }, { user_id: from.user_id }); }
    await store.remove("players", { id: from.id });
    await logChange(`merged ${from.name} into ${into.name}`);
  });
}

function editTournamentDialog(t) {
  const st = t.settings || {};
  const seasons = D.seasons.slice().sort((a, b) => String(b.starts_on).localeCompare(String(a.starts_on)));
  const opt = (list, v) => list.map(([k, n]) => `<option value="${esc(k)}"${k === v ? " selected" : ""}>${esc(n)}</option>`).join("");
  const local = v => v ? new Date(Date.parse(v) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
  const imported = t.format === "imported";
  openDialog(`Edit ${t.name}`, `<div class="fgrid">
    <label>Name <input id="te-name" maxlength="60" value="${esc(t.name)}"></label>
    <label>Season <select id="te-season"><option value="">none</option>${opt(seasons.map(s => [s.id, s.name]), t.season_id)}</select></label>
    <label>Starts <input type="datetime-local" id="te-start" value="${local(t.starts_at)}"></label>
    ${imported ? "" : `<label>City <select id="te-city"><option value="">any</option>${opt(CFG.cities.map(c => [c, c]), st.city)}</select></label>
    <label>Mode <select id="te-mode"><option value="">any</option>${opt(CFG.modes.map(c => [c, c]), st.mode)}</select></label>
    <label>Results by <select id="te-scoring">${opt([["order", "Finishing order"], ["scores", "Scores"]], st.scoring === "scores" ? "scores" : "order")}</select></label>`}
  </div><label class="block">Rules shown to drivers <textarea id="te-rules" rows="2" maxlength="500">${esc(st.rules || "")}</textarea></label>
  <p class="mini">The format and bracket settings can't change once a tournament exists.</p>`, "Save", async () => {
    const name = $("te-name").value.trim();
    if (!name) throw new Error("Give it a name.");
    const s = { ...st };
    const set = (k, v) => { if (v) s[k] = v; else delete s[k]; };
    set("rules", $("te-rules").value.trim());
    if (!imported) { set("city", $("te-city").value); set("mode", $("te-mode").value); set("scoring", $("te-scoring").value === "scores" ? "scores" : ""); }
    await store.update("tournaments", { id: t.id }, { name, season_id: $("te-season").value || null, starts_at: $("te-start").value ? new Date($("te-start").value).toISOString() : null, settings: s });
    await logChange(name === t.name ? `edited the tournament ${name}` : `edited the tournament ${t.name} (now called ${name})`);
  });
}

function renderAll() {
  const u = store.user;
  const pend = L.races.filter(r => !r.counted).length;
  setStatus(`${drivers().length} drivers · ${L.counted.length} races counted${pend ? ` · ${pend} waiting to be verified` : ""} · ${D.tournaments.length} tournaments${u ? "" : store.demo ? "" : " · sign in with Discord to sign up and report races"}`);
  const note = $("demo-note");
  note.hidden = !store.demo;
  if (store.demo) note.innerHTML = `<b>Demo mode.</b> ${store.history ? "This is the real Madness Crew history from Challonge, so you can check it before going live. Anything you add here is just for testing." : "These drivers are crew names but the races are made up, so you can try everything."} Pick someone in <i>Try as</i> (top right) to sign up and report races; tick <i>organiser</i> to verify races and run tournaments. Changes stay in this browser only. <button type="button" class="btn ghost small" data-act="demo-reset">Reset demo</button> To go live, follow <code>LEAGUE-SETUP.md</code>.`;
  renderAccount(); renderMe(); renderLadder(); renderTourList(); renderRaces(); renderSeasons(); renderProfile(); renderRecords(); renderRanks(); renderOrganiser();
}

// ---------------------------------------------------------------- dialogs

const dlg = $("dlg"), form = $("dlg-form");
let onSubmit = null;
function openDialog(title, inner, submitText, handler) {
  form.innerHTML = `<h3 class="h3">${esc(title)}</h3>${inner}<p class="err" id="dlg-err" role="alert"></p>
    <div class="row end"><button type="button" class="btn ghost" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn hot">${esc(submitText)}</button></div>`;
  onSubmit = handler;
  dlg.showModal();
}
form.addEventListener("submit", async e => {
  e.preventDefault();
  if (!onSubmit) return;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try { await onSubmit(); dlg.close(); await refresh(); }
  catch (err) { $("dlg-err").textContent = err.message; }
  finally { btn.disabled = false; }
});

// upload race files: the files Madness HUD saves in "Madness HUD results" (one race each). Each one is
// sent the moment it's picked or dropped, and the list says what the League did with it.
function uploadDialog() {
  if (!me) { setStatus("Sign in and claim your driver first, then you can upload race files.", true); return; }
  openDialog("Upload race files", `<p class="mini">Madness HUD saves every online race in your game folder, in <b>Madness HUD results</b>. Races it couldn't send are the files at the top of that folder (sent ones move into <b>sent</b>). Pick them or drop them here. They wait for an organiser's Verify like races from the game.</p>
    <label class="drop" id="up-drop"><input type="file" id="up-files" accept=".json,application/json" multiple><span>Drop race files here, or <u>pick them</u></span></label>
    <div class="feed up-list" id="up-list"></div>`, "Done", async () => {});
  const list = $("up-list"), drop = $("up-drop");
  const send = async files => {
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "feed-row";
      row.innerHTML = `<div class="what"><b>${esc(f.name)}</b> <span class="mini">sending...</span></div>`;
      list.prepend(row);
      const say = (cls, text) => { row.querySelector(".mini").outerHTML = `<span class="mini ${cls}">${esc(text)}</span>`; };
      try {
        let race;
        try { race = JSON.parse(await f.text()); } catch (e) { throw new Error("this isn't a Madness HUD race file"); }
        if (!race || !Array.isArray(race.results) || !race.mode) throw new Error("this isn't a Madness HUD race file");
        const got = await store.submitRace({ ...race, uploaded: true });
        if (got.duplicate) say("", "Already on the League");
        else say("ok", `Added (${got.matched} drivers${got.made && got.made.length ? ", new: " + got.made.join(", ") : ""})${got.unmatched && got.unmatched.length ? " - not on the League: " + got.unmatched.join(", ") : ""}`);
      } catch (e) { say("warn", "Not added: " + e.message); }
    }
  };
  $("up-files").addEventListener("change", e => { send([...e.target.files]); e.target.value = ""; });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); send([...e.dataTransfer.files]); });
}

// report a race: drivers in finishing order (up / down buttons and a DNF box each), or by score for
// Cops & Robbers and score tournaments (highest score first)
let order = [];
let byScore = false;
const RACE_MODES = ["Circuit", "Checkpoint", "Blitz"];
function reportDialog(opt) {
  // opt.edit: an existing race to change (organisers), opened already filled in
  const old = opt.edit ? L.races.find(r => r.id === opt.edit) : null;
  if (old) Object.assign(opt, { t: old.tournament_id, key: old.match_key || undefined, round: old.round || undefined, heat: old.heat || undefined });
  const t = opt.t ? D.tournaments.find(x => x.id === opt.t) : null;
  const fixed = !!opt.players || !!(old && old.match_key);
  order = old ? old.results.map(x => ({ id: x.player_id, dnf: !!x.dnf, score: x.score != null ? String(x.score) : "" }))
    : (opt.players || (me ? [me.id] : [])).map(id => ({ id, dnf: false, score: "" }));
  const st = (t && t.settings) || {};
  const sel = (id, list, val) => `<select id="${id}">${list.map(c => `<option${c === val ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const title = t ? `${t.name}${opt.key ? " · " + (L.tours.get(t.id).all ? (L.tours.get(t.id).all[opt.key] || {}).label || opt.key : "match") : opt.round ? ` · round ${opt.round}` : ""}` : "Casual race";
  openDialog(old ? "Edit race" : "Report a race", `<p class="mini">${esc(title)}. <span id="r-how"></span>${opt.key ? " One race per report; report again for the next race of a best-of." : ""}</p>
    <div class="row"><label>City ${sel("r-city", CFG.cities, st.city || CFG.cities[0])}</label><label>Mode ${sel("r-mode", CFG.modes, st.mode || CFG.modes[0])}</label>
    <label id="r-race-w">Race <select id="r-race"></select></label><label id="r-other-w">Race name <input id="r-other" maxlength="60" placeholder="e.g. Lakefront 77"></label>
    <label>Played <input type="datetime-local" id="r-when" value="${now}"></label></div>
    <ol class="order" id="r-order"></ol>
    ${fixed ? "" : `<div class="row"><select id="r-add"></select><button type="button" class="btn small" data-act="r-add">Add driver</button>
      ${isOrg ? `<label>or a new name <input id="r-newname" maxlength="32" placeholder="not on the League yet"></label><button type="button" class="btn ghost small" data-act="r-addnew">Add new</button>` : ""}</div>`}
    <label class="block">Note (optional) <input id="r-note" maxlength="120"></label>
    ${old ? `<p class="mini">Saving replaces the old result, and the change goes in the Organiser change log.</p>` : isOrg ? "" : `<p class="mini">An organiser has to verify it before it counts.</p>`}`, old ? "Save changes" : "Save race", async () => {
    if (order.length < 2) throw new Error("A race needs at least 2 drivers.");
    // names typed in as new: make those drivers now (organisers only), then save as usual
    const fresh = order.filter(o => !o.id && o.newName);
    if (fresh.length) {
      if (!isOrg) throw new Error("Only organisers add new names.");
      const made = await store.insert("players", fresh.map(o => ({ name: o.newName, source: "report" })));
      for (const o of fresh) o.id = (made.find(m => low(m.name) === low(o.newName)) || {}).id;
      await logChange(`added ${fresh.map(o => o.newName).join(", ")} from a race report`);
    }
    if (!isOrg && !(me && order.some(o => o.id === me.id))) throw new Error("You can only report races you were in.");
    let rows;
    if (byScore) {
      if (order.some(o => o.score === "" || !Number.isFinite(+o.score))) throw new Error("Type a score for every driver.");
      // highest score first; equal scores share the place
      const s = order.map(o => ({ ...o, score: Math.round(+o.score) })).sort((a, b) => b.score - a.score);
      if (opt.key && s.length === 2 && s[0].score === s[1].score) throw new Error("The scores are level. A bracket match needs a winner.");
      rows = s.map(o => ({ player_id: o.id, place: 1 + s.filter(x => x.score > o.score).length, dnf: false, score: o.score }));
    } else {
      // finishers first, DNFs after them
      rows = order.filter(o => !o.dnf).concat(order.filter(o => o.dnf)).map((o, i) => ({ player_id: o.id, place: i + 1, dnf: o.dnf }));
    }
    const raceSel = $("r-race").value;
    const raceName = $("r-race-w").hidden && $("r-other-w").hidden ? null : (raceSel && raceSel !== "__other" ? raceSel : $("r-other").value.trim() || null);
    const fields = { city: $("r-city").value, mode: $("r-mode").value, race_name: raceName, played_at: new Date($("r-when").value).toISOString(), note: $("r-note").value.trim() || null };
    if (old) {
      await store.update("races", { id: old.id }, fields);
      await store.remove("race_results", { race_id: old.id });
      await store.insert("race_results", rows.map(r => ({ race_id: old.id, ...r })));
      const now = rows.map(r => `${r.dnf ? "DNF" : r.place + "."} ${nameOf(r.player_id)}${r.score != null ? " " + r.score : ""}`).join(", ");
      await logChange(`changed the ${raceWhere(old)}: ${raceText(old)} → ${now}`);
      return;
    }
    const [race] = await store.insert("races", [{
      tournament_id: t ? t.id : null, season_id: t ? t.season_id : (L.seasons[0] ? L.seasons[0].season.id : null),
      match_key: opt.key || null, round: opt.round ? +opt.round : null, heat: opt.heat ? +opt.heat : null,
      ...fields, entered_by: store.user.id,
    }]);
    await store.insert("race_results", rows.map(r => ({ race_id: race.id, ...r })));
  });
  // the race list follows the city and mode; scores show for Cops & Robbers and score tournaments
  const sync = () => {
    const mode = $("r-mode").value, city = $("r-city").value;
    byScore = st.scoring === "scores" || mode === "Cops & Robbers";
    $("r-how").textContent = byScore ? "Type each driver's score; the highest wins." : "Put the drivers in finishing order.";
    const groups = RACE_MODES.includes(mode) ? raceGroups(city, mode) : [];
    $("r-race").innerHTML = `<option value="">pick a race (optional)</option>` + groups.map(([g, names]) =>
      (g ? `<optgroup label="${esc(g)}">` : "") + names.map(n => `<option>${esc(n)}</option>`).join("") + (g ? "</optgroup>" : "")).join("") +
      `<option value="__other">Other: type a name…</option>`;
    $("r-race-w").hidden = !groups.length;
    $("r-other-w").hidden = !RACE_MODES.includes(mode) || (groups.length > 0 && $("r-race").value !== "__other");
    drawOrder(fixed);
  };
  $("r-city").addEventListener("change", sync);
  $("r-mode").addEventListener("change", sync);
  $("r-race").addEventListener("change", () => { $("r-other-w").hidden = $("r-race").value !== "__other"; if (!$("r-other-w").hidden) $("r-other").focus(); });
  if (old) {
    // fill in what was saved
    if (old.city && CFG.cities.includes(old.city)) $("r-city").value = old.city;
    if (old.mode && CFG.modes.includes(old.mode)) $("r-mode").value = old.mode;
    sync();
    if (old.race_name) {
      if ([...$("r-race").options].some(o => o.value === old.race_name)) $("r-race").value = old.race_name;
      else { $("r-race").value = "__other"; $("r-other").value = old.race_name; }
      if (!$("r-race-w").hidden) $("r-other-w").hidden = $("r-race").value !== "__other";
    }
    $("r-when").value = new Date(old.at - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    $("r-note").value = old.note || "";
    return;
  }
  sync();
}
function drawOrder(fixed) {
  const ol = $("r-order");
  if (!ol) return;
  ol.innerHTML = order.map((o, i) => byScore
    ? `<li><span class="seed">${i + 1}</span><span class="nm">${esc(o.newName ? o.newName + " (new)" : nameOf(o.id))}</span>
      <label class="mini">Score <input class="r-score" type="number" inputmode="numeric" data-i="${i}" value="${esc(o.score)}" aria-label="${esc(o.newName ? o.newName + " (new)" : nameOf(o.id))}'s score"></label>
      ${fixed ? "" : `<button type="button" class="x" data-act="r-remove" data-i="${i}" aria-label="Remove">×</button>`}</li>`
    : `<li><span class="seed">${i + 1}</span><span class="nm">${esc(o.newName ? o.newName + " (new)" : nameOf(o.id))}</span>
    <button type="button" class="x" data-act="r-up" data-i="${i}" aria-label="Move up"${i ? "" : " disabled"}>▲</button>
    <button type="button" class="x" data-act="r-down" data-i="${i}" aria-label="Move down"${i < order.length - 1 ? "" : " disabled"}>▼</button>
    <label class="mini"><input type="checkbox" data-act="r-dnf" data-i="${i}"${o.dnf ? " checked" : ""}> DNF</label>
    ${fixed ? "" : `<button type="button" class="x" data-act="r-remove" data-i="${i}" aria-label="Remove">×</button>`}</li>`).join("");
  ol.dataset.fixed = fixed ? "1" : "";
  const add = $("r-add");
  if (add) add.innerHTML = drivers().filter(p => !order.some(o => o.id === p.id)).sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
}

function tournamentDialog() {
  const seasons = D.seasons.slice().sort((a, b) => String(b.starts_on).localeCompare(String(a.starts_on)));
  const opt = (list, v) => list.map(([k, n]) => `<option value="${esc(k)}"${k === v ? " selected" : ""}>${esc(n)}</option>`).join("");
  openDialog("New tournament", `<div class="fgrid">
    <label>Name <input id="t-name" required maxlength="60" placeholder="Friday Night Madness"></label>
    <label>Format <select id="t-format">${opt(Object.entries(CORE.FORMATS).filter(([k]) => k !== "imported"), "double_elim")}</select></label>
    <label>Season <select id="t-season"><option value="">none</option>${opt(seasons.map(s => [s.id, s.name]), seasons[0] && seasons[0].id)}</select></label>
    <label>Starts <input type="datetime-local" id="t-start"></label>
    <label>City <select id="t-city"><option value="">any</option>${opt(CFG.cities.map(c => [c, c]))}</select></label>
    <label>Mode <select id="t-mode"><option value="">any</option>${opt(CFG.modes.map(c => [c, c]))}</select></label>
    <label>Results by <select id="t-scoring">${opt([["order", "Finishing order"], ["scores", "Scores"]], "order")}</select></label>
    <label data-f="single_elim double_elim round_robin swiss">Best of <select id="t-bo">${opt([["1", "1 race"], ["3", "3 races"], ["5", "5 races"]], "1")}</select></label>
    <label data-f="double_elim"><span><input type="checkbox" id="t-reset" checked> Grand final reset</span></label>
    <label data-f="heats">Drivers per heat <input type="number" id="t-heat" min="2" max="16" value="8"></label>
    <label data-f="heats">Go through per heat <input type="number" id="t-adv" min="1" max="15" value="4"></label>
    <label data-f="heats">Races in the final <input type="number" id="t-fin" min="1" max="10" value="1"></label>
    <label data-f="points">Races <input type="number" id="t-races" min="0" max="50" value="5"></label>
    <label data-f="swiss">Rounds <input type="number" id="t-rounds" min="1" max="12" placeholder="auto"></label>
  </div><label class="block">Rules shown to drivers (optional) <textarea id="t-rules" rows="2" maxlength="500" placeholder="Stock cars only, no shortcuts through the park…"></textarea></label>
  <p class="mini" id="t-help"></p>`, "Create", async () => {
    const f = $("t-format").value;
    const s = {};
    if ($("t-city").value) s.city = $("t-city").value;
    if ($("t-mode").value) s.mode = $("t-mode").value;
    if ($("t-rules").value.trim()) s.rules = $("t-rules").value.trim();
    if ($("t-scoring").value === "scores") s.scoring = "scores";
    if (["single_elim", "double_elim", "round_robin", "swiss"].includes(f)) s.bestOf = +$("t-bo").value;
    if (f === "double_elim") s.gfReset = $("t-reset").checked;
    if (f === "heats") { s.heatSize = +$("t-heat").value; s.advance = +$("t-adv").value; s.finalRaces = +$("t-fin").value; if (s.advance >= s.heatSize) throw new Error("Fewer drivers must go through than are in a heat."); }
    if (f === "points") s.races = +$("t-races").value;
    if (f === "swiss" && $("t-rounds").value) s.rounds = +$("t-rounds").value;
    const name = $("t-name").value.trim();
    if (!name) throw new Error("Give it a name.");
    const [t] = await store.insert("tournaments", [{ name, format: f, season_id: $("t-season").value || null, starts_at: $("t-start").value ? new Date($("t-start").value).toISOString() : null, status: "signup", settings: s }]);
    openT = t.id;
  });
  const help = {
    points: "Every driver races every race; points per place from crew.js. Set Races to 0 to keep going until you mark it finished.",
    heats: "Big fields: drivers are split into heats by rating, the top finishers of each heat go through, until one final heat is left.",
    single_elim: "One-on-one bracket, lose once and you're out. Byes fill an uneven field.",
    double_elim: "One-on-one bracket with a losers' bracket: you're out after two losses. Like Challonge's double elimination.",
    round_robin: "Everyone races everyone one-on-one; most wins takes it.",
    swiss: "One-on-one rounds where drivers with the same record meet; nobody is knocked out. Good for big groups in a fixed number of rounds.",
  };
  const sync = () => {
    const f = $("t-format").value;
    for (const el of form.querySelectorAll("[data-f]")) el.hidden = !el.dataset.f.split(" ").includes(f);
    $("t-help").textContent = help[f];
  };
  $("t-format").addEventListener("change", sync);
  // Cops & Robbers tournaments are reported by score (it can still be switched back)
  $("t-mode").addEventListener("change", () => { $("t-scoring").value = $("t-mode").value === "Cops & Robbers" ? "scores" : "order"; });
  sync();
}

// ---------------------------------------------------------------- actions

// save a seed order before Start (ids best first), or null to go back to seeding by rating
async function writeSeeds(tid, ids) {
  const es = D.entries.filter(e => e.tournament_id === tid);
  for (const e of es) {
    const seed = ids ? ids.indexOf(e.player_id) + 1 || null : null;
    if (e.seed !== seed) await store.update("entries", { tournament_id: tid, player_id: e.player_id }, { seed });
  }
}

async function act(fn) {
  try { await fn(); await refresh(); }
  catch (e) { setStatus("That didn't work: " + e.message, true); }
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id, tid = b.dataset.t;
  if (a === "r-dnf") { order[+b.dataset.i].dnf = b.checked; return; }
  switch (a) {
    case "signin": store.signIn(); break;
    case "signout": act(() => store.signOut()); break;
    case "profile": openP = id; renderProfile(); history.replaceState(null, "", "#p=" + id); $("profile").scrollIntoView(); break;
    case "game-key": case "game-key-new": showGameKey(a === "game-key-new"); break;
    case "race-open": openRace = openRace === id ? null : id; renderRaces(); break;
    case "game-key-copy": copyGameKey(); break;
    case "close-p": openP = null; renderProfile(); history.replaceState(null, "", location.pathname); break;
    case "open-t":
      openT = openT === id ? null : id; renderTourList();
      history.replaceState(null, "", openT ? "#t=" + openT : location.pathname);
      if (openT) $("tview").scrollIntoView({ block: "nearest" });
      break;
    case "season": seasonPick = id; renderSeasons(); break;
    case "old-t": showOldT = true; renderTourList(); break;
    case "follow": follow = follow === id ? null : id; renderTour(); break;
    case "unfollow": follow = null; renderTour(); break;
    case "h2h-all": h2hAll = !h2hAll; renderProfile(); break;
    case "seed-move": {
      const s = L.tours.get(tid).seeds.slice(), i = s.indexOf(id), j = i + +b.dataset.d;
      if (j < 0 || j >= s.length) break;
      [s[i], s[j]] = [s[j], s[i]];
      act(() => writeSeeds(tid, s)); break;
    }
    case "seed-rating": act(() => writeSeeds(tid, null)); break;
    case "seed-shuffle": {
      const s = L.tours.get(tid).seeds.slice();
      for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
      act(() => writeSeeds(tid, s)); break;
    }
    case "seed-pick": {
      if (!seedPick.sel || seedPick.sel === id) { seedPick.sel = seedPick.sel === id ? null : id; renderTour(); break; }
      const s = L.tours.get(tid).seeds.slice(), i = s.indexOf(seedPick.sel), j = s.indexOf(id);
      seedPick.sel = null;
      [s[i], s[j]] = [s[j], s[i]];
      act(() => writeSeeds(tid, s)); break;
    }
    case "bk-round": roundPick[tid] = +b.dataset.i; renderTour(); break;
    // organisers take a driver straight away; everyone else asks and waits for an organiser
    case "claim": act(() => store.update("players", { id: $("claim-pick").value }, isOrg ? { user_id: store.user.id, avatar_url: store.user.avatar || null } : { claim_by: store.user.id })); break;
    case "claim-cancel": act(() => store.update("players", { id }, { claim_by: null })); break;
    case "claim-ok": act(() => store.update("players", { id }, { user_id: b.dataset.u, claim_by: null, ...(b.dataset.av ? { avatar_url: b.dataset.av } : {}) })); break;
    case "claim-no": act(() => store.update("players", { id }, { claim_by: null })); break;
    case "create-me": act(() => {
      const name = $("new-name").value.trim();
      if (!name) throw new Error("Pick a name.");
      return store.insert("players", [{ name, user_id: store.user.id, avatar_url: store.user.avatar || null }]);
    }); break;
    case "prestige":
      if (confirm(`Prestige now? You go back to level 1 with the ${CORE.PRESTIGES[me.lv.prestige + 1].name} emblem. Your XP, rating and stats stay.`))
        act(() => store.update("players", { id: me.id }, { prestige: me.lv.prestige + 1 }));
      break;
    case "signup": act(() => store.insert("entries", [{ tournament_id: tid, player_id: me.id }])); break;
    case "checkin": act(() => store.update("entries", { tournament_id: tid, player_id: me.id }, { checked_in: true })); break;
    case "dropout": act(() => store.remove("entries", { tournament_id: tid, player_id: me.id })); break;
    case "kick": act(() => store.remove("entries", { tournament_id: tid, player_id: id })); break;
    case "add-entry": act(() => store.insert("entries", [{ tournament_id: tid, player_id: $("add-driver").value, checked_in: true }])); break;
    case "status": act(() => store.update("tournaments", { id: tid }, { status: b.dataset.s })); break;
    case "start": act(async () => {
      const t = D.tournaments.find(x => x.id === tid);
      const v = L.tours.get(tid);
      const entries = D.entries.filter(x => x.tournament_id === tid);
      const inn = v.seeds.filter(pid => t.status !== "checkin" || (entries.find(x => x.player_id === pid) || {}).checked_in);
      if (inn.length < 2) throw new Error("It needs at least 2 drivers" + (t.status === "checkin" ? " checked in." : "."));
      if (!confirm(`Start ${t.name} with ${inn.length} drivers? Seeds are locked from here.`)) return;
      for (let i = 0; i < inn.length; i++) await store.update("entries", { tournament_id: tid, player_id: inn[i] }, { seed: i + 1 });
      // anyone sitting out loses a seed the organiser gave them before Start
      for (const e of entries) if (!inn.includes(e.player_id) && e.seed != null) await store.update("entries", { tournament_id: tid, player_id: e.player_id }, { seed: null });
      await store.update("tournaments", { id: tid }, { status: "live" });
    }); break;
    case "del-t": if (confirm("Delete this tournament and all its races? This can't be undone.")) act(async () => {
      const t = D.tournaments.find(x => x.id === tid);
      await store.remove("tournaments", { id: tid }); openT = null;
      if (isOrg) await logChange(`deleted the tournament ${t.name}`);
    }); break;
    case "report": reportDialog({ t: tid, key: b.dataset.key, round: b.dataset.round, heat: b.dataset.heat, players: b.dataset.players ? b.dataset.players.split(",") : null }); break;
    case "upload": uploadDialog(); break;
    case "confirm": act(() => store.insert("race_confirms", [{ race_id: id, user_id: store.user.id }])); break;
    case "del-race": if (confirm("Delete this race?")) act(async () => {
      const r = L.races.find(x => x.id === id);
      await store.remove("races", { id });
      if (isOrg) await logChange(`deleted the ${raceWhere(r)}: ${raceText(r)}`);
    }); break;
    case "edit-race": reportDialog({ edit: id }); break;
    case "org-tab": orgTab = id; renderOrganiser(); break;
    case "org-more-races": racesShown += 50; renderOrganiser(); break;
    case "org-rename": renameDriverDialog(P(id)); break;
    case "org-merge": mergeDialog(P(id)); break;
    case "org-remove": {
      const p = P(id);
      if (confirm(`Remove ${p.name} from the League? Their name stays in old tournaments and races; everything else about them goes. You can bring them back from Organiser > Drivers.`))
        act(async () => {
          await store.update("players", { id }, { hidden: true, avatar_url: null, src_name: null, user_id: null, claim_by: null });
          await logChange(`removed ${p.name}`);
          if (openP === id) openP = null;
        });
      break;
    }
    case "org-restore": { const p = P(id); act(async () => { await store.update("players", { id }, { hidden: false }); await logChange(`brought back ${p.name}`); }); break; }
    case "org-edit-t": editTournamentDialog(D.tournaments.find(x => x.id === tid)); break;
    case "rl-add": act(async () => {
      const name = $("rl-name").value.trim(), grp = $("rl-grp").value.trim() || null;
      if (!name) throw new Error("Type the race name first.");
      const same = (D.race_list || []).filter(r => r.city === rlPick.city && r.mode === rlPick.mode);
      if (same.some(r => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already on the list.`);
      await store.insert("race_list", [{ city: rlPick.city, mode: rlPick.mode, grp, name, sort: same.reduce((m, r) => Math.max(m, r.sort), 0) + 1 }]);
      await logChange(`added the race ${name} (${rlPick.city} ${rlPick.mode})`);
    }); break;
    case "rl-del": {
      const r = D.race_list.find(x => x.id === id);
      if (confirm(`Take ${r.name} off the list? Races already saved keep the name.`))
        act(async () => { await store.remove("race_list", { id }); await logChange(`took ${r.name} off the race list (${r.city} ${r.mode})`); });
      break;
    }
    case "rl-rename": {
      const r = D.race_list.find(x => x.id === id);
      const used = D.races.filter(x => x.city === r.city && x.mode === r.mode && x.race_name === r.name);
      openDialog(`Rename ${r.name}`, `<label class="block">Name <input id="rl-new" maxlength="60" value="${esc(r.name)}"></label>
        <label class="block">Heading (optional) <input id="rl-newgrp" maxlength="30" value="${esc(r.grp || "")}"></label>
        <p class="mini">${used.length ? `${used.length} saved race${used.length === 1 ? "" : "s"} will be renamed too.` : "No saved races use this name yet."}</p>`, "Rename", async () => {
        const name = $("rl-new").value.trim(), grp = $("rl-newgrp").value.trim() || null;
        if (!name) throw new Error("Type a name.");
        await store.update("race_list", { id }, { name, grp });
        for (const x of used) await store.update("races", { id: x.id }, { race_name: name });
        if (name !== r.name) await logChange(`renamed the race ${r.name} to ${name} (${r.city} ${r.mode}, ${used.length} saved race${used.length === 1 ? "" : "s"})`);
      });
      break;
    }
    case "new-tournament": tournamentDialog(); break;
    case "new-season":
      openDialog("New season", `<label class="block">Name <input id="s-name" maxlength="40" value="Season ${D.seasons.length + 1}"></label><label class="block">Starts <input type="date" id="s-start" value="${new Date().toISOString().slice(0, 10)}"></label>`, "Create", async () => {
        const [s] = await store.insert("seasons", [{ name: $("s-name").value.trim() || "Season", starts_on: $("s-start").value }]);
        seasonPick = s.id;
      });
      break;
    case "org-keep": act(() => store.update("players", { id }, { source: null })); break;
    case "org-delete": {
      const p = P(id);
      if (confirm(`Delete ${p.name}? ${p.races ? `Their place in ${p.races} ${p.races === 1 ? "race" : "races"} goes too. ` : ""}This can't be undone.`))
        act(async () => { await store.remove("players", { id }); await logChange(`deleted driver ${p.name}`); });
      break;
    }
    case "org-add-driver": act(() => {
      const name = $("org-new-driver").value.trim();
      if (!name) throw new Error("Type a name first.");
      return store.insert("players", [{ name }]);
    }); break;
    case "edit-player": {
      const p = P(id);
      openDialog("Edit driver", `<label class="block">Name <input id="e-name" maxlength="32" value="${esc(p.name)}"></label>
        <label class="block">speedrun.com name (links their speedrun card) <input id="e-src" maxlength="40" value="${esc(p.src_name || "")}"></label>
        <label class="block">Also races as <input id="e-aliases" maxlength="200" value="${esc((p.aliases || []).join(", "))}" placeholder="e.g. TigerHawk[MC], THawk"></label>
        <p class="mini">Other names they use in the game, with a comma between them. Races sent by the game under any of them count for ${esc(p.name)}.</p>`, "Save", () => {
        const aliases = [...new Set($("e-aliases").value.split(",").map(a => a.trim()).filter(Boolean).map(a => a.slice(0, 32)))];
        const taken = aliases.find(a => drivers().some(x => x.id !== id && (low(x.name) === low(a) || (x.aliases || []).some(y => low(y) === low(a)))));
        if (taken) throw new Error(`"${taken}" is already another driver's name.`);
        return store.update("players", { id }, { name: $("e-name").value.trim() || p.name, src_name: $("e-src").value.trim() || null, aliases });
      });
      break;
    }
    case "dlg-cancel": dlg.close(); break;
    case "r-up": { const i = +b.dataset.i; [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawOrder($("r-order").dataset.fixed); break; }
    case "r-down": { const i = +b.dataset.i; [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawOrder($("r-order").dataset.fixed); break; }
    case "r-remove": order.splice(+b.dataset.i, 1); drawOrder(false); break;
    case "r-add": if ($("r-add").value) { order.push({ id: $("r-add").value, dnf: false }); drawOrder(false); } break;
    case "r-addnew": {
      // organisers: a name that isn't on the League yet; the driver is made when the race is saved
      const name = $("r-newname").value.trim().slice(0, 32);
      if (!name) break;
      const known = drivers().find(x => low(x.name) === low(name) || (x.aliases || []).some(y => low(y) === low(name)));
      if (known) { if (!order.some(o => o.id === known.id)) order.push({ id: known.id, dnf: false }); }
      else if (!order.some(o => o.newName && low(o.newName) === low(name))) order.push({ id: null, newName: name, dnf: false, score: "" });
      $("r-newname").value = "";
      drawOrder(false);
      break;
    }
    case "demo-reset": if (confirm("Put the demo back to how it started?")) act(() => store.reset()); break;
  }
});
document.addEventListener("input", e => {
  if (e.target.classList && e.target.classList.contains("r-score")) order[+e.target.dataset.i].score = e.target.value;
  // typing in Organiser > Drivers > Find only redraws the list, so the box keeps focus
  if (e.target.id === "org-find") { orgFind = e.target.value; $("org-dlist").innerHTML = orgDriverRows(); }
});
// names in brackets are tappable spans: Enter / Space work like a click
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("span[data-act], div[role=button][data-act]")) { e.preventDefault(); e.target.click(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "org-rfilter") { raceFilter = e.target.value; racesShown = 30; renderOrganiser(); return; }
  if (e.target.id === "rl-city" || e.target.id === "rl-mode") { rlPick.city = $("rl-city").value; rlPick.mode = $("rl-mode").value; renderOrganiser(); return; }
  if (e.target.id === "demo-as" || e.target.id === "demo-org") {
    const who = $("demo-as").value;
    if (who) store.signInAs(who, $("demo-org").checked); else store.signOut();
    refresh();
  }
});
for (const b of document.querySelectorAll("[data-sort]")) b.addEventListener("click", () => { ladderSort = b.dataset.sort; renderLadder(); });
for (const b of document.querySelectorAll("[data-kind]")) b.addEventListener("click", () => {
  ladderKind = b.dataset.kind;
  try { localStorage.setItem("madness-league-kind", ladderKind); } catch (e) { /* fine */ }
  renderLadder();
});
for (const b of document.querySelectorAll("[data-reckind]")) b.addEventListener("click", () => { recKind = b.dataset.reckind; renderRecords(); });
$("new-tournament").addEventListener("click", tournamentDialog);
$("report-casual").addEventListener("click", () => reportDialog({}));

// ---------------------------------------------------------------- start

(async function start() {
  if (CREWCFG.name) $("site-name").textContent = CREWCFG.name;
  if (!CORE) { setStatus("league-core.js didn't load.", true); return; }
  if (CFG.supabaseUrl && !window.supabase) setStatus("Couldn't load the database library; showing the demo.", true);
  if (store.init) await store.init();
  await refresh();
  const m = location.hash.match(/^#([tp])=(.+)$/);
  if (m && m[1] === "t" && D.tournaments.some(t => t.id === m[2])) { openT = m[2]; renderTourList(); $("tview").scrollIntoView(); }
  if (m && m[1] === "p" && L.P.has(m[2])) { openP = m[2]; renderProfile(); $("profile").scrollIntoView(); }
  let timer = null;
  store.onChange(() => { clearTimeout(timer); timer = setTimeout(refresh, 400); });
})();
