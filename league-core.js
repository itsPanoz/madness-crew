// Madness Crew League - the rules. Everything here is worked out from the raw tables (players,
// tournaments, entries, races, race_results, race_confirms) every time the page loads, so a fixed
// result fixes every rating, level and bracket after it. Nothing derived is stored.
//
//   ratings      OpenSkill (Plackett-Luce), made for races with many drivers at once
//   XP / levels  per race, per tournament, weekly challenges; 50 levels, 10 prestiges, then Master
//   formats      points series, heats to a final, single / double elimination, round robin, Swiss
"use strict";

(function (root) {
  const DAY = 86400000;

  // ---------------------------------------------------------------- ratings (OpenSkill, Weng-Lin
  // Plackett-Luce). A new driver starts at mu 25, sigma 25/3; the shown rating is
  // 1000 + 40 x (mu - 3 sigma), so it starts at 1000 and only climbs once the game is sure.

  const MU = 25, SIGMA = 25 / 3, BETA = 25 / 6, KAPPA = 0.0001;
  const ratingValue = r => Math.round(1000 + 40 * (r.mu - 3 * r.sigma));

  // field: [{rating:{mu,sigma}, rank}] (rank 1 = won, equal ranks = tie) -> new ratings, same order
  function rateRace(field) {
    const c = Math.sqrt(field.reduce((s, p) => s + p.rating.sigma ** 2 + BETA ** 2, 0));
    const e = field.map(p => Math.exp(p.rating.mu / c));
    const sumQ = field.map(q => field.reduce((s, p, i) => s + (p.rank >= q.rank ? e[i] : 0), 0));
    const ties = field.map(q => field.filter(p => p.rank === q.rank).length);
    return field.map((p, i) => {
      let omega = 0, delta = 0;
      field.forEach((q, j) => {
        if (q.rank > p.rank) return;
        const quot = e[i] / sumQ[j];
        omega += (i === j ? 1 - quot : -quot) / ties[j];
        delta += (quot * (1 - quot)) / ties[j];
      });
      const s2 = p.rating.sigma ** 2;
      const gamma = p.rating.sigma / c;
      omega *= s2 / c;
      delta *= (gamma * s2) / (c * c);
      return { mu: p.rating.mu + omega, sigma: p.rating.sigma * Math.sqrt(Math.max(1 - delta, KAPPA)) };
    });
  }

  // ---------------------------------------------------------------- levels and prestige

  const LEVEL_TITLES = [[1, "Learner's Permit"], [5, "Rookie"], [10, "Street Racer"], [15, "Wheelman"], [20, "Road Warrior"],
    [25, "Speed Demon"], [30, "Cab Crusher"], [35, "Bridge Jumper"], [40, "Midtown Menace"], [45, "Madness Legend"], [50, "Madness Elite"]];
  const PRESTIGES = [
    { name: "No prestige", colour: "#8c9a90" }, { name: "Bronze", colour: "#c47a3a" }, { name: "Silver", colour: "#c9d1d6" },
    { name: "Gold", colour: "#ecd628" }, { name: "Emerald", colour: "#2ecc71" }, { name: "Sapphire", colour: "#3d8bfd" },
    { name: "Ruby", colour: "#ff4d5e" }, { name: "Amethyst", colour: "#b26bff" }, { name: "Obsidian", colour: "#5d6b78" },
    { name: "Diamond", colour: "#7ff3ff" }, { name: "Inferno", colour: "#ff7a1a" },
  ];
  const MASTER = { name: "Madness Master", colour: "#ffd84a" };

  function levelRules(cfg) {
    const max = cfg.maxLevel || 50;
    const cost = l => (cfg.levelBase || 200) + (cfg.levelStep || 12) * l; // XP from level l to l+1
    let perPrestige = 0;
    for (let l = 1; l < max; l++) perPrestige += cost(l);
    return { max, cost, perPrestige, maxPrestige: cfg.maxPrestige || 10, masterStep: cfg.masterStep || 5000 };
  }

  // chosen = the prestige the driver picked on the site; it only counts as far as their XP covers it,
  // so editing the number by hand earns nothing
  function levelFor(xp, chosen, cfg) {
    const R = levelRules(cfg);
    const prestige = Math.max(0, Math.min(chosen | 0, Math.floor(xp / R.perPrestige), R.maxPrestige));
    let left = xp - prestige * R.perPrestige, level = 1;
    while (level < R.max && left >= R.cost(level)) { left -= R.cost(level); level++; }
    const capped = level === R.max;
    const master = capped && prestige === R.maxPrestige;
    const masterLevel = master ? 1 + Math.floor(left / R.masterStep) : 0;
    const need = capped ? (master ? R.masterStep : 0) : R.cost(level);
    const into = capped ? (master ? left % R.masterStep : 0) : left;
    let title = LEVEL_TITLES[0][1];
    for (const [l, t] of LEVEL_TITLES) if (level >= l) title = t;
    return {
      xp, level, prestige, master, masterLevel, into, need, title,
      canPrestige: capped && !master && (chosen | 0) === prestige,
      rank: master ? MASTER : PRESTIGES[prestige],
    };
  }

  // ---------------------------------------------------------------- weekly challenges
  // Three a week, picked from the pool by the week number, so everyone gets the same three.

  const CHALLENGES = [
    { id: "win2", text: "Win 2 races", xp: 400, goal: 2, count: r => r.won },
    { id: "finish5", text: "Finish 5 races", xp: 300, goal: 5, count: r => !r.dnf },
    { id: "beat10", text: "Beat 10 drivers", xp: 400, goal: 10, count: r => r.beaten },
    { id: "cities3", text: "Race in 3 different cities", xp: 400, goal: 3, distinct: r => r.city || "" },
    { id: "modes3", text: "Race all 3 modes: Blitz, Checkpoint and Circuit", xp: 450, goal: 3, distinct: r => (["Blitz", "Checkpoint", "Circuit"].includes(r.mode) ? r.mode : "") },
    { id: "podium-circuit", text: "Finish on the podium in a Circuit race", xp: 300, goal: 1, count: r => r.mode === "Circuit" && r.podium },
    { id: "upset", text: "Beat a driver rated above you", xp: 500, goal: 1, count: r => r.upset },
    { id: "tourney", text: "Race in a tournament", xp: 300, goal: 1, count: r => r.tournament },
    { id: "full8", text: "Finish a race with 6 or more drivers", xp: 350, goal: 1, count: r => !r.dnf && r.field >= 6 },
    { id: "win-blitz", text: "Win a Blitz race", xp: 350, goal: 1, count: r => r.won && r.mode === "Blitz" },
  ];
  // ISO-style week number: weeks start on Monday (UTC)
  const weekOf = t => Math.floor((t / DAY + 3) / 7);
  const weekStart = w => new Date((w * 7 - 3) * DAY);
  function challengesFor(week) {
    let h = (week * 2654435761) >>> 0;
    const pool = CHALLENGES.slice(), out = [];
    for (let i = 0; i < 3; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out.push(pool.splice(h % pool.length, 1)[0]);
    }
    return out;
  }
  function challengeProgress(ch, rows) {
    if (ch.distinct) return new Set(rows.map(ch.distinct).filter(Boolean)).size;
    return rows.reduce((s, r) => s + (Number(ch.count(r)) || 0), 0);
  }

  // ---------------------------------------------------------------- tournament formats

  // finish order inside one race for the given drivers, best first (DNFs after finishers)
  const rankKey = r => (r.dnf ? 1000 : 0) + r.place;

  function racePointsTable(races, players, points) {
    const t = new Map(players.map(id => [id, { id, pts: 0, wins: 0, best: 99, races: 0 }]));
    for (const race of races) {
      for (const r of race.results) {
        const row = t.get(r.player_id);
        if (!row) continue;
        row.races++;
        if (!r.dnf) {
          row.pts += points[r.place - 1] || 0;
          if (r.place === 1) row.wins++;
          row.best = Math.min(row.best, r.place);
        }
      }
    }
    return [...t.values()];
  }

  // one 1v1 match from the races with its key: {a, b, winsA, winsB, winner, loser, done}
  function matchState(a, b, races, bestOf) {
    const m = { a, b, winsA: 0, winsB: 0, winner: undefined, loser: undefined, done: false, races: [] };
    if (a === undefined || b === undefined) return m;           // still waiting for someone
    if (a === null || b === null) {                              // a bye
      m.done = true; m.winner = a === null ? b : a; m.loser = null; return m;
    }
    for (const race of races) {
      const ra = race.results.find(r => r.player_id === a), rb = race.results.find(r => r.player_id === b);
      if (!ra || !rb) continue;
      m.races.push(race);
      if (rankKey(ra) < rankKey(rb)) m.winsA++; else if (rankKey(rb) < rankKey(ra)) m.winsB++;
      // reported by score (Cops & Robbers): total points, shown on the bracket
      if (ra.score != null || rb.score != null) { m.scoreA = (m.scoreA || 0) + (ra.score || 0); m.scoreB = (m.scoreB || 0) + (rb.score || 0); }
    }
    const need = Math.ceil(bestOf / 2);
    if (m.winsA >= need || m.winsB >= need) {
      m.done = true;
      m.winner = m.winsA >= need ? a : b;
      m.loser = m.winner === a ? b : a;
    }
    return m;
  }

  // standard seeding positions: 1 v 8, 4 v 5, 2 v 7, 3 v 6 ...
  function seedOrder(size) {
    let s = [1, 2];
    while (s.length < size) {
      const n = s.length * 2;
      s = s.flatMap(x => [x, n + 1 - x]);
    }
    return s;
  }

  // places from elimination: drivers knocked out at the same stage tie; place = 1 + everyone who
  // lasted longer. out: [[playerId, stage]], higher stage = lasted longer, champion highest.
  function placesFromStages(out) {
    return out.map(([id, stage]) => ({ id, place: 1 + out.filter(([, s]) => s > stage).length }));
  }

  function elimination(t, seeds, racesByKey, double) {
    const bestOf = Math.max(1, t.settings.bestOf | 0 || 1);
    const n = seeds.length;
    if (n < 2) return { kind: "bracket", rounds: [], losers: [], final: [], done: false, places: [] };
    const k = Math.ceil(Math.log2(n)), size = 2 ** k;
    const slots = seedOrder(size).map(s => (s <= n ? seeds[s - 1] : null));
    const all = {};
    // src: where each side comes from, [match key, true if it's that match's loser], for drawing lines
    const play = (key, a, b, label, src) => {
      const m = matchState(a, b, racesByKey.get(key) || [], bestOf);
      m.key = key; m.label = label; m.src = src || [null, null];
      all[key] = m;
      return m;
    };
    const W = m => [m.key, false], Lo = m => [m.key, true];
    const stage = new Map(); // playerId -> stage they went out at
    const rounds = [];
    let field = slots, fieldSrc = slots.map(() => null);
    for (let r = 1; r <= k; r++) {
      const ms = [];
      const names = { [k]: double ? "Winners final" : "Final", [k - 1]: double ? `Round ${k - 1}` : "Semi-finals", [k - 2]: double ? `Round ${k - 2}` : "Quarter-finals" };
      for (let i = 0; i < field.length; i += 2) ms.push(play(`W${r}-${i / 2 + 1}`, field[i], field[i + 1], names[r] || `Round ${r}`, [fieldSrc[i], fieldSrc[i + 1]]));
      rounds.push(ms);
      field = ms.map(m => m.winner);
      fieldSrc = ms.map(W);
      if (!double) for (const m of ms) if (m.loser) stage.set(m.loser, r);
    }
    const wbChamp = field[0];
    const losers = [];
    let final = [];
    let champion;
    if (!double) {
      champion = wbChamp;
      if (champion) stage.set(champion, k + 1);
    } else {
      // losers' bracket: odd rounds play each other, even rounds take the next winners' round's losers
      let lb, lbSrc;
      if (k === 1) { lb = [rounds[0][0].loser]; lbSrc = [Lo(rounds[0][0])]; }
      else {
        lb = [];
        for (let i = 0; i < rounds[0].length; i += 2) lb.push(rounds[0][i].loser, rounds[0][i + 1].loser);
        let lr = 1;
        let ms = [];
        for (let i = 0; i < lb.length; i += 2) ms.push(play(`L${lr}-${i / 2 + 1}`, lb[i], lb[i + 1], `Losers round ${lr}`, [Lo(rounds[0][i]), Lo(rounds[0][i + 1])]));
        losers.push(ms);
        for (let j = 1; j < k; j++) {
          // even round: survivors v the losers of winners' round j+1 (reversed on alternate rounds,
          // so nobody meets the driver they just lost to)
          lr++;
          const dropM = rounds[j].slice();
          if (j % 2 === 1) dropM.reverse();
          const prevM = ms;
          ms = prevM.map((p, i) => play(`L${lr}-${i + 1}`, p.winner, dropM[i].loser, lr === 2 * (k - 1) ? "Losers final" : `Losers round ${lr}`, [W(p), Lo(dropM[i])]));
          losers.push(ms);
          if (j < k - 1) {
            lr++;
            const survM = ms;
            ms = [];
            for (let i = 0; i < survM.length; i += 2) ms.push(play(`L${lr}-${i / 2 + 1}`, survM[i].winner, survM[i + 1].winner, `Losers round ${lr}`, [W(survM[i]), W(survM[i + 1])]));
            losers.push(ms);
          }
        }
        lb = ms.map(m => m.winner);
        lbSrc = ms.map(W);
      }
      losers.forEach((ms, i) => { for (const m of ms) if (m.loser) stage.set(m.loser, i + 1); });
      const lbChamp = lb[0];
      const gf = play("GF1", wbChamp, lbChamp, "Grand final", [W(rounds[k - 1][0]), lbSrc[0]]);
      final.push(gf);
      const reset = t.settings.gfReset !== false;
      if (gf.done && gf.winner === lbChamp && reset && lbChamp) {
        const gf2 = play("GF2", wbChamp, lbChamp, "Grand final reset", [W(gf), Lo(gf)]);
        final.push(gf2);
        champion = gf2.done ? gf2.winner : undefined;
        if (gf2.done) stage.set(gf2.loser, 99);
      } else if (gf.done) {
        champion = gf.winner;
        if (gf.loser) stage.set(gf.loser, 99);
      }
      if (champion) stage.set(champion, 100);
    }
    const done = !!champion;
    const places = done ? placesFromStages([...stage.entries()].filter(([id]) => id)) : [];
    return { kind: "bracket", rounds, losers, final, all, done, champion, places };
  }

  function roundRobin(t, seeds, racesByKey) {
    const bestOf = Math.max(1, t.settings.bestOf | 0 || 1);
    // circle method: everyone plays once a round; an odd field gets a rest each round
    const list = seeds.length % 2 ? seeds.concat([null]) : seeds.slice();
    const n = list.length, rounds = [];
    let rot = list.slice(1);
    for (let r = 0; r < n - 1; r++) {
      const ring = [list[0]].concat(rot), ms = [];
      for (let i = 0; i < n / 2; i++) {
        const a = ring[i], b = ring[n - 1 - i];
        if (a === null || b === null) continue;
        const [x, y] = [a, b].sort();
        const key = `RR:${x}:${y}`;
        const m = matchState(x, y, racesByKey.get(key) || [], bestOf);
        m.key = key; m.label = `Round ${r + 1}`;
        ms.push(m);
      }
      rounds.push(ms);
      rot = [rot[rot.length - 1]].concat(rot.slice(0, -1));
    }
    const table = standingsFromMatches(seeds, rounds.flat());
    const done = rounds.flat().every(m => m.done);
    return { kind: "table", rounds, table, done, places: done ? table.map((r, i) => ({ id: r.id, place: i + 1 })) : [] };
  }

  function standingsFromMatches(seeds, matches, byes) {
    const t = new Map(seeds.map((id, i) => [id, { id, seed: i, w: 0, l: 0, rw: 0, rl: 0, opp: [] }]));
    for (const m of matches) {
      if (!m.done || m.a === null || m.b === null) continue;
      const A = t.get(m.a), B = t.get(m.b);
      if (!A || !B) continue;
      A.rw += m.winsA; A.rl += m.winsB; B.rw += m.winsB; B.rl += m.winsA;
      A.opp.push(m.b); B.opp.push(m.a);
      if (m.winner === m.a) { A.w++; B.l++; } else { B.w++; A.l++; }
    }
    for (const id of byes || []) if (t.get(id)) t.get(id).w++;
    for (const row of t.values()) row.buch = row.opp.reduce((s, o) => s + (t.get(o) ? t.get(o).w : 0), 0);
    return [...t.values()].sort((a, b) => b.w - a.w || b.buch - a.buch || (b.rw - b.rl) - (a.rw - a.rl) || a.seed - b.seed);
  }

  function swiss(t, seeds, racesByKey) {
    const bestOf = Math.max(1, t.settings.bestOf | 0 || 1);
    const n = seeds.length;
    const total = Math.max(1, t.settings.rounds | 0 || Math.ceil(Math.log2(Math.max(2, n))));
    const rounds = [], byes = [], met = new Set();
    for (let r = 1; r <= total; r++) {
      if (rounds.length && !rounds[rounds.length - 1].every(m => m.done)) break; // pair once the last round is in
      const table = standingsFromMatches(seeds, rounds.flat(), byes);
      let order = r === 1 ? seeds.slice() : table.map(x => x.id);
      let bye = null;
      if (order.length % 2) {
        const pick = order.slice().reverse().find(id => !byes.includes(id)) || order[order.length - 1];
        bye = pick; order = order.filter(id => id !== pick);
      }
      const pairs = [];
      if (r === 1) {
        const h = order.length / 2;
        for (let i = 0; i < h; i++) pairs.push([order[i], order[i + h]]);
      } else {
        const left = order.slice();
        while (left.length) {
          const a = left.shift();
          let j = left.findIndex(b => !met.has([a, b].sort().join(":")));
          if (j < 0) j = 0;
          pairs.push([a, left.splice(j, 1)[0]]);
        }
      }
      const ms = pairs.map(([a, b], i) => {
        const [x, y] = [a, b].sort();
        met.add(`${x}:${y}`);
        const key = `SW${r}:${x}:${y}`;
        const m = matchState(x, y, racesByKey.get(key) || [], bestOf);
        m.key = key; m.label = `Round ${r}`; m.table = i + 1;
        return m;
      });
      if (bye) { byes.push(bye); ms.bye = bye; }
      rounds.push(ms);
    }
    const table = standingsFromMatches(seeds, rounds.flat(), byes);
    const done = rounds.length === total && rounds[total - 1].every(m => m.done);
    return { kind: "table", rounds, table, total, done, places: done ? table.map((r, i) => ({ id: r.id, place: i + 1 })) : [] };
  }

  function heats(t, seeds, races, points) {
    const S = Math.max(2, t.settings.heatSize | 0 || 8);
    const A = Math.max(1, Math.min(S - 1, t.settings.advance | 0 || Math.floor(S / 2)));
    const finalRaces = Math.max(1, t.settings.finalRaces | 0 || 1);
    const out = [], stage = [];
    let field = seeds.slice(), round = 1, done = false, final = null;
    while (field.length) {
      const theseRaces = races.filter(r => (r.round || 1) === round);
      if (field.length <= S) {
        const fr = theseRaces;
        const table = racePointsTable(fr, field, points).sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.best - b.best || field.indexOf(a.id) - field.indexOf(b.id));
        final = { round, players: field, races: fr, table, need: finalRaces, done: fr.length >= finalRaces };
        out.push({ round, final: true, heats: [final] });
        if (final.done) {
          done = true;
          table.forEach((row, i) => stage.push([row.id, 1000 - i]));
        }
        break;
      }
      const h = Math.ceil(field.length / S);
      const groups = Array.from({ length: h }, () => []);
      field.forEach((id, i) => {
        const row = Math.floor(i / h);
        groups[row % 2 ? h - 1 - (i % h) : i % h].push(id);
      });
      const hs = groups.map((players, gi) => {
        const hr = theseRaces.filter(r => (r.heat || 1) === gi + 1);
        const table = racePointsTable(hr, players, points).sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.best - b.best || players.indexOf(a.id) - players.indexOf(b.id));
        const adv = Math.min(A, players.length - 1);
        return { round, heat: gi + 1, players, races: hr, table, advance: adv, done: hr.length > 0 };
      });
      out.push({ round, heats: hs });
      if (!hs.every(x => x.done)) break;
      const next = [];
      // everyone knocked out this round shares a stage; their heat place breaks the tie
      const maxPlace = Math.max(...hs.map(x => x.table.length));
      for (let p = 0; p < maxPlace; p++) {
        for (const x of hs) {
          const row = x.table[p];
          if (!row) continue;
          if (p < x.advance) next.push(row.id);
          else stage.push([row.id, round * 10 - p / 100]);
        }
      }
      field = next;
      round++;
    }
    return { kind: "heats", rounds: out, final, done, places: done ? placesFromStages(stage) : [], heatSize: S, advance: A };
  }

  function pointsSeries(t, seeds, races, points) {
    const planned = t.settings.races | 0 || 0;
    const table = racePointsTable(races, seeds, points).sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.best - b.best || seeds.indexOf(a.id) - seeds.indexOf(b.id));
    const done = t.status === "done" || (planned > 0 && races.length >= planned);
    return { kind: "points", table, races, planned, done, places: done ? table.map((r, i) => ({ id: r.id, place: i + 1 })) : [] };
  }

  // a tournament brought over from Challonge: its matches, labels and final places come with it
  // (settings.matches / settings.places), the races only carry the results for ratings and XP
  function imported(t, seeds, races) {
    const st = t.settings;
    const byKey = new Map();
    for (const r of races) (byKey.get(r.match_key) || byKey.set(r.match_key, []).get(r.match_key)).push(r);
    const all = {}, rounds = [];
    for (const x of st.matches || []) {
      const m = { key: x.key, code: x.k, r: x.r, src: x.src || [null, null], label: x.label, a: x.a, b: x.b, winsA: x.sa, winsB: x.sb, winner: x.w, loser: x.w === x.a ? x.b : x.a, done: byKey.has(x.key) };
      if (m.done) all[m.key] = m;
      if (!rounds.length || rounds[rounds.length - 1][0].label !== m.label) rounds.push([]);
      rounds[rounds.length - 1].push(m);
    }
    const places = (st.places || []).filter(([id]) => seeds.includes(id)).map(([id, place]) => ({ id, place }));
    // a Challonge free-for-all was one race: it counts as a race, not a tournament (no tournament XP
    // or season points), but still shows who won it
    const raceOnly = !(st.matches || []).length;
    return { kind: "imported", rounds, all, races, done: places.length > 0, places, raceOnly };
  }

  const FORMATS = {
    points: "Points series", heats: "Heats to a final", single_elim: "Single elimination",
    double_elim: "Double elimination", round_robin: "Round robin", swiss: "Swiss", imported: "From Challonge",
  };

  function deriveTournament(t, entries, races, ratingOf, points) {
    const mine = entries.filter(e => e.tournament_id === t.id);
    let seeds;
    if (t.status === "signup" || t.status === "checkin") {
      // until it starts: the organiser's seed order if they set one (later sign-ups go after), otherwise
      // by rating, checked-in drivers first during check-in
      seeds = mine.slice().sort((a, b) => (a.seed == null) - (b.seed == null) || (a.seed != null ? a.seed - b.seed : 0) ||
        (t.status === "checkin" ? b.checked_in - a.checked_in : 0) || ratingOf(b.player_id) - ratingOf(a.player_id) || String(a.created_at).localeCompare(String(b.created_at))).map(e => e.player_id);
    } else {
      seeds = mine.filter(e => e.seed != null).sort((a, b) => a.seed - b.seed).map(e => e.player_id);
    }
    const tr = races.filter(r => r.tournament_id === t.id);
    const byKey = new Map();
    for (const r of tr) if (r.match_key) (byKey.get(r.match_key) || byKey.set(r.match_key, []).get(r.match_key)).push(r);
    let view;
    switch (t.format) {
      case "heats": view = heats(t, seeds, tr, points); break;
      case "single_elim": view = elimination(t, seeds, byKey, false); break;
      case "double_elim": view = elimination(t, seeds, byKey, true); break;
      case "round_robin": view = roundRobin(t, seeds, byKey); break;
      case "swiss": view = swiss(t, seeds, byKey); break;
      case "imported": view = imported(t, seeds, tr); break;
      default: view = pointsSeries(t, seeds, tr, points);
    }
    view.seeds = seeds;
    view.started = !(t.status === "signup" || t.status === "checkin");
    // only a tournament the organiser has marked finished hands out XP and season points
    view.awarded = t.status === "done" && view.places.length > 0 && !view.raceOnly;
    return view;
  }

  // ---------------------------------------------------------------- the whole league

  function compute(data, cfg, points) {
    const organisers = new Set(data.organisers.map(o => o.user_id));
    const byRace = new Map();
    for (const r of data.race_results) (byRace.get(r.race_id) || byRace.set(r.race_id, []).get(r.race_id)).push(r);
    const confirms = new Map();
    for (const c of data.race_confirms) (confirms.get(c.race_id) || confirms.set(c.race_id, []).get(c.race_id)).push(c);

    const when = r => Date.parse(r.played_at || r.created_at) || 0;
    const races = data.races.map(r => {
      const results = (byRace.get(r.id) || []).slice().sort((a, b) => rankKey(a) - rankKey(b));
      const conf = confirms.get(r.id) || [];
      // only an organiser's word counts: races they entered, races they verified, or the Challonge history.
      // Races from the game or a race file always wait for a Verify, even an organiser's own (Robin 2026-10-26)
      const counted = results.length >= 2 && (r.imported || (r.source !== "game" && organisers.has(r.entered_by)) || conf.some(c => organisers.has(c.user_id)));
      return { ...r, results, confirms: conf, counted, at: when(r) };
    }).sort((a, b) => a.at - b.at || String(a.created_at).localeCompare(String(b.created_at)));
    const counted = races.filter(r => r.counted);

    const P = new Map();
    for (const p of data.players) {
      P.set(p.id, {
        ...p, rating: { mu: MU, sigma: SIGMA }, races: 0, wins: 0, podiums: 0, dnfs: 0, beaten: 0, xp: 0,
        xpBy: { races: 0, wins: 0, daily: 0, matches: 0, tournaments: 0, challenges: 0 },
        recent: [], history: [], tournaments: [], rows: [], days: new Set(),
        h2h: new Map(), xpLog: [], streak: 0, streakFrom: 0, bestStreak: null,
      });
    }
    const R = id => P.get(id);
    // XP with the time it was earned, so we know when each prestige was unlocked
    const gain = (p, at, n, bucket) => { p.xp += n; p.xpBy[bucket] += n; p.xpLog.push([at, n]); };
    // head-to-head against one opponent: races together (w/l = finished ahead/behind), 1v1 matches (mw/ml)
    const vs = (a, b) => R(a).h2h.get(b) || R(a).h2h.set(b, { id: b, races: 0, w: 0, l: 0, mw: 0, ml: 0 }).get(b);
    const minRated = cfg.ladderMinRaces || 3;
    let upset = null;                                 // the biggest rating gap anyone has beaten
    const matchAt = new Map(), tourAt = new Map();    // when a match / a tournament was last raced

    // every counted race, oldest first: ratings, race XP, and a row per driver for the challenges
    for (const race of counted) {
      const finishers = race.results.filter(r => R(r.player_id));
      // DNFs share last place between themselves
      const field = finishers.map(r => ({ id: r.player_id, rank: r.dnf ? 1000 : r.place, dnf: r.dnf, place: r.place }));
      const before = new Map(field.map(f => [f.id, ratingValue(R(f.id).rating)]));
      const next = rateRace(field.map(f => ({ rating: R(f.id).rating, rank: f.rank })));
      if (race.tournament_id) {
        tourAt.set(race.tournament_id, Math.max(tourAt.get(race.tournament_id) || 0, race.at));
        if (race.match_key) matchAt.set(race.tournament_id + "|" + race.match_key, race.at);
      }
      // every pair in the race: who finished ahead, and the biggest upset (both drivers already rated)
      for (let i = 0; i < field.length; i++) for (let j = i + 1; j < field.length; j++) {
        const a = field[i], b = field[j];
        vs(a.id, b.id).races++; vs(b.id, a.id).races++;
        if (a.rank === b.rank) continue;
        const [w, l] = a.rank < b.rank ? [a, b] : [b, a];
        vs(w.id, l.id).w++; vs(l.id, w.id).l++;
        const gap = before.get(l.id) - before.get(w.id);
        if (R(w.id).races >= minRated && R(l.id).races >= minRated && gap > 0 && !R(w.id).hidden && !R(l.id).hidden && (!upset || gap > upset.gap))
          upset = { gap, race, winner: w.id, loser: l.id, wr: before.get(w.id), lr: before.get(l.id) };
      }
      field.forEach((f, i) => {
        const p = R(f.id);
        const beaten = field.filter(o => o.rank > f.rank).length;
        const won = !f.dnf && f.rank === Math.min(...field.map(o => o.rank)) && field.length >= 2;
        const podium = !f.dnf && f.place <= 3 && field.length >= 3;
        const upset = field.some(o => o.rank > f.rank && before.get(o.id) > before.get(f.id));
        // the Challonge history counts for rating and records, but gives no XP (everyone starts at level 1)
        const earns = !race.imported || cfg.historyXp;
        let xp = 0;
        if (earns) {
          xp = (f.dnf ? cfg.xp.dnf : cfg.xp.finish) + beaten * cfg.xp.perBeaten;
          p.xpBy.races += xp;
          if (won) { xp += cfg.xp.win; p.xpBy.wins += cfg.xp.win; }
          else if (podium) { xp += cfg.xp.podium; p.xpBy.wins += cfg.xp.podium; }
          const day = Math.floor(race.at / DAY);
          if (!p.days.has(day)) { p.days.add(day); xp += cfg.xp.firstOfDay; p.xpBy.daily += cfg.xp.firstOfDay; }
          p.xp += xp;
          p.xpLog.push([race.at, xp]);
        }
        // win streaks: race wins in a row
        if (won) {
          if (!p.streak) p.streakFrom = race.at;
          p.streak++;
          if (!p.bestStreak || p.streak > p.bestStreak.n) p.bestStreak = { n: p.streak, from: p.streakFrom, to: race.at };
        } else p.streak = 0;
        p.rating = next[i];
        p.races++; p.wins += won ? 1 : 0; p.podiums += podium || won ? 1 : 0; p.dnfs += f.dnf ? 1 : 0; p.beaten += beaten;
        p.recent.push({ race, place: f.dnf ? null : f.place, field: field.length, xp });
        p.history.push({ at: race.at, rating: ratingValue(p.rating) });
        if (earns) p.rows.push({ at: race.at, won, podium, dnf: f.dnf, beaten, upset, field: field.length, city: race.city, mode: race.mode, tournament: !!race.tournament_id });
      });
    }

    const ratingOf = id => (R(id) ? ratingValue(R(id).rating) : 0);
    const tours = new Map();
    for (const t of data.tournaments) {
      t.settings = t.settings || {};
      const view = deriveTournament(t, data.entries, counted, ratingOf, points);
      view.pending = races.filter(r => r.tournament_id === t.id && !r.counted);
      tours.set(t.id, view);
      // 1v1 match wins: XP and the head-to-head match record
      const earns = t.format !== "imported" || cfg.historyXp;
      const won = m => {
        if (!m.done || !R(m.winner)) return;
        if (earns) gain(R(m.winner), matchAt.get(t.id + "|" + m.key) || 0, cfg.xp.matchWin, "matches");
        if (R(m.loser)) { vs(m.winner, m.loser).mw++; vs(m.loser, m.winner).ml++; }
      };
      if (view.all) for (const m of Object.values(view.all)) if (m.loser) won(m);
      if (view.kind === "table") for (const m of view.rounds.flat()) won(m);
      if (view.awarded) {
        for (const { id, place } of view.places) {
          const p = R(id);
          if (!p) continue;
          const bonus = cfg.xp.tournament[place - 1] || cfg.xp.tournamentEntry;
          if (earns) gain(p, tourAt.get(t.id) || Date.parse(t.starts_at) || 0, bonus, "tournaments");
          p.tournaments.push({ t, place, of: view.places.length });
        }
      }
    }

    // weekly challenges, every week someone raced in
    const nowWeek = weekOf(Date.now());
    for (const p of P.values()) {
      const weeks = new Map();
      for (const row of p.rows) { const w = weekOf(row.at); (weeks.get(w) || weeks.set(w, []).get(w)).push(row); }
      p.challenges = [];
      for (const [w, rows] of weeks) {
        for (const ch of challengesFor(w)) {
          const got = challengeProgress(ch, rows);
          if (got >= ch.goal) gain(p, Math.max(...rows.map(r => r.at)), ch.xp, "challenges");
        }
      }
      const cur = weeks.get(nowWeek) || [];
      p.thisWeek = challengesFor(nowWeek).map(ch => ({ ...ch, got: Math.min(ch.goal, challengeProgress(ch, cur)) }));
      p.ratingValue = ratingValue(p.rating);
      p.lv = levelFor(p.xp, p.prestige || 0, cfg);
      p.recent.reverse();
      // when they first had enough XP for each prestige (index 1-10), and for Madness Master (11)
      const LR = levelRules(cfg);
      p.unlocks = [];
      let sum = 0, n = 1;
      for (const [at, x] of p.xpLog.slice().sort((a, b) => a[0] - b[0])) {
        sum += x;
        while (n <= LR.maxPrestige + 1 && sum >= n * LR.perPrestige) p.unlocks[n++] = at;
      }
      // rival: raced together the most-even record, given enough races together
      const close = [...p.h2h.values()].filter(h => h.races >= (cfg.rivalMinRaces || 10) && !R(h.id).hidden);
      close.sort((a, b) => Math.abs(a.w - a.l) / a.races - Math.abs(b.w - b.l) / b.races || b.races - a.races);
      p.rival = close[0] || null;
    }

    // seasons: points from finished tournaments in that season
    const seasons = data.seasons.slice().sort((a, b) => String(b.starts_on).localeCompare(String(a.starts_on))).map(s => {
      const rows = new Map();
      for (const t of data.tournaments) {
        if (t.season_id !== s.id) continue;
        const v = tours.get(t.id);
        if (!v.awarded) continue;
        for (const { id, place } of v.places) {
          if (!R(id)) continue;
          const row = rows.get(id) || rows.set(id, { id, pts: 0, played: 0, best: 99, wins: 0 }).get(id);
          row.pts += cfg.seasonPoints[place - 1] || cfg.seasonEntry;
          row.played++; row.best = Math.min(row.best, place); row.wins += place === 1 ? 1 : 0;
        }
      }
      const table = [...rows.values()].sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.best - b.best);
      return { season: s, table };
    });

    return { P, races, counted, tours, seasons, organisers, nowWeek, upset };
  }

  const api = {
    compute, rateRace, ratingValue, levelFor, levelRules, challengesFor, weekOf, weekStart, CHALLENGES,
    LEVEL_TITLES, PRESTIGES, MASTER, FORMATS, deriveTournament, seedOrder, MU, SIGMA,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LeagueCore = api;
})(typeof window !== "undefined" ? window : globalThis);
