// Madness Crew League - DEMO DATA. Used only while league-config.js has no Supabase details: the real
// Challonge history from league-history.js when it's there, otherwise made-up races between crew
// names, so the page can be tried out. Changes made in demo mode stay in your own
// browser (localStorage) and "Reset demo" puts it back. Once the league is connected to Supabase
// this file is not used.
"use strict";

(function () {
  const H = window.LEAGUE_HISTORY;
  const KEY = H ? "madness-league-history-v6" : "madness-league-demo-v1";

  // small fixed random generator, so every fresh demo looks the same
  let seed = 1560;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const uid = () => "d" + Math.floor(rnd() * 1e12).toString(36) + Math.floor(rnd() * 1e12).toString(36);

  // the real Challonge history (league-history.js), with demo sign-ins: TigerHawk is u-0, the organiser
  function fromHistory() {
    const D = JSON.parse(JSON.stringify(H));
    D.players.sort((a, b) => (b.name === "TigerHawk") - (a.name === "TigerHawk") || a.name.localeCompare(b.name));
    // regulars get a demo sign-in; one-timers stay unclaimed so claiming can be tried out
    const times = id => D.entries.filter(e => e.player_id === id).length;
    D.players.forEach((p, i) => { p.user_id = times(p.id) >= 2 && !p.hidden ? "u-" + i : null; });
    D.organisers = [{ user_id: "u-0" }];
    D.race_confirms = [];
    // somewhere for new test races to go
    D.seasons.push({ id: "demo-season-1", name: "Season 1", starts_on: new Date().toISOString().slice(0, 10), ends_on: null, created_at: new Date().toISOString() });
    return withLists(D);
  }

  // the race list starts from league-config.js (like schema.sql does live); the change log starts empty
  function withLists(D) {
    D.race_list = [];
    const list = (window.LEAGUE && window.LEAGUE.raceList) || {};
    for (const [city, modes] of Object.entries(list)) for (const [mode, v] of Object.entries(modes)) {
      const groups = Array.isArray(v) ? [[null, v]] : Object.entries(v);
      let n = 0;
      for (const [grp, names] of groups) for (const name of names) D.race_list.push({ id: "rl" + D.race_list.length, city, mode, grp, name, sort: ++n, created_at: new Date().toISOString() });
    }
    D.changes = [];
    return D;
  }

  function fresh() {
    if (H) return fromHistory();
    seed = 1560;
    const names = ["TigerHawk", "dading", "PhFoxy", "MadManMammoth", "xVJx", "jNoctal", "SweetPieCynthia", "fatiyesman",
      "KcRobin", "ScaredOwnage", "chargerbandit", "Mazik", "Swaggles", "SimonMV", "TacoTE", "EndlessSummer"];
    const skill = {};
    const players = names.map((name, i) => {
      skill[name] = 1 + rnd() * 3;
      return { id: uid(), name, user_id: "u-" + i, avatar_url: null, src_name: name, prestige: 0, created_at: new Date(Date.now() - 90 * 864e5).toISOString() };
    });
    const D = { players, organisers: [{ user_id: "u-0" }], seasons: [], tournaments: [], entries: [], races: [], race_results: [], race_confirms: [] };
    const s1 = { id: uid(), name: "Season 1", starts_on: iso(-70).slice(0, 10), ends_on: null, created_at: iso(-70) };
    D.seasons.push(s1);
    const cities = ["Chicago", "Chicago", "Chicago", "Madness City", "Heartbreak Heights"];
    const modes = ["Circuit", "Checkpoint", "Blitz"];

    // finish order: skill plus luck
    const order = ids => ids.map(id => [id, skill[D.players.find(p => p.id === id).name] + rnd() * 2.2]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    function race(ids, at, extra) {
      const r = { id: uid(), tournament_id: null, season_id: s1.id, match_key: null, round: null, heat: null, city: pick(cities), mode: pick(modes),
        played_at: at, entered_by: "u-0", note: null, created_at: at, ...extra };
      D.races.push(r);
      // the odd driver doesn't finish; finishers get places 1, 2, 3... and DNFs come after them
      const o = order(ids).map(id => ({ id, dnf: rnd() < 0.05 }));
      o.filter(x => !x.dnf).concat(o.filter(x => x.dnf)).forEach((x, i) => D.race_results.push({ race_id: r.id, player_id: x.id, place: i + 1, dnf: x.dnf, time_ms: null }));
      return r;
    }
    const ids = players.map(p => p.id);
    // casual race nights over the last ten weeks
    for (let d = -68; d <= -1; d += 2 + Math.floor(rnd() * 3)) {
      const n = 3 + Math.floor(rnd() * 6);
      for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) {
        const field = ids.slice().sort(() => rnd() - 0.5).slice(0, n);
        race(field, iso(d, 20 + k));
      }
    }
    // a finished points series
    const t1 = tour("Chicago Points Cup", "points", "done", -40, { races: 4, city: "Chicago" });
    const t1ids = ids.slice(0, 10);
    t1ids.forEach((id, i) => D.entries.push({ tournament_id: t1.id, player_id: id, checked_in: true, seed: i + 1, created_at: iso(-45) }));
    for (let k = 0; k < 4; k++) race(t1ids, iso(-40, 20 + k), { tournament_id: t1.id, city: "Chicago", mode: modes[k % 3] });

    // a live double elimination with some matches played
    const t2 = tour("Madness Crew Double Elim #3", "double_elim", "live", -2, { bestOf: 1, gfReset: true });
    const t2ids = ids.slice(0, 8);
    t2ids.forEach((id, i) => D.entries.push({ tournament_id: t2.id, player_id: id, checked_in: true, seed: i + 1, created_at: iso(-3) }));
    const pairs = LeagueCore.seedOrder(8);
    for (let m = 0; m < 4; m++) race([t2ids[pairs[2 * m] - 1], t2ids[pairs[2 * m + 1] - 1]], iso(-2, 20, m * 10), { tournament_id: t2.id, match_key: `W1-${m + 1}`, mode: "Circuit" });
    // heats night open for sign-up
    const t3 = tour("Friday Heats", "heats", "signup", 4, { heatSize: 6, advance: 3, finalRaces: 2, city: "Chicago", mode: "Circuit" });
    ids.slice(0, 11).forEach(id => D.entries.push({ tournament_id: t3.id, player_id: id, checked_in: false, seed: null, created_at: iso(-1) }));

    // one casual race waiting to be verified
    const pend = race(ids.slice(3, 8), iso(0, -2), { entered_by: "u-5" });
    pend.note = "reported by jNoctal";
    // the organiser verified the older ones
    for (const r of D.races) if (r.entered_by !== "u-0" && r !== pend) D.race_confirms.push({ race_id: r.id, user_id: "u-0", created_at: r.played_at });

    return withLists(D);

    function tour(name, format, status, day, settings) {
      const t = { id: uid(), season_id: s1.id, name, format, status, starts_at: iso(day, 20), settings, created_by: "u-0", created_at: iso(day - 7) };
      D.tournaments.push(t);
      return t;
    }
  }
  function iso(dayOffset, hour, min) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return new Date(d.getTime() + dayOffset * 864e5 + (hour || 0) * 36e5 + (min || 0) * 6e4).toISOString();
  }

  function load() {
    try { const j = JSON.parse(localStorage.getItem(KEY)); if (j && j.players) return j; } catch (e) { /* none yet */ }
    return fresh();
  }
  let data = null;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* private window: memory only */ } };
  const matches = (row, m) => Object.keys(m).every(k => row[k] === m[k]);

  // the same shape as the Supabase store in league.js
  window.LeagueDemo = {
    demo: true,
    history: !!H,
    user: null,
    async loadAll() { if (!data) data = load(); return JSON.parse(JSON.stringify(data)); },
    async insert(table, rows) {
      const out = (Array.isArray(rows) ? rows : [rows]).map(r => {
        const row = { created_at: new Date().toISOString(), ...r };
        if (["players", "seasons", "tournaments", "races", "race_list", "changes"].includes(table) && !row.id) row.id = uid() + Date.now().toString(36);
        if (table === "races") { row.entered_by = row.entered_by || this.user.id; row.played_at = row.played_at || row.created_at; }
        if (table === "race_confirms") row.user_id = this.user.id;
        if (table === "players" && row.prestige == null) row.prestige = 0;
        if (table === "entries") { row.checked_in = !!row.checked_in; row.seed = row.seed == null ? null : row.seed; }
        data[table].push(row);
        return row;
      });
      save();
      return out;
    },
    async update(table, match, patch) { for (const r of data[table]) if (matches(r, match)) Object.assign(r, patch); save(); },
    async remove(table, match) {
      data[table] = data[table].filter(r => !matches(r, match));
      if (table === "races") { const ids = new Set(data.races.map(r => r.id)); data.race_results = data.race_results.filter(r => ids.has(r.race_id)); data.race_confirms = data.race_confirms.filter(r => ids.has(r.race_id)); }
      if (table === "tournaments") { const ids = new Set(data.tournaments.map(t => t.id)); data.entries = data.entries.filter(e => ids.has(e.tournament_id)); }
      save();
    },
    // demo sign-in: act as any player, organiser or not
    signInAs(playerUserId, organiser) {
      this.user = { id: playerUserId, name: "demo" };
      data.organisers = data.organisers.filter(o => o.user_id !== playerUserId);
      if (organiser) data.organisers.push({ user_id: playerUserId });
      save();
    },
    signOut() { this.user = null; },
    // who asked to be which driver ("a new Discord user" in Try as is u-guest)
    async pendingClaims() {
      return data.players.filter(p => p.claim_by && !p.user_id)
        .map(p => ({ player_id: p.id, user_id: p.claim_by, discord_name: p.claim_by === "u-guest" ? "NewDiscordUser" : p.claim_by, avatar_url: null }));
    },
    reset() { data = fresh(); save(); },
    onChange() { /* nothing live in demo */ },
  };
})();
