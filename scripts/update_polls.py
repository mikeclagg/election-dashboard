"""Refresh data/polls.csv from the general-election polling tables on Wikipedia.

For every race in data/races.csv, this reads the "General election > Polling"
section of the race's Wikipedia article (column wiki_article), keeps the
head-to-head numbers for the two nominees named in the race row, and writes
one row per poll and voter group (likely voters, registered voters, ...).

Safety rails, so a bad day on Wikipedia never empties the dashboard:
  * a race whose table can't be read keeps yesterday's rows;
  * a race whose poll count drops by more than 20% keeps yesterday's rows;
  * rows in data/polls_manual.csv are always added (for polls Wikipedia
    hasn't listed yet, or corrections).

Usage:
    python scripts/update_polls.py            # update data/polls.csv
    python scripts/update_polls.py --dry-run  # report changes, write nothing

Polling data from Wikipedia is licensed CC BY-SA 4.0; the page credits it.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RACES = DATA / "races.csv"
POLLS = DATA / "polls.csv"
MANUAL = DATA / "polls_manual.csv"
META = DATA / "meta.json"

API = "https://en.wikipedia.org/w/api.php"
# Wikipedia asks API clients to identify themselves. Set POLL_UPDATER_CONTACT
# to a URL or address for your site, e.g. "https://example.com/elections".
USER_AGENT = "ElectionDashboard-poll-updater/1.0 ({})".format(
    os.environ.get("POLL_UPDATER_CONTACT", "static site, no contact set")
)
SINCE = os.environ.get("POLLS_SINCE", "2026-08-01")
MAX_DROP = 0.2  # keep yesterday's rows if a race loses more than this share of polls
PAUSE = 1.5  # seconds between Wikipedia requests

FIELDS = ["poll_id", "race_id", "pollster", "end_date", "population",
          "sample_size", "dem_pct", "rep_pct", "source"]
POPULATIONS = {"LV", "RV", "A", "V"}


def api(session, **params):
    params.update(action="parse", format="json", formatversion=2, redirects=1)
    for attempt in range(5):
        time.sleep(PAUSE)  # one request at a time, spaced out, as Wikipedia asks
        resp = session.get(API, params=params, timeout=30)
        if resp.status_code not in (429, 503):
            break
        time.sleep(_int(resp.headers.get("Retry-After"), 5 * 2 ** attempt))
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(body["error"].get("info", "Wikipedia API error"))
    return body["parse"]


def polling_section(session, article):
    """Index of the 'Polling' subsection under 'General election'."""
    in_general = False
    for sec in api(session, page=article, prop="sections")["sections"]:
        if sec["level"] == "2":
            in_general = sec["line"].lower().startswith("general election")
        elif in_general and sec["level"] == "3" and sec["line"].lower().startswith("polling"):
            return sec["index"]
    raise RuntimeError("no General election > Polling section")


def clean(text):
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def table_grid(table):
    """Rows of (text, is_header) with rowspan and colspan filled in."""
    grid, pending = [], {}
    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"], recursive=False)
        row, col, ci = [], 0, 0
        while ci < len(cells) or col in pending:
            if col in pending:
                left, text, is_th = pending[col]
                row.append((text, is_th))
                if left <= 1:
                    del pending[col]
                else:
                    pending[col][0] = left - 1
                col += 1
                continue
            cell = cells[ci]
            ci += 1
            text, is_th = clean(cell.get_text(" ", strip=True)), cell.name == "th"
            rowspan = _int(cell.get("rowspan"), 1)
            for _ in range(_int(cell.get("colspan"), 1)):
                row.append((text, is_th))
                if rowspan > 1:
                    pending[col] = [rowspan - 1, text, is_th]
                col += 1
        grid.append(row)
    return grid


def _int(value, default):
    try:
        return max(1, int(str(value).strip()))
    except (TypeError, ValueError):
        return default


def parse_pct(text):
    m = re.fullmatch(r"(\d{1,2}(?:\.\d+)?)\s*%", text.strip())
    return float(m.group(1)) if m else None


MONTH_FORMATS = ("%B %d, %Y", "%b %d, %Y", "%b. %d, %Y")


def parse_end_date(text):
    """'October 17–21, 2026' / 'Sep 19 – Oct 1, 2026' / 'October 8, 2026' -> date."""
    text = clean(text).replace("Sept.", "Sep.").replace("Sept ", "Sep ")
    parts = re.split(r"\s*[–—-]\s*", text)
    end = parts[-1]
    if not re.match(r"[A-Za-z]", end):  # "21, 2026": borrow the month from the start
        month = re.match(r"([A-Za-z.]+)", parts[0])
        if not month:
            return None
        end = f"{month.group(1)} {end}"
    for fmt in MONTH_FORMATS:
        try:
            return datetime.strptime(end, fmt).date()
        except ValueError:
            continue
    return None


def parse_sample(text):
    """'1,000 (LV)' -> ('1000', 'LV'); '– (LV)' -> ('', 'LV') when only the group is given."""
    size = re.search(r"\d[\d,]*", text)
    pop = re.search(r"\(\s*([A-Za-z]+)\s*\)", text)
    pop = pop.group(1).upper() if pop else ""
    return (size.group(0).replace(",", "") if size else ""), (pop if pop in POPULATIONS else "")


def find_col(headers, *needles):
    for i, h in enumerate(headers):
        low = h.lower()
        if all(n.lower() in low for n in needles):
            return i
    return None


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40]


def race_polls(session, race):
    article = race["wiki_article"]
    html = api(session, page=article, prop="text", section=polling_section(session, article))["text"]
    soup = BeautifulSoup(html, "html.parser")
    for sup in soup.find_all("sup"):  # footnote markers like [7] or [d]
        sup.decompose()

    dem_last = race["dem_candidate"].split()[-1]
    rep_last = race["rep_candidate"].split()[-1]
    url = f"https://en.wikipedia.org/wiki/{article}"
    out, seen = [], set()
    for table in soup.find_all("table", class_="wikitable"):
        grid = table_grid(table)
        if not grid:
            continue
        headers = [t for t, _ in grid[0]]
        src = find_col(headers, "poll source")
        when = find_col(headers, "date")
        size = find_col(headers, "sample")
        dem = find_col(headers, dem_last, "(D)")
        rep = find_col(headers, rep_last, "(R)")
        if None in (src, when, dem, rep):
            continue  # an aggregator table or a hypothetical matchup
        for row in grid[1:]:
            if len(row) <= max(dem, rep) or all(is_th for _, is_th in row):
                continue
            d, r = parse_pct(row[dem][0]), parse_pct(row[rep][0])
            end = parse_end_date(row[when][0])
            pollster = re.sub(r"\s*\[\s*\w*\s*\]", "", row[src][0]).strip()
            if d is None or r is None or end is None or not pollster:
                continue  # primary-day marker rows, blank cells, etc.
            if d + r > 100 or end.isoformat() < SINCE or end > date.today():
                continue
            n, pop = parse_sample(row[size][0]) if size is not None else ("", "")
            key = (slug(pollster), end.isoformat(), pop)
            if key in seen:
                continue  # extra lines of one poll (other ballot versions)
            seen.add(key)
            out.append({
                "poll_id": f"{race['race_id']}-{end.isoformat()}-{key[0]}-{pop or 'NA'}",
                "race_id": race["race_id"], "pollster": pollster, "end_date": end.isoformat(),
                "population": pop, "sample_size": n,
                "dem_pct": _num(d), "rep_pct": _num(r), "source": url,
            })
    return out


def _num(v):
    return str(int(v)) if float(v).is_integer() else str(v)


def read_csv(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing files")
    args = ap.parse_args()

    races = read_csv(RACES)
    old = read_csv(POLLS)
    old_by_race = {}
    for p in old:
        old_by_race.setdefault(p["race_id"], []).append(p)

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    rows, report, failures = [], {}, 0
    for race in races:
        rid, before = race["race_id"], old_by_race.get(race["race_id"], [])
        try:
            fresh = race_polls(session, race)
            note = None
            if not fresh:
                note = "no polls found in the article's table"
            elif len(before) >= 5 and len(fresh) < (1 - MAX_DROP) * len(before):
                note = f"poll count fell from {len(before)} to {len(fresh)}"
        except Exception as exc:  # network trouble or a changed page layout
            fresh, note = [], f"could not read article: {exc}"
        if note:
            failures += 1
            rows += before
            report[rid] = {"status": "kept previous", "polls": len(before), "warning": note}
        else:
            rows += fresh
            old_ids = {p["poll_id"] for p in before}
            report[rid] = {"status": "updated", "polls": len(fresh),
                           "new": sorted(p["poll_id"] for p in fresh if p["poll_id"] not in old_ids)}

    have = {(p["race_id"], slug(p["pollster"]), p["end_date"], p["population"]) for p in rows}
    for p in read_csv(MANUAL):
        if (p["race_id"], slug(p["pollster"]), p["end_date"], p["population"]) not in have:
            rows.append({k: p.get(k, "") for k in FIELDS} | {"source": p.get("source") or "manual"})

    rows.sort(key=lambda p: (p["race_id"], p["end_date"], p["pollster"]), reverse=True)
    for rid, info in report.items():
        line = f"{rid}: {info['status']}, {info['polls']} polls"
        if info.get("new"):
            line += f", {len(info['new'])} new"
        if info.get("warning"):
            line += f" (WARNING: {info['warning']})"
        print(line)

    if args.dry_run:
        print("Dry run: nothing written.")
    else:
        with POLLS.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        META.write_text(json.dumps({
            "polls_checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "polls_source": "Wikipedia general-election polling tables (CC BY-SA 4.0)",
            "races": report,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {len(rows)} polls to {POLLS.relative_to(ROOT)}")

    # Fail the scheduled run only when nothing could be refreshed at all.
    return 1 if races and failures == len(races) else 0


if __name__ == "__main__":
    sys.exit(main())
