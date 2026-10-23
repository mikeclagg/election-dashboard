// 2026 midterms dashboard: reads data/*.csv and draws race cards, a margin chart and a poll table.
(() => {
  const OCT = '2026-10-01';          // polls ending on or after this date make the October average
  const CHART_FROM = '2026-08-01';
  const ELECTION = '2026-11-03';
  const POP = {
    all: { scope: 'in October polling', none: '' },
    LV: { scope: 'among likely voters in October polls', none: 'likely-voter ' },
    RV: { scope: 'among registered voters in October polls', none: 'registered-voter ' },
  };

  const $ = (s) => document.querySelector(s);
  const fmtDate = d3.utcFormat('%b %-d');
  const fmtN = d3.format(',');
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const r1 = (v) => Math.round(v * 10) / 10;
  const label = (v, digits = 1) => v == null ? '—' : v === 0 ? 'Tied' : (v > 0 ? 'D +' : 'R +') + Math.abs(v).toFixed(digits);
  const side = (v) => v > 0 ? 'd' : v < 0 ? 'r' : '';
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // State lives in the query string so a filtered view can be shared.
  const qs = new URLSearchParams(location.search);
  const state = {
    filter: ['TX', 'MI', 'AZ', 'FL'].includes(qs.get('state')) ? qs.get('state') : 'ALL',
    pop: POP[qs.get('pop')] ? qs.get('pop') : 'all',
    race: qs.get('race') || 'TX-SEN',
  };
  // ?theme=light or ?theme=dark pins the look (useful when embedded); otherwise it follows the reader's system.
  const theme = ['light', 'dark'].includes(qs.get('theme')) ? qs.get('theme') : null;
  if (theme) document.documentElement.dataset.theme = theme;

  // When embedded in an iframe, tell the host page our height so it can size the frame to fit.
  if (window.parent !== window && 'ResizeObserver' in window) {
    // Measure the content, not the document: inside a frame the document is at least as tall as the frame.
    new ResizeObserver(() => {
      window.parent.postMessage({ type: 'election-dashboard:height', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
    }).observe(document.body);
  }

  const saveState = () => {
    const p = new URLSearchParams();
    if (theme) p.set('theme', theme);
    if (state.filter !== 'ALL') p.set('state', state.filter);
    if (state.pop !== 'all') p.set('pop', state.pop);
    p.set('race', state.race);
    history.replaceState(null, '', '?' + p.toString());
  };

  const now = new Date();
  const days = Math.round((Date.UTC(2026, 10, 3) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  $('#ed-countdown').textContent = days > 1 ? `${days} days to go` : days === 1 ? 'Tomorrow' : days === 0 ? 'Election day' : 'Counting votes';

  // ---- Calculations (same definitions as the claude.ai version) ----

  function summarize(races, polls, results, pop) {
    return new Map(races.map((r) => {
      const ps = polls.filter((p) => p.race_id === r.race_id && p.end_date >= OCT && (pop === 'all' || p.population === pop));
      const mean = (k) => ps.length ? r1(d3.mean(ps, (p) => p[k])) : null;
      const dem = mean('dem_pct'), rep = mean('rep_pct');
      const res = results.find((x) => x.race_id === r.race_id) || {};
      const tot = (res.dem_votes || 0) + (res.rep_votes || 0) + (res.other_votes || 0);
      const rd = tot ? r1(res.dem_votes / tot * 100) : null, rr = tot ? r1(res.rep_votes / tot * 100) : null;
      return [r.race_id, {
        avg_dem: dem, avg_rep: rep, avg_margin: dem == null ? null : r1(dem - rep), n_polls: ps.length,
        prev_margin: r1(r.prev_dem_pct - r.prev_rep_pct),
        res_dem_pct: rd, res_rep_pct: rr, res_margin: tot ? r1(rd - rr) : null,
        pct_reporting: res.pct_reporting || 0, called: res.called || '', as_of: res.as_of || '',
      }];
    }));
  }

  // Each poll's margin plus the mean of it and the four polls before it (same race, same voter group).
  function withAverages(polls, pop) {
    const seen = {};
    return polls
      .filter((p) => pop === 'all' || p.population === pop)
      .sort((a, b) => d3.ascending(a.end_date, b.end_date) || d3.descending(a.poll_id, b.poll_id))
      .map((p) => {
        const margin = p.dem_pct - p.rep_pct;
        const list = (seen[p.race_id] = seen[p.race_id] || []);
        list.push(margin);
        return { ...p, margin, avg5: r1(d3.mean(list.slice(-5))) };
      });
  }

  // ---- Load ----

  const num = (k) => (d) => { d[k] = d[k] === '' || d[k] == null ? null : +d[k]; return d; };
  Promise.all([
    d3.csv('data/races.csv', (d) => ['prev_dem_pct', 'prev_rep_pct', 'sort'].reduce((o, k) => num(k)(o), d)),
    d3.csv('data/polls.csv', (d) => ['dem_pct', 'rep_pct', 'sample_size'].reduce((o, k) => num(k)(o), d)),
    d3.csv('data/results.csv', (d) => ['dem_votes', 'rep_votes', 'other_votes', 'pct_reporting'].reduce((o, k) => num(k)(o), d)),
    d3.json('data/meta.json').catch(() => null),
  ]).then(([races, polls, results, meta]) => {
    races.sort((a, b) => a.sort - b.sort);
    start(races, polls.filter((p) => p.dem_pct != null && p.rep_pct != null), results, meta);
  }).catch(() => {
    $('#ed-takeaway').textContent = 'The poll data didn’t load. Refresh the page to try again.';
    $('#ed-races').replaceChildren(mk('div', 'ed-fail', 'Failed to load'));
  });

  function start(races, polls, results, meta) {
    const raceById = new Map(races.map((r) => [r.race_id, r]));
    if (!raceById.has(state.race)) state.race = races[0].race_id;
    let animated = false;

    document.querySelectorAll('.ed-chip').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.state; draw(); }));
    document.querySelectorAll('#ed-pop button').forEach((b) => b.addEventListener('click', () => { state.pop = b.dataset.pop; draw(); }));
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawDetail, 120); });

    footer(races, meta, results);
    draw();

    function draw() {
      const shown = races.filter((r) => state.filter === 'ALL' || r.state === state.filter);
      if (!shown.some((r) => r.race_id === state.race)) state.race = shown[0].race_id;
      document.querySelectorAll('.ed-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.state === state.filter)));
      document.querySelectorAll('#ed-pop button').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.pop === state.pop)));
      const sum = summarize(races, polls, results, state.pop);
      takeaway(sum);
      cards(shown, sum);
      drawDetail();
      saveState();
    }

    function takeaway(sum) {
      const take = $('#ed-takeaway');
      const polled = races.filter((r) => sum.get(r.race_id).avg_margin != null);
      const dem = polled.filter((r) => sum.get(r.race_id).avg_margin > 0).length;
      const rep = polled.filter((r) => sum.get(r.race_id).avg_margin < 0).length;
      const closest = d3.least(polled, (r) => Math.abs(sum.get(r.race_id).avg_margin));
      const live = races.some((r) => sum.get(r.race_id).pct_reporting > 0);
      const scope = POP[state.pop].scope;
      take.replaceChildren(
        live ? `Returns are coming in. Before election day, ${scope}, ` : `No votes are counted until polls close on Nov 3. ${scope[0].toUpperCase()}${scope.slice(1)}, `,
        'Democrats lead in ', mk('b', '', String(dem)), ` of ${polled.length}`,
        state.pop === 'all' ? ' races' : ' races polled this way', ' and Republicans in ', mk('b', '', String(rep)), '.');
      if (closest) {
        const m = sum.get(closest.race_id).avg_margin;
        take.append(` The closest is ${closest.race_name} at `, mk('b', 'ed-m-' + side(m), label(m)), '.');
      }
    }

    function cards(shown, sum) {
      const grid = $('#ed-races');
      grid.replaceChildren();
      shown.forEach((r) => {
        const s = sum.get(r.race_id);
        const live = s.pct_reporting > 0;
        const dv = live ? s.res_dem_pct : s.avg_dem, rv = live ? s.res_rep_pct : s.avg_rep;
        const lead = dv > rv ? 'd' : rv > dv ? 'r' : '';
        const card = mk('div', 'ed-race' + (animated ? '' : ' ed-in'));
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-pressed', String(r.race_id === state.race));
        card.setAttribute('aria-label', `${r.race_name}: show polls`);
        const select = () => { state.race = r.race_id; draw(); };
        card.addEventListener('click', select);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });

        const top = mk('div', 'ed-race-top');
        top.append(mk('span', 'ed-state', r.state), mk('span', 'ed-office', r.office), mk('span', 'ed-seat', r.seat_note));

        const mu = mk('div', 'ed-matchup');
        [['d', 'dem', dv, r.dem_candidate], ['r', 'rep', rv, r.rep_candidate]].forEach(([p, inc, v, name]) => {
          const c = mk('div', 'ed-cand');
          c.append(mk('span', 'ed-party ed-party-' + p, p.toUpperCase()), mk('span', 'ed-cand-name', name));
          if (r.incumbent === inc) c.append(mk('span', 'ed-inc', 'incumbent'));
          const pct = mk('div', 'ed-pct' + (lead === p ? ' ed-lead-' + p : ''));
          if (v == null) pct.append(mk('span', 'ed-pct-none', 'No Oct. poll'));
          else pct.append(v.toFixed(1), mk('small', '', '%'));
          mu.append(c, pct);
        });

        const bar = mk('div', 'ed-bar');
        bar.setAttribute('aria-hidden', 'true');
        const bd = mk('div', 'ed-bar-d'), br = mk('div', 'ed-bar-r');
        bd.style.width = (dv || 0) + '%';
        br.style.width = (rv || 0) + '%';
        bar.append(bd, br, mk('div', 'ed-bar-mid'));

        const facts = mk('div', 'ed-facts');
        const f1 = mk('span');
        f1.append('Oct avg ', mk('b', 'ed-m-' + side(s.avg_margin), label(s.avg_margin)), ` · ${s.n_polls} ${s.n_polls === 1 ? 'poll' : 'polls'}`);
        const f2 = mk('span');
        f2.title = r.prev_matchup;
        f2.append(`${r.prev_year}: `, mk('b', 'ed-m-' + side(s.prev_margin), label(s.prev_margin)));
        facts.append(f1, f2);

        const res = mk('div', 'ed-result' + (live ? ' ed-live' : ''));
        res.append(mk('span', 'ed-dot'));
        if (live) {
          res.append(`${s.pct_reporting}% of expected vote counted · `, mk('b', 'ed-m-' + side(s.res_margin), label(s.res_margin)));
          if (s.called) res.append(' · Called: ', mk('span', 'ed-called', s.called));
        } else {
          const close = r.first_close_et === r.last_close_et ? r.first_close_et : `${r.first_close_et}–${r.last_close_et}`;
          res.append(`Results after polls close, ${close} ET`);
        }

        card.append(top, mu, bar, facts, res);
        grid.append(card);
      });
      animated = true;
    }

    function drawDetail() {
      const r = raceById.get(state.race);
      const rows = withAverages(polls.filter((p) => p.race_id === r.race_id && p.end_date >= CHART_FROM), state.pop);
      $('#ed-trend-title').textContent = `${r.race_name}: polling margin since August`;
      $('#ed-trend-note').textContent = rows.length
        ? 'Each dot is one poll’s margin. The line is the average of the five most recent polls at each point.'
        : `No ${POP[state.pop].none}polls of this race since August.`;
      $('#ed-polls-title').textContent = `${r.race_name} polls (${rows.length})`;
      const last = (n) => n.split(' ').slice(-1)[0];
      $('#ed-th-d').textContent = `${last(r.dem_candidate)} (D)`;
      $('#ed-th-r').textContent = `${last(r.rep_candidate)} (R)`;
      trend(rows, r);
      table(rows);
    }

    function table(rows) {
      const tbody = $('#ed-polls tbody');
      tbody.replaceChildren();
      [...rows].sort((a, b) => d3.descending(a.end_date, b.end_date) || d3.ascending(a.pollster, b.pollster)).forEach((p) => {
        const tr = mk('tr', p.end_date >= OCT ? 'ed-oct' : '');
        tr.append(
          mk('td', '', p.pollster),
          mk('td', '', fmtDate(parse(p.end_date))),
          mk('td', 'ed-hide-narrow', p.population || '—'),
          mk('td', 'ed-num ed-hide-narrow', p.sample_size ? fmtN(p.sample_size) : '—'),
          mk('td', 'ed-num', String(p.dem_pct)),
          mk('td', 'ed-num', String(p.rep_pct)),
          mk('td', 'ed-num' + (side(p.margin) ? ' ed-m-' + side(p.margin) : ''), label(p.margin, 0)));
        tbody.append(tr);
      });
    }

    function trend(rows, race) {
      const chart = $('#ed-trend');
      chart.replaceChildren();
      const W = Math.max(280, chart.clientWidth || 600), H = 280, top = 18, bottom = 26;
      const x0 = parse(CHART_FROM), x1 = parse(ELECTION);
      const ext = d3.max(rows, (p) => Math.abs(p.margin)) || 5;
      const lim = Math.max(10, Math.ceil((ext + 1) / 5) * 5);
      const y = d3.scaleLinear([-lim, lim], [H - bottom, top]);
      const fmtY = (v) => v === 0 ? 'Even' : (v > 0 ? 'D +' : 'R +') + Math.abs(v);
      const svg = d3.select(chart).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`)
        .attr('role', 'img').attr('aria-label', `Poll margins over time for ${race.race_name}`);

      // Margins sized from the widest labels as drawn.
      const yt = y.ticks(lim > 15 ? 4 : 5);
      const probe = svg.append('text').attr('class', 'ed-tick');
      let ml = 0;
      yt.forEach((t) => { probe.text(fmtY(t)); ml = Math.max(ml, probe.node().getComputedTextLength()); });
      const lastPt = rows[rows.length - 1];
      probe.attr('class', 'ed-endlabel').text(lastPt ? label(lastPt.avg5) : '');
      const er = probe.node().getComputedTextLength();
      probe.remove();
      const left = ml + 10;
      const x = d3.scaleUtc([x0, x1], [left, W - Math.max(16, er + 12)]);

      svg.append('rect').attr('x', left).attr('y', top).attr('width', x(x1) - left).attr('height', y(0) - top).style('fill', 'var(--dem-soft)');
      svg.append('rect').attr('x', left).attr('y', y(0)).attr('width', x(x1) - left).attr('height', H - bottom - y(0)).style('fill', 'var(--rep-soft)');
      const g = svg.append('g');
      yt.forEach((t) => {
        g.append('line').attr('x1', left).attr('x2', x(x1)).attr('y1', y(t)).attr('y2', y(t))
          .style('stroke', t === 0 ? 'var(--axis)' : 'var(--grid)').style('stroke-width', 1);
        g.append('text').attr('class', 'ed-tick').attr('x', left - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text(fmtY(t));
      });
      d3.utcMonth.range(x0, x1).forEach((m) => {
        g.append('text').attr('class', 'ed-tick').attr('x', x(m)).attr('y', H - 6).text(d3.utcFormat('%b')(m));
      });
      g.append('line').attr('x1', x(x1)).attr('x2', x(x1)).attr('y1', top).attr('y2', H - bottom)
        .style('stroke', 'var(--ref)').style('stroke-dasharray', '4 3');
      g.append('text').attr('class', 'ed-tick').attr('x', x(x1)).attr('y', H - 6).attr('text-anchor', 'middle').text('Nov 3');
      if (!rows.length) return;

      const color = (v) => v > 0 ? 'var(--dem)' : v < 0 ? 'var(--rep)' : 'var(--muted)';
      const pts = rows.map((p) => [x(parse(p.end_date)), y(p.margin)]);
      svg.append('g').selectAll('circle').data(rows).join('circle')
        .attr('cx', (p, i) => pts[i][0]).attr('cy', (p, i) => pts[i][1]).attr('r', 4)
        .style('fill', (p) => color(p.margin)).style('fill-opacity', .5).style('stroke', (p) => color(p.margin));
      svg.append('path').datum(rows).attr('d', d3.line().x((p) => x(parse(p.end_date))).y((p) => y(p.avg5)))
        .style('fill', 'none').style('stroke', 'var(--fg)').style('stroke-width', 2).style('stroke-linecap', 'round').style('stroke-linejoin', 'round');
      const lx = x(parse(lastPt.end_date)), ly = y(lastPt.avg5);
      svg.append('circle').attr('cx', lx).attr('cy', ly).attr('r', 3.5).style('fill', 'var(--fg)');
      svg.append('text').attr('class', 'ed-endlabel').attr('x', lx + 8).attr('y', ly).attr('dy', '0.32em')
        .style('fill', color(lastPt.avg5)).text(label(lastPt.avg5));

      // Tooltip for the poll nearest the pointer.
      const tip = mk('div', 'ed-tip');
      tip.hidden = true;
      chart.append(tip);
      const hi = svg.append('circle').attr('r', 6).style('fill', 'none').style('stroke', 'var(--fg)').style('stroke-width', 1.5).style('display', 'none');
      const del = d3.Delaunay.from(pts);
      const hide = () => { tip.hidden = true; hi.style('display', 'none'); };
      svg.append('rect').attr('width', W).attr('height', H).style('fill', 'transparent')
        .on('pointermove', (ev) => {
          const [mx, my] = d3.pointer(ev);
          const i = del.find(mx, my), p = rows[i];
          if (Math.hypot(pts[i][0] - mx, pts[i][1] - my) > 40) return hide();
          hi.attr('cx', pts[i][0]).attr('cy', pts[i][1]).style('display', null);
          tip.replaceChildren(
            mk('div', 'ed-tip-k', `${fmtDate(parse(p.end_date))} · ${p.pollster}`),
            mk('div', '', `${race.dem_candidate} ${p.dem_pct}% · ${race.rep_candidate} ${p.rep_pct}%`),
            mk('div', 'ed-tip-k', `${label(p.margin, 0)}${p.sample_size ? ` · ${fmtN(p.sample_size)}` : ''} ${p.population}`));
          tip.hidden = false;
          const scale = chart.clientWidth / W, tw = tip.offsetWidth;
          tip.style.left = Math.min(Math.max(0, pts[i][0] * scale - tw / 2), chart.clientWidth - tw) + 'px';
          tip.style.top = Math.max(0, pts[i][1] * scale - tip.offsetHeight - 12) + 'px';
        })
        .on('pointerleave', hide);
    }
  }

  function footer(races, meta, results) {
    const at = meta && meta.polls_checked_at ? new Date(meta.polls_checked_at) : null;
    const asOf = results.map((r) => r.as_of).filter(Boolean).sort().pop();
    const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
    $('#ed-updated').textContent = [
      at ? `Polls checked ${fmt.format(at)}.` : '',
      asOf ? `Returns as of ${fmt.format(new Date(asOf))}.` : '',
    ].join(' ').trim();
    const src = $('#ed-sources');
    src.replaceChildren('Wikipedia contributors (');
    races.forEach((r, i) => {
      const a = mk('a', '', r.race_name);
      a.href = `https://en.wikipedia.org/wiki/${r.wiki_article}`;
      src.append(a, i < races.length - 1 ? ', ' : ')');
    });
  }
})();
