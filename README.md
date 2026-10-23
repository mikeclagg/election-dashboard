# 2026 Midterms dashboard

A static page covering the top statewide races in Texas, Michigan, Arizona and Florida. It shows October
polling averages (all polls, likely voters only or registered voters only), each race's poll margins since August,
and election-night returns once you add them. There's no build step: plain HTML, CSS and JavaScript, with d3 loaded from jsDelivr.

```
index.html              the page
assets/app.js           loads data/*.csv, draws cards, chart and table
assets/styles.css       light and dark themes
data/races.csv          races, nominees, past results, poll closing times, Wikipedia article per race
data/polls.csv          generated daily by scripts/update_polls.py (don't hand-edit)
data/polls_manual.csv   polls to add by hand (same columns as polls.csv)
data/results.csv        election-night returns
data/meta.json          when polls were last checked, and per-race warnings
scripts/update_polls.py the daily poll updater
.github/workflows/update-polls.yml  runs the updater every morning
```

## Run it locally

The page fetches its CSV files, so it needs a web server; opening `index.html` from disk won't load the data.

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Put it on your site

The page uses relative paths, so it works from any folder. Pick one:

- **Copy it into your site**, for example at `/elections/2026/`: copy `index.html`, `assets/` and `data/`.
  To match your site's look, change the tokens at the top of `assets/styles.css`.
- **Embed the hosted copy** from GitHub Pages at https://mikeclagg.github.io/election-dashboard/. The page reports its
  height to the host page, so the frame grows and shrinks with the content:

  ```html
  <iframe id="election-dashboard" src="https://mikeclagg.github.io/election-dashboard/"
    title="2026 midterms: Texas, Michigan, Arizona and Florida" loading="lazy"
    style="width:100%; height:2300px; border:0; display:block"></iframe>
  <script>
    window.addEventListener('message', function (e) {
      if (e.origin !== 'https://mikeclagg.github.io') return;
      if (!e.data || e.data.type !== 'election-dashboard:height') return;
      document.getElementById('election-dashboard').style.height = e.data.height + 'px';
    });
  </script>
  ```

  URL options: `?theme=light` or `?theme=dark` to match your site, `?state=TX`, `?pop=LV` or `?pop=RV`, and `?race=MI-GOV` to open on a race.

With either hosting option, each daily data commit redeploys the site automatically.

## Daily poll updates

`scripts/update_polls.py` reads the **General election → Polling** section of each race's Wikipedia article,
keeps the two nominees' numbers, and writes one row per poll and voter group. A poll that reports both
likely and registered voters becomes two rows, which is what the voter toggle uses.

```bash
pip install -r requirements.txt
python scripts/update_polls.py --dry-run   # report what would change
python scripts/update_polls.py             # write data/polls.csv and data/meta.json
```

Safety rails:

- If a race's article can't be read, or its poll count drops by more than 20%, that race keeps yesterday's rows,
  and `data/meta.json` records a warning.
- The scheduled run fails, and GitHub emails you, only when no race could be refreshed.
- Rows in `data/polls_manual.csv` are always included, unless Wikipedia already lists the same pollster, end date and voter group.
  Use this file for a poll that came out before Wikipedia added it.

### Turn on the schedule

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Secrets and variables → Actions → Variables** and add `POLL_UPDATER_CONTACT`
   with your site's URL. Wikipedia asks automated clients to identify themselves.
3. Under **Actions**, run **Update polls** once by hand to confirm it works. After that it runs every day at 10:00 UTC.

## Election night

Returns go in `data/results.csv`. The page switches a race from its poll average to the vote share as soon as
`pct_reporting` is above 0.

| column | meaning |
|---|---|
| `dem_votes`, `rep_votes`, `other_votes` | votes counted so far |
| `pct_reporting` | share of the expected vote counted, 0–100 |
| `called` | winner's name once a race is called; leave blank until then |
| `as_of` | ISO time of the count, e.g. `2026-11-04T01:30:00Z` |

For now, update this file by hand or with your own script. An automatic import from the four states'
election offices is the next piece to build. Test it against their 2024 result files before Nov 3.
State offices don't call races, so `called` stays manual unless you license AP or Decision Desk HQ data.

## Credits

Polling tables come from Wikipedia contributors under CC BY-SA 4.0. The page footer credits them and links each
article. Keep that credit if you restyle the page.
