# Madness Crew League: going live

The League page (`league.html`) works straight away in **demo mode**: made-up races between crew
names, kept only in your own browser. To make it real (Discord sign-in, sign-ups, results everyone
sees) it needs a free Supabase database. This takes about 15 minutes, once.

## 1. Make the database

1. Go to **supabase.com**, sign in (the GitHub account is fine), **New project**.
   Name `madness-crew`, pick a database password (save it somewhere), region closest to most of
   the crew, Free plan. Wait a minute for it to start.
2. Left menu **SQL Editor** > **New query**. Open `supabase/schema.sql` from this folder, copy
   all of it in, **Run**. It should say *Success. No rows returned*.
3. **New query** again. Open `supabase/challonge-import.sql`, copy all of it in, **Run**. This brings
   over the 25 MM1 tournaments from Challonge into a *Challonge Era* season, with a driver for each of
   the 54 players. Running it a second time does nothing, so it's safe if you're not sure it worked.

## 2. Let people sign in with Discord

1. Go to **discord.com/developers/applications** > **New Application**, name it
   `Madness Crew League`.
2. Left menu **OAuth2**. Copy the **Client ID**. Click **Reset Secret** and copy the **Client Secret**.
3. Still on that page, **Redirects** > **Add Redirect**:
   `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
   (Supabase shows this exact address in the next step; copy it from there.) **Save Changes**.
4. Back in Supabase: **Authentication** > **Sign In / Providers** > **Discord**. Turn it on, paste
   the Client ID and Client Secret, **Save**.
5. **Authentication** > **URL Configuration**:
   - Site URL: `https://itspanoz.github.io/madness-crew/league.html`
   - Redirect URLs > Add: `https://itspanoz.github.io/madness-crew/league.html`

## 3. Point the site at it

1. Supabase **Project Settings** > **API** (or **Data API**). Copy the **Project URL** and the
   **anon public** key.
2. Put them into `league-config.js`:
   ```js
   supabaseUrl: "https://abcdefgh.supabase.co",
   supabaseKey: "eyJhbGciOi...",
   ```
   The anon key is meant to be public: the database's own rules decide what it can do.
   **Never** put the `service_role` key in there.

## 4. Upload

Upload to the `madness-crew` repository on GitHub (drag the files in, **Commit changes**):
`league.html`, `league.css`, `league.js`, `league-core.js`, `league-demo.js`, `league-config.js`,
`league-history.js` (only used before the database is connected),
plus the changed `index.html`, `style.css` and `img/logo.png`.

## 5. Make yourself an organiser

1. Open `https://itspanoz.github.io/madness-crew/league.html`, **Sign in with Discord**, and create
   your driver.
2. Supabase **SQL Editor** > **New query**, run this with your Discord username:
   ```sql
   insert into public.organisers (user_id)
   select id from auth.users
   where raw_user_meta_data->>'name' ilike 'your_discord_name'
      or raw_user_meta_data->>'full_name' ilike 'your_discord_name';
   ```
3. Reload the League page: the **Organiser** panel appears at the bottom. Do the same for anyone
   else who should run tournaments (after they have signed in once).

## Running it

- **Drivers** sign in with Discord and create their driver, or claim one an organiser already
  added for them, which keeps their old races. Everyone from Challonge is already there: they
  should **claim** their name, not make a new one.
- **Tournaments**: an organiser makes one (Organiser > New tournament). It opens for sign-up. Next
  they can open check-in, which is optional. Then they press **Start**, which locks the seeds and draws the bracket or heats.
  Drivers report each race with **Report** next to their match. An organiser presses **Verify**
  on it, and the bracket moves on by itself. Races an organiser enters count straight away. Once everything is in, the organiser presses **Mark finished**, which
  hands out tournament XP and season points.
- **Casual races** (Report a race) count for rating, XP and challenges, not for season points.
- **Races from the game**: Madness HUD saves every online race in the game folder, in
  `Madness HUD results\`, and sends it to the League with the driver's game key (League profile >
  Show my game key, pasted into Madness HUD's race board settings). Anyone in the race with Madness HUD
  sends it; the League keeps one copy (same mode, city, race and drivers, within 2 minutes). Sent files
  move into `sent\`; a race that couldn't be sent stays at the top and is tried again each time the
  game starts, or can be added with **Upload race files**. Races from the game or a file always wait
  for an organiser's **Verify**, even an organiser's own. Needs `supabase/game-results-v3.sql`.
- **Seasons**: Organiser > New season. New tournaments go into the season you pick.
- **Settings** (XP amounts, level curve, season points, cities, modes) are in `league-config.js`.
  Points per place in points series and heats come from `crew.js`, the same as the speedrun boards.

## Good to know

- On the free plan, Supabase **pauses a project after a week with no visits**. If the League page
  says it couldn't load, open supabase.com and press **Restore** on the project.
- Changing an old result is fine: ratings, levels and brackets are worked out again from all
  results every time the page loads.
- A driver can raise their own prestige number by hand, but it only counts as far as their XP
  covers it, so there's no point.
