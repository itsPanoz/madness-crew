// Madness Crew League settings: edit this file on GitHub to change them.
// Until supabaseUrl and supabaseKey are filled in, the League page runs on made-up demo data
// that only lives in your own browser (see LEAGUE-SETUP.md for connecting it).
window.LEAGUE = {
  // Supabase > Project Settings > API: "Project URL" and the "anon public" key (safe to publish)
  supabaseUrl: "https://lrcesbkndpwrfpnbvsxv.supabase.co",
  supabaseKey: "sb_publishable_65rdjdR-Sd-MA226_-1SuQ_VPtfmG2k", // public (publishable) key - never the secret/service_role one

  // what the race report form offers
  historyXp: false,    // false: the Challonge history gives no XP, everyone started at level 1 (2026-10-20)
  rivalMinRaces: 10,   // races together before someone can be your Rival
  cities: ["Chicago", "Madness City", "Moronville", "Archipelago", "Super Squeeze", "Other"],
  // the races you can pick when reporting a Circuit, Checkpoint or Blitz race, by city and mode. Stock
  // Chicago has 10 Blitz, 10 Circuit and 12 Checkpoint (3 per season). Rename them to match the game,
  // or add a city's list; "Other" in the report box always lets you type any race name.
  raceList: {
    Chicago: {
      Blitz: ["Blitz 1", "Blitz 2", "Blitz 3", "Blitz 4", "Blitz 5", "Blitz 6", "Blitz 7", "Blitz 8", "Blitz 9", "Blitz 10"],
      Circuit: ["Circuit 1", "Circuit 2", "Circuit 3", "Circuit 4", "Circuit 5", "Circuit 6", "Circuit 7", "Circuit 8", "Circuit 9", "Circuit 10"],
      Checkpoint: {
        Spring: ["Spring 1", "Spring 2", "Spring 3"], Summer: ["Summer 1", "Summer 2", "Summer 3"],
        Fall: ["Fall 1", "Fall 2", "Fall 3"], Winter: ["Winter 1", "Winter 2", "Winter 3"],
      },
    },
  },
  modes: ["Circuit", "Checkpoint", "Blitz", "Cops & Robbers"],

  // XP for every counted race
  xp: {
    finish: 100,      // finishing a race
    dnf: 40,          // starting but not finishing
    perBeaten: 25,    // for every driver you finish ahead of
    win: 150,         // winning (on top of the above)
    podium: 50,       // 2nd or 3rd in a field of 3 or more
    firstOfDay: 100,  // your first race of the day
    matchWin: 100,    // winning a bracket / round robin / Swiss match
    tournament: [1000, 600, 400, 250], // finishing a tournament 1st, 2nd, 3rd, 4th
    tournamentEntry: 150,              // finishing a tournament anywhere else
  },

  // levels: 50 levels; going from level L to L+1 costs levelBase + levelStep x L XP
  // (24,500 XP a prestige, roughly 80 races). 10 prestiges, then Madness Master levels every masterStep.
  maxLevel: 50, levelBase: 200, levelStep: 12, maxPrestige: 10, masterStep: 5000,

  // season points from tournament places (1st, 2nd, ...); everyone else who finished gets seasonEntry
  seasonPoints: [100, 80, 65, 55, 45, 40, 35, 30],
  seasonEntry: 10,

  // a driver needs this many counted races before they get a place on the rating ladder
  ladderMinRaces: 3,
};
