# Madness Crew

Midtown Madness speedrun standings, every race's PBs, player cards and the latest verified runs,
read live from speedrun.com. No server: it's plain files on GitHub Pages.

## Put it online (once)

1. Sign in to GitHub as **itspanoz**.
2. New repository (top right **+** > New repository). Name: `madness-crew`. Public. Create.
3. On the new repository's page: **uploading an existing file**. Drag in everything from this
   folder (`index.html`, `style.css`, `app.js`, `crew.js`, `README.md` and the `img` folder).
   **Commit changes**.
4. **Settings > Pages**. Source: *Deploy from a branch*. Branch: `main`, folder `/ (root)`. Save.
5. After a minute or two the site is at **https://itspanoz.github.io/madness-crew/**

## Change the crew

Open `crew.js` on GitHub, click the pencil, add or remove names in `members` (as they appear on
speedrun.com), **Commit changes**. The site updates within a minute or two.
The points per place are in the same file.

## Look at it on your PC

Double-click `index.html`. It reads speedrun.com the same way the online site does.
