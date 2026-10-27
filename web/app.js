/* SyncStore control room client.
   The simulation and the four agents run on the server. This page only renders the
   snapshots it receives over a WebSocket (about 4 per second) and sends user actions back. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var NS = 'http://www.w3.org/2000/svg';
  var D = null, snapAt = 0, ws = null, retry = 0, lastPanel = 0;
  var current = 'overview', logFilter = 'all', ledgerAll = false, cart = [], cartChoice = {};
  var MODS = ['overview', 'captain', 'ledger', 'relay', 'promise', 'optimiser', 'coordination', 'log', 'about'];
  var MODES = ['trough', 'normal', 'peak', 'surge'];
  var MODE_LABEL = { trough: 'Trough', normal: 'Normal', peak: 'Peak', surge: 'Surge' };
  var NAMES = { ledger: 'Ledger', relay: 'Relay', promise: 'Promise', captain: 'Captain', system: 'System', opt: 'Optimiser' };
  var STATUS = { pool: ['Waiting to batch', 'c-info'], picking: ['Being picked', 'c-relay'], bench: ['Bench queue', 'c-warn'], packing: ['Packing', 'c-warn'], ready: ['Bag ready', 'c-good'] };
  var STEPS = [
    ['peak', 'Surge alert', 'Captain schedules Peak'], ['empty', 'Empty slot', 'Ledger hides the item'],
    ['liveorders', 'Live orders', 'Promise applies saved choices'], ['count', 'Count result', 'Ledger corrects the record'],
    ['surge', 'Surge', 'Zone pick-and-merge'], ['riderlate', 'Rider late', 'Relay re-orders releases'],
    ['winddown', 'Wind-down', 'Hysteresis steps down'], ['summary', 'Shift summary', 'Captain briefs in Hindi']
  ];
  var CROSS_Y = 400, PX_M = 0.05;
  function rackX(i) { return 70 + (i - 1) * 104; }
  function CX(i) { return rackX(i) + 66; }
  var SLOT_Y = [120, 210, 300], FWD_Y = 350;

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(t) { var s = 66600 + Math.floor(t); return pad(Math.floor(s / 3600) % 24) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); }
  function fmtHM(t) { return fmt(t).slice(0, 5); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + pad(s % 60); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, 3400); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function card(title, sub, body, right) { return '<div class="card"><div class="card-h"><h3>' + title + '</h3>' + (sub ? '<span class="sub">' + sub + '</span>' : '') + (right ? '<div class="right">' + right + '</div>' : '') + '</div><div class="card-b">' + body + '</div></div>'; }
  function stats(list) { return '<div class="stats">' + list.map(function (s) { return '<div class="stat"><span class="v">' + s[0] + '</span><span class="l">' + s[1] + '</span></div>'; }).join('') + '</div>'; }
  function meter(v, max, color, label) { return '<div class="meter"><span class="mono">' + label + '</span><div class="bar" style="flex:1"><i style="width:' + Math.max(2, Math.min(100, v / max * 100)) + '%;background:' + color + '"></i></div></div>'; }
  function sku(id) { for (var i = 0; i < D.skus.length; i++) if (D.skus[i].id === id) return D.skus[i]; return null; }
  function viaChip(l) {
    var v = l.via || 'rules';
    if (v === 'llm') return '<span class="via via-llm" title="Decided by the LLM' + (l.meta && l.meta.model ? ' (' + esc(l.meta.model) + ', ' + l.meta.ms + ' ms)' : '') + '">LLM</span>';
    if (v === 'guardrail') return '<span class="via via-block">Guardrail</span>';
    if (v === 'policy' || v === 'rule') return '<span class="via via-code">Code</span>';
    if (v === 'shift lead') return '<span class="via via-human">Shift lead</span>';
    return '<span class="via via-rules">Rules</span>';
  }
  function feedList(agent, n, empty) {
    var f = D.log.filter(function (l) { return l.agent === agent; }).slice(0, n);
    return '<ul class="feed">' + (f.length ? f.map(function (l) { return '<li><span class="tm">' + fmtHM(l.t) + '</span><span>' + viaChip(l) + ' ' + (l.shadow ? '<span class="would">Would have: </span>' : '') + esc(l.text) + (l.why ? '<span class="why">Why: ' + esc(l.why) + '</span>' : '') + '</span></li>'; }).join('') : '<li><span class="tm">—</span><span class="note">' + (empty || 'No actions yet.') + '</span></li>') + '</ul>';
  }

  // ---------------------------------------------------------------- connection
  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    setConn('Connecting', 'm-off');
    ws = new WebSocket(url);
    ws.onopen = function () { retry = 0; setConn('Connected', 'm-normal'); };
    ws.onmessage = function (e) {
      var m = JSON.parse(e.data);
      if (m.type === 'snap') { D = m; snapAt = performance.now(); if (!buildMap.done) buildMap(); }
      else if (m.type === 'toast') toast(m.text);
      else if (m.type === 'full') { setConn('Server full', 'm-surge'); toast(m.text); retry = 6; }
    };
    ws.onclose = function () { setConn('Reconnecting', 'm-peak'); retry = Math.min(retry + 1, 6); setTimeout(connect, 600 * retry); };
  }
  function setConn(t, cls) { var p = $('#conn'); p.textContent = t; p.className = 'pill ' + cls; }

  // ---------------------------------------------------------------- map
  var pickerEls = [], skuEls = {}, heatEls = [], riderG, bagG, ringG;
  function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function txt(parent, x, y, s, cls, anchor) { var t = el('text', { x: x, y: y, class: cls, 'text-anchor': anchor || 'start' }, parent); t.textContent = s; return t; }
  function buildMap() {
    buildMap.done = true;
    var svg = $('#map'); svg.innerHTML = '';
    el('rect', { x: 0, y: 0, width: 1000, height: 560, class: 'mf' }, svg);
    for (var gx = 20; gx < 1000; gx += 40) el('line', { x1: gx, y1: 0, x2: gx, y2: 560, class: 'mg' }, svg);
    for (var gy = 20; gy < 560; gy += 40) el('line', { x1: 0, y1: gy, x2: 1000, y2: gy, class: 'mg' }, svg);
    el('rect', { x: rackX(6) - 14, y: 40, width: CX(7) + 32 - (rackX(6) - 14), height: 340, class: 'mchill', rx: 4 }, svg);
    el('rect', { x: rackX(8) - 14, y: 40, width: CX(8) + 30 - (rackX(8) - 14), height: 340, class: 'mfrozen', rx: 4 }, svg);
    txt(svg, (rackX(6) + CX(7)) / 2 + 4, 32, 'CHILLED', 'mlabel', 'middle');
    txt(svg, (rackX(8) + CX(8)) / 2 + 4, 32, 'FROZEN', 'mlabel', 'middle');
    for (var i = 1; i <= 8; i++) {
      heatEls[i] = el('rect', { x: CX(i) - 14, y: 70, width: 28, height: 300, class: 'heat', opacity: 0, rx: 3 }, svg);
      el('rect', { x: rackX(i), y: 70, width: 36, height: 300, class: 'mrack', rx: 2 }, svg);
      txt(svg, rackX(i) + 18, 392, 'A' + i, 'mlabel', 'middle');
    }
    el('line', { x1: 110, y1: CROSS_Y + 1, x2: 890, y2: CROSS_Y + 1, class: 'mzone' }, svg);
    txt(svg, 116, CROSS_Y + 26, 'CROSS AISLE', 'mlabel', 'start');
    el('line', { x1: (CX(4) + rackX(5)) / 2, y1: 50, x2: (CX(4) + rackX(5)) / 2, y2: 380, class: 'mzone', id: 'zoneLine', opacity: 0 }, svg);
    txt(svg, CX(2), 60, 'ZONE A', 'mtitle', 'middle').setAttribute('id', 'zA');
    txt(svg, CX(6), 60, 'ZONE B', 'mtitle', 'middle').setAttribute('id', 'zB');
    el('rect', { x: 360, y: 462, width: 280, height: 60, class: 'mbench', rx: 4 }, svg);
    txt(svg, 500, 545, 'PACKING BENCH · 2 PACKERS', 'mlabel', 'middle');
    bagG = el('g', {}, svg);
    el('rect', { x: 908, y: 70, width: 80, height: 452, class: 'mbay', rx: 4 }, svg);
    txt(svg, 948, 545, 'RIDER BAY', 'mlabel', 'middle');
    txt(svg, 948, 94, '', 'mlabel', 'middle').setAttribute('id', 'riderCount');
    riderG = el('g', {}, svg);
    el('rect', { x: 20, y: 462, width: 200, height: 60, class: 'mbay', rx: 4 }, svg);
    txt(svg, 120, 497, 'BACKROOM', 'mlabel', 'middle');
    el('line', { x1: 700, y1: 545, x2: 800, y2: 545, stroke: 'var(--muted)', 'stroke-width': 2 }, svg);
    el('line', { x1: 700, y1: 540, x2: 700, y2: 550, stroke: 'var(--muted)', 'stroke-width': 2 }, svg);
    el('line', { x1: 800, y1: 540, x2: 800, y2: 550, stroke: 'var(--muted)', 'stroke-width': 2 }, svg);
    txt(svg, 750, 535, '5 m', 'mlabel', 'middle');
    ringG = el('g', {}, svg);
    var skuG = el('g', {}, svg);
    D.skus.forEach(function (s) { var g = el('g', {}, skuG), r = el('rect', { width: 12, height: 22, rx: 2, class: 'sku-live' }, g), tt = el('title', {}, g); tt.textContent = s.name; skuEls[s.id] = { g: g, r: r, t: tt }; });
    el('g', { id: 'pickers' }, svg);
    pickerEls = [];
    var sel = $('#emptySku'); sel.innerHTML = '';
    D.skus.forEach(function (s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
    sel.value = 'eggs';
  }
  function posOf(s) { return { x: CX(s.aisle), y: s.fwd ? FWD_Y : SLOT_Y[s.slot] }; }
  function posAt(pts, t) {
    if (t <= pts[0][2]) return { x: pts[0][0], y: pts[0][1] };
    var L = pts[pts.length - 1]; if (t >= L[2]) return { x: L[0], y: L[1] };
    for (var i = 1; i < pts.length; i++) if (t <= pts[i][2]) { var a = pts[i - 1], b = pts[i], f = b[2] === a[2] ? 1 : (t - a[2]) / (b[2] - a[2]); return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f }; }
    return { x: L[0], y: L[1] };
  }
  function pickerEl(i) {
    if (pickerEls[i]) return pickerEls[i];
    var g = el('g', { class: 'pk idle' }, $('#pickers'));
    el('circle', { r: 15 }, g);
    var tx = el('text', { x: 0, y: 1 }, g);
    var b = el('rect', { x: 9, y: -24, width: 18, height: 16, rx: 3, class: 'badge' }, g);
    var bt = el('text', { x: 18, y: -15.5, class: 'badge-t', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
    var title = el('title', {}, g);
    return (pickerEls[i] = { g: g, tx: tx, b: b, bt: bt, title: title });
  }
  function simNow() {
    if (!D) return 0;
    if (!D.playing || D.thinking) return D.t;
    return Math.min(D.t + (performance.now() - snapAt) / 1000 * D.speed, D.t + D.speed * 0.4);
  }
  function drawMap() {
    if (current !== 'overview' || !D || !buildMap.done) return;
    var tf = simNow(), heat = [0, 0, 0, 0, 0, 0, 0, 0, 0], idleIdx = 0;
    var pg = $('#pickers'); while (pickerEls.length > D.pickers.length) { var e0 = pickerEls.pop(); pg.removeChild(e0.g); }
    D.pickers.forEach(function (p, i) {
      var e = pickerEl(i), pos, cls = 'idle', n = 0;
      if (p.trip) {
        pos = posAt(p.trip.pts, tf); n = p.trip.n;
        cls = p.trip.zone ? 'zone' : n > 1 ? 'cluster' : 'discrete';
        for (var a = 1; a <= 8; a++) if (Math.abs(pos.x - CX(a)) < 1 && pos.y < CROSS_Y - 2) heat[a]++;
      } else if (p.joining) { pos = { x: 60 + i * 4, y: 440 }; cls = 'idle joining'; }
      else { pos = { x: 390 + (idleIdx % 8) * 31, y: 440 }; idleIdx++; }
      e.g.setAttribute('transform', 'translate(' + pos.x.toFixed(1) + ',' + pos.y.toFixed(1) + ')');
      e.g.setAttribute('class', 'pk ' + cls);
      e.tx.textContent = p.name[0];
      e.b.style.display = n > 1 ? '' : 'none'; e.bt.style.display = n > 1 ? '' : 'none'; e.bt.textContent = n;
      e.title.textContent = p.name + (p.floater ? ' (floater)' : '') + (p.trip ? ' · ' + (p.trip.zone ? 'Zone ' + p.trip.zone : n > 1 ? 'Cluster, ' + n + ' orders' : 'Single order') : p.joining ? ' · joining soon' : ' · idle');
    });
    for (var a = 1; a <= 8; a++) heatEls[a].setAttribute('opacity', heat[a] >= 2 ? 0.28 : 0);
  }
  function drawMapSlow() {
    if (!buildMap.done) return;
    D.skus.forEach(function (s) {
      var e = skuEls[s.id]; if (!e) return; var p = posOf(s);
      e.g.setAttribute('transform', 'translate(' + (rackX(s.aisle) + 24) + ',' + (p.y - 11) + ')');
      e.r.setAttribute('class', s.status === 'out' ? 'sku-out' : s.hidden ? 'sku-hidden' : (D.layer === 'live' && s.trust < 0.7) ? 'sku-low' : 'sku-live');
      e.t.textContent = s.name + ' · record ' + s.record + ', shelf ' + s.shelf + ', trust ' + s.trust.toFixed(2);
    });
    ringG.innerHTML = '';
    D.skus.forEach(function (s) { if (s.counting || s.status === 'refilling') { var p = posOf(s); el('circle', { cx: rackX(s.aisle) + 30, cy: p.y, r: 20, class: 'count-ring' }, ringG); } });
    riderG.innerHTML = '';
    for (var i = 0; i < Math.min(18, D.riders); i++) el('circle', { cx: 930 + (i % 2) * 36, cy: 125 + Math.floor(i / 2) * 42, r: 12, class: 'rider' }, riderG);
    $('#riderCount').textContent = D.riders + (D.riders === 1 ? ' RIDER' : ' RIDERS');
    bagG.innerHTML = '';
    for (var j = 0; j < Math.min(D.bench.ready, 16); j++) el('rect', { x: 372 + (j % 8) * 18, y: 472 + Math.floor(j / 8) * 20, width: 13, height: 15, rx: 2, class: 'bag' }, bagG);
    txt(bagG, 628, 497, D.bench.ready + ' ready · ' + D.bench.q + ' queued', 'mlabel', 'end');
    var zone = D.layer === 'live' && D.mode === 'surge';
    $('#zoneLine').setAttribute('opacity', zone ? 1 : 0); $('#zA').style.opacity = zone ? 1 : 0; $('#zB').style.opacity = zone ? 1 : 0;
  }

  // ---------------------------------------------------------------- shared helpers
  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
  function deltaTxt(a, b, lowerBetter) {
    if (!b) return '';
    var d = Math.round((a - b) / b * 100), good = lowerBetter ? d < 0 : d > 0;
    return '<span class="delta ' + (d === 0 ? '' : good ? 'good-t' : 'bad-t') + '">' + (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) + '%</span>';
  }
  function trustMeter(v) { return meter(v, 1, v < 0.35 ? 'var(--bad)' : v < 0.7 ? 'var(--warn)' : 'var(--good)', v.toFixed(2)); }
  function skuStatus(s) {
    if (s.status === 'out') return '<span class="chip c-bad">Out · reorder sent</span>';
    if (s.status === 'hidden') return '<span class="chip c-bad">Hidden in app</span>';
    if (s.status === 'counting') return '<span class="chip c-warn">Count task out</span>';
    if (s.status === 'refilling') return '<span class="chip c-warn">Refilling</span>';
    if (s.status === 'checking') return '<span class="chip c-info">Checking</span>';
    if (s.trust < 0.7) return '<span class="chip c-promise">Low-stock note</span>';
    return '<span class="chip c-good">Live</span>';
  }
  function lastOf(agent) { var l = D.log.find(function (x) { return x.agent === agent; }); return l ? fmtHM(l.t) + ' · ' + (l.shadow ? 'Would have: ' : '') + l.text : 'No action yet.'; }
  function agentRuntime(name) {
    var a = D.agents[name], th = D.thinking && D.thinking.agent === name;
    var model = D.llm.models[a.tier];
    var src = D.llmOn ? 'Groq · ' + model : 'Rules (LLM off)';
    return stats([[a.decisions, 'Decisions'], [a.llm, 'By the LLM'], [a.rules, 'By rules'], [a.blocked, 'Blocked by guardrails'], [a.avg_ms ? a.avg_ms + ' ms' : '—', 'Avg LLM latency']]) +
      '<p class="note">' + (th ? '<b class="warn-t">Thinking now</b> · ' : '') + 'Decides with: <b>' + esc(src) + '</b>. Wakes on: ' + a.triggers.map(function (t) { return '<code>' + t + '</code>'; }).join(', ') + '. Tools: ' + a.tools.map(function (t) { return '<code>' + t + '</code>'; }).join(', ') + '.' + (a.last_fallback ? ' Last fallback to rules: ' + esc(a.last_fallback) + '.' : '') + '</p>';
  }
  function tightest() { var b = null; D.orders.forEach(function (o) { if (o.slack !== undefined && (!b || o.slack < b.slack)) b = o; }); return b; }

  // ---------------------------------------------------------------- overview
  function kpi(label, v, cmp) { return '<div class="kpi"><span class="lbl">' + label + '</span><span class="v">' + v + '</span><span class="cmp">' + cmp + '</span></div>'; }
  function renderKpis() {
    var S = D.stats, X = D.staticStats;
    var oS = pct(S.onTime, S.done), oX = pct(X.onTime, X.done);
    $('#kpis').innerHTML =
      kpi('Average pick time', S.avgPick ? S.avgPick.toFixed(0) + '<small> s</small>' : '—', deltaTxt(S.avgPick, X.avgPick, true) + ' vs static plan (' + (X.avgPick ? X.avgPick.toFixed(0) : '—') + ' s). Case target 67.5 s') +
      kpi('Stockout cancellations', S.cancels + '<small> orders</small>', (X.cancels ? deltaTxt(S.cancels, X.cancels, true) + ' vs ' : 'Static plan: ') + X.cancels + ' in the static plan. Target −40%') +
      kpi('Bags ready on time', S.done ? oS + '<small>%</small>' : '—', 'Static plan ' + (X.done ? oX + '%' : '—') + '. The 10-minute promise is never extended') +
      kpi('Walking per order', S.walkPerOrder.toFixed(0) + '<small> m</small>', deltaTxt(S.walkPerOrder, X.walkPerOrder, true) + ' vs ' + X.walkPerOrder.toFixed(0) + ' m in the static plan') +
      kpi('Wrong records caught', String(S.hidden + S.fixed), S.swaps + ' customer-chosen swaps, ' + S.refunds + ' items refunded');
  }
  function renderStory() {
    $('#story').innerHTML = STEPS.map(function (s, i) {
      var at = D.story[s[0]];
      return '<div class="step' + (at !== undefined ? ' done' : '') + '"><span class="n">' + (i + 1) + ' · ' + (at !== undefined ? fmtHM(at) : '--:--') + '</span><b>' + s[1] + '</b><span>' + s[2] + '</span></div>';
    }).join('');
  }
  function renderCards() {
    var pend = D.approvals.filter(function (a) { return a.status === 'pending'; }).length;
    var hidden = D.skus.filter(function (s) { return s.hidden; }).length, tight = tightest();
    var avgB = D.stats.batches ? D.stats.batchedOrders / D.stats.batches : 0;
    var cards = [
      ['captain', 'Captain', 'Shift-lead copilot', [[D.layer === 'live' ? MODE_LABEL[D.mode] : 'Off', 'mode'], [D.uNow.toFixed(2), 'utilisation'], [D.uFc.toFixed(2), 'forecast'], [pend, 'awaiting approval']]],
      ['ledger', 'Ledger', 'Inventory truth', [[D.stats.hidden + D.stats.fixed, 'records fixed'], [hidden, 'hidden now'], [D.stats.notFound, '“not found” taps']]],
      ['relay', 'Relay', 'Rider-first release', [[D.activeCount, 'live orders'], [tight ? tight.slack + ' s' : '—', 'tightest buffer'], [D.bench.q, 'bags queued']]],
      ['promise', 'Promise', 'Customer swap choices', [[D.stats.swaps, 'chosen swaps'], [D.stats.refunds, 'items refunded'], [D.stats.autoSwaps, 'automatic swaps']]],
      ['opt', 'Optimiser', 'Plain code', [[D.layer === 'live' ? D.methods[D.mode] : 'Discrete', ''], [avgB.toFixed(2), 'orders per trip'], [D.pool, 'in batching pool']]]
    ];
    $('#agentCards').innerHTML = cards.map(function (c) {
      var target = c[0] === 'opt' ? 'optimiser' : c[0], a = D.agents[c[0]], th = D.thinking && D.thinking.agent === c[0];
      var badge = a ? '<span class="via ' + (th ? 'via-think' : D.llmOn ? 'via-llm' : 'via-rules') + '">' + (th ? 'Thinking…' : D.llmOn ? 'LLM ' + a.llm + ' · rules ' + a.rules : 'Rules ' + a.rules) + '</span>' : '<span class="via via-code">Code</span>';
      return '<div class="agent"><div class="name"><span class="tag t-' + c[0] + '"><i></i>' + c[1] + '</span><b>' + c[2] + '</b>' + badge + '</div><button class="btn link" type="button" data-nav="' + target + '">Open</button>' +
        '<div class="nums">' + c[3].map(function (n) { return '<span><b>' + n[0] + '</b>' + n[1] + '</span>'; }).join('') + '</div>' +
        (c[0] === 'opt' ? '<div class="last">Batches, routes and assigns pickers every 5 s.</div>' : '<div class="last">' + esc(lastOf(c[0])) + '</div>') + '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- captain
  function renderCaptain() {
    var modes = '<div class="modes">' + MODES.map(function (k) {
      var lim = D.limits[k];
      return '<div class="mode m-' + k + (D.layer === 'live' && D.mode === k ? ' on' : '') + '"><b>' + MODE_LABEL[k] + '</b><span>' + D.methods[k] + '</span><span>Up to ' + lim.max + ' per trolley</span><span>Hold up to ' + lim.hold + ' s</span></div>';
    }).join('') + '</div>';
    var left = card('Agent runtime', 'Captain · ' + D.agents.captain.tier + ' model', agentRuntime('captain')) +
      card('Operating mode', D.layer === 'live' ? 'Now: ' + MODE_LABEL[D.mode] : 'Agents are not driving the floor',
        modes + stats([[D.uNow.toFixed(2), 'Utilisation now'], [D.uFc.toFixed(2), 'Forecast in 15 min'], [D.N, 'Pickers on the floor'], [D.down + '/3', 'Calm minutes to step down']]) +
        '<p class="note">Captain’s sense code raises a mode signal when a threshold is crossed. The decision (mode, limits, staffing, briefing) is the LLM’s; stepping down needs 3 calm minutes, enforced in code.</p>') +
      card('Demand forecast', 'Orders per minute', forecastSvg() + '<p class="note">Solid line: actual orders (3-minute average). Dashed line: forecast for the next 15 minutes.</p>');
    var pend = D.approvals.filter(function (a) { return a.status === 'pending'; });
    var ap = pend.length ? pend.map(function (a) { return '<div class="approval"><p><b>Needs the shift lead:</b> ' + esc(a.text) + '</p><button class="btn small primary" data-action="approve" data-id="' + a.id + '">Approve</button><button class="btn small" data-action="decline" data-id="' + a.id + '">Decline</button></div>'; }).join('') : '<p class="note">No requests waiting. Captain asks before acting above its limits, such as calling a floater picker.</p>';
    ap += '<label class="check"><input type="checkbox" id="autoApprove"' + (D.autoApprove ? ' checked' : '') + '><span>Shift lead answers by voice within 20 s (auto-approve for the demo)</span></label>';
    var b = D.brief;
    var voice = b ? '<div class="voice"><div class="hi" lang="hi">' + esc(b.hi) + '</div><div class="en">' + esc(b.en) + '</div></div>' : '<p class="note">No briefing yet. Captain speaks when the mode changes.</p>';
    var rules = '<ol class="rules"><li>Safety and compliance<span>Cold chain, restricted items, labour limits</span></li><li>Promise to the customer<span>Never breach an order’s time buffer (' + D.stats.bufferHolds + ' early releases so far)</span></li><li>Completeness<span>Full basket, or the swap the customer chose</span></li><li>Efficiency<span>Walking, batching, cost</span></li></ol>';
    var right = card('Shift lead', 'Requests above Captain’s limits', ap) +
      card('Voice briefing', b ? 'Latest at ' + fmtHM(b.t) + ', in Hindi' : 'In Hindi', voice, '<button class="btn small" type="button" data-action="speak"' + (b ? '' : ' disabled') + '>Play</button>') +
      card('Conflict rules', 'Applied in this order', rules) + card('Recent actions', '', feedList('captain', 6));
    $('#captain').innerHTML = '<div class="stack">' + left + '</div><div class="stack">' + right + '</div>';
  }
  function lambdaAt(t) { var m = t / 60; return 1.6 + 2.8 * Math.exp(-Math.pow((m - 45) / 17, 2)); }
  function forecastSvg() {
    var W = 560, H = 220, L = 40, R = 28, T = 16, B = 30, t = D.t, x0 = t - 1800, x1 = t + 900, ymax = 6;
    var sx = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }, sy = function (v) { return T + (1 - v / ymax) * (H - T - B); };
    var peakL = 0.8 * D.N / 1.5, surgeL = 0.92 * D.N / 1.5;
    var s = '<svg id="fc" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Orders per minute, last 30 minutes and 15-minute forecast">';
    [0, 2, 4, 6].forEach(function (v) { s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(v) + '" y2="' + sy(v) + '" stroke="var(--line-2)"/><text x="' + (L - 8) + '" y="' + (sy(v) + 5) + '" text-anchor="end" fill="var(--muted)" font-family="var(--mono)" font-size="13">' + v + '</text>'; });
    var m0 = Math.floor(t / 60), pts = [];
    for (var m = Math.max(0, m0 - 30); m < m0; m++) { var a3 = 0, k3 = 0; for (var j = Math.max(0, m - 2); j <= m; j++) { a3 += D.arrMin[j] || 0; k3++; } pts.push([sx(m * 60 + 30), sy(Math.min(ymax, a3 / k3))]); }
    if (pts.length > 1) {
      var line = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L');
      s += '<path d="' + line + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + sy(0) + ' L' + pts[0][0].toFixed(1) + ',' + sy(0) + ' Z" fill="var(--captain)" opacity="0.1"/><path d="' + line + '" fill="none" stroke="var(--captain)" stroke-width="2.25"/>';
    }
    var f = []; for (var k = 0; k <= 15; k++) f.push(sx(t + k * 60).toFixed(1) + ',' + sy(Math.min(ymax, lambdaAt(t + k * 60))).toFixed(1));
    s += '<path d="M' + f.join(' L') + '" fill="none" stroke="var(--captain)" stroke-width="2.25" stroke-dasharray="6 5"/>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(peakL) + '" y2="' + sy(peakL) + '" stroke="var(--warn)" stroke-dasharray="2 4" stroke-width="1.75"/><text x="' + (L + 6) + '" y="' + (sy(peakL) + 16) + '" fill="var(--warn)" font-size="13" font-family="var(--mono)">Peak threshold</text>';
    if (surgeL < ymax) s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(surgeL) + '" y2="' + sy(surgeL) + '" stroke="var(--bad)" stroke-dasharray="2 4" stroke-width="1.75"/><text x="' + (W - R) + '" y="' + (sy(surgeL) - 6) + '" text-anchor="end" fill="var(--bad)" font-size="13" font-family="var(--mono)">Surge threshold</text>';
    s += '<line x1="' + sx(t) + '" x2="' + sx(t) + '" y1="' + T + '" y2="' + sy(0) + '" stroke="var(--ink)" stroke-width="1.25"/><text x="' + (sx(t) + 6) + '" y="' + (T + 10) + '" fill="var(--ink)" font-size="13" font-family="var(--mono)">now</text>';
    [x0, t - 900, t, t + 900].forEach(function (v) { s += '<text x="' + sx(v) + '" y="' + (H - 8) + '" text-anchor="middle" fill="var(--muted)" font-size="13" font-family="var(--mono)">' + fmtHM(Math.max(0, v)) + '</text>'; });
    return s + '</svg>';
  }

  // ---------------------------------------------------------------- ledger
  function renderLedger() {
    var list = D.skus.slice(), rank = function (s) { return s.status === 'live' ? (s.trust < 0.7 ? 1 : 2) : 0; };
    list.sort(function (a, b) { return rank(a) - rank(b) || a.trust - b.trust; });
    var shown = ledgerAll ? list : list.slice(0, 10), phantom = list.filter(function (s) { return s.record > s.shelf; }).length;
    var h = stats([[D.stats.notFound, '“Not found” taps received'], [D.stats.hidden + D.stats.fixed, 'Wrong records caught and fixed'], [phantom, 'Records above the real shelf now'], [list.filter(function (s) { return s.hidden; }).length, 'Items hidden in the app now']]);
    var tbl = '<div class="tbl-wrap"><table><thead><tr><th>Item</th><th class="n">Aisle</th><th class="n">Record</th><th class="n">Shelf</th><th>Trust score</th><th>Status</th><th></th></tr></thead><tbody>';
    shown.forEach(function (s) {
      tbl += '<tr><td>' + esc(s.name) + '</td><td class="n">A' + s.aisle + '</td><td class="n">' + s.record + '</td><td class="n' + (s.record > s.shelf ? ' bad-t' : '') + '">' + s.shelf + '</td><td style="min-width:170px">' + trustMeter(s.trust) + '</td><td>' + skuStatus(s) + '</td><td><button class="btn small" data-action="empty" data-id="' + s.id + '"' + (s.shelf === 0 ? ' disabled' : '') + '>Empty shelf</button></td></tr>';
    });
    tbl += '</tbody></table></div><p class="note">The shelf column is the real count, which the store system cannot see. It is shown so you can watch Ledger close the gap.</p>';
    $('#ledger').innerHTML = card('Agent runtime', 'Ledger · ' + D.agents.ledger.tier + ' model', agentRuntime('ledger')) + h + card('Item trust', 'Lowest trust first', tbl) +
      '<div class="cols">' + card('Recent actions', 'With the reason the agent gave', feedList('ledger', 8)) + card('When Ledger wakes up', '', '<ul class="rules" style="list-style:disc"><li><code>pick_not_found</code>: a picker taps “not found”</li><li><code>trust_drift</code>: its own sense code sees trust below 0.60 with no recent count</li><li><code>count_result</code> and <code>refill_done</code>: the floor reports back</li></ul><p class="note">Hiding an item can be undone, so Ledger acts on its own. Guardrails stop it restoring an item without a count, or writing a record that doesn’t match the count.</p>') + '</div>';
    $('#ledgerAll').textContent = ledgerAll ? 'Show fewer items' : 'Show all ' + list.length + ' items';
  }

  // ---------------------------------------------------------------- relay
  function renderRelay() {
    var h = stats([[D.activeCount, 'Live orders'], [D.riders, 'Riders at the store'], [mmss(D.stats.riderWaitAvg), 'Average rider wait (static plan ' + mmss(D.staticStats.riderWaitAvg) + ')'], [D.bench.q, 'Bags queued at the bench'], [D.releasePolicy.bench_cap + ' / ' + D.releasePolicy.pace_slack + ' s', 'Bench cap / pace slack']]);
    var tbl = '<div class="tbl-wrap"><table><thead><tr><th>Order</th><th class="n">Items</th><th>Rider</th><th>Time buffer</th><th>Status</th><th></th></tr></thead><tbody>';
    D.orders.slice(0, 12).forEach(function (o) {
      var rider = o.riderIn > 0 ? 'arrives in ' + mmss(o.riderIn) : '<span class="warn-t">waiting ' + mmss(-o.riderIn) + '</span>';
      var buf = '<span class="note">—</span>';
      if (o.slack !== undefined) { var sl = o.slack; buf = meter(Math.max(0, sl), 240, sl < D.buffer ? 'var(--bad)' : sl < 90 ? 'var(--warn)' : 'var(--good)', (sl < 0 ? '−' : '') + Math.abs(sl) + ' s'); }
      var st = STATUS[o.status] || [o.status, 'c-mute'];
      tbl += '<tr><td class="mono">#' + o.id + (o.user ? '<span class="you">Your order</span>' : '') + (o.boost ? ' <span class="chip c-relay">Boosted</span>' : '') + '</td><td class="n">' + o.items + '</td><td class="mono">' + rider + '</td><td style="min-width:180px">' + buf + '</td><td><span class="chip ' + st[1] + '">' + st[0] + '</span></td><td>' + ((o.status === 'pool' || o.status === 'picking') ? '<button class="btn small" data-action="late" data-id="' + o.id + '">Rider late</button>' : '') + '</td></tr>';
    });
    if (!D.orders.length) tbl += '<tr><td colspan="6" class="note">No live orders right now.</td></tr>';
    tbl += '</tbody></table></div><p class="note">Time buffer is the earlier of the handover deadline and the rider’s arrival, minus pick and pack time. Below 45 s an order is released at once.</p>';
    $('#relay').innerHTML = card('Agent runtime', 'Relay · ' + D.agents.relay.tier + ' model', agentRuntime('relay')) + h + card('Release queue', D.layer === 'live' ? 'Tightest buffer first' : 'Static plan on the floor', tbl) + card('Recent actions', 'With the reason the agent gave', feedList('relay', 6));
  }

  // ---------------------------------------------------------------- promise
  function renderPromise() {
    var h = stats([[D.stats.asked, 'Asked at checkout'], [D.stats.swaps, 'Customer-chosen swaps applied'], [D.stats.refunds, 'Items refunded instantly'], [D.stats.notified, 'Customer updates sent'], [D.stats.autoSwaps, 'Automatic swaps']]);
    var pick = '<div class="shelf-picker">' + D.checkout.map(function (id) { return '<button type="button" data-action="cart" data-id="' + id + '" aria-pressed="' + (cart.indexOf(id) >= 0) + '">' + esc(sku(id).name) + '</button>'; }).join('') + '</div><p class="note">Add up to 4 items. Low-trust items trigger the checkout question. Empty a shelf in Ledger to make an item unavailable.</p>';
    var c = '<div class="cart">', total = 0;
    if (!cart.length) c += '<p class="note">Your cart is empty.</p>';
    cart.forEach(function (id) {
      var s = sku(id), alt = D.swaps[id]; total += s.price;
      c += '<div class="cart-item"><div class="top-line"><span>' + esc(s.name) + '</span><span class="mono">₹' + s.price + '</span></div>';
      if (s.hidden) c += '<div class="ask"><span class="bad-t"><b>Unavailable right now.</b></span>' + (alt ? '<label><input type="radio" name="c-' + id + '" data-action="choice" data-id="' + id + '" value="swap"' + (cartChoice[id] !== 'refund' ? ' checked' : '') + '> Add ' + esc(alt.name) + ' (₹' + alt.price + ') instead</label><label><input type="radio" name="c-' + id + '" data-action="choice" data-id="' + id + '" value="refund"' + (cartChoice[id] === 'refund' ? ' checked' : '') + '> Remove it</label>' : '<span>It will be removed from the order.</span>') + '</div>';
      else if (s.trust < 0.7) c += '<div class="ask"><span><b>Running low.</b> If it’s gone when we pick your order:</span>' + (alt ? '<label><input type="radio" name="c-' + id + '" data-action="choice" data-id="' + id + '" value="swap"' + (cartChoice[id] === 'swap' ? ' checked' : '') + '> Swap for ' + esc(alt.name) + ' (₹' + alt.price + ')</label>' : '') + '<label><input type="radio" name="c-' + id + '" data-action="choice" data-id="' + id + '" value="refund"' + (cartChoice[id] !== 'swap' ? ' checked' : '') + '> Refund this item</label></div>';
      else c += '<span class="note">In stock · trust ' + s.trust.toFixed(2) + '</span>';
      c += '</div>';
    });
    if (cart.length) c += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="mono">Total ₹' + total + '</span><button class="btn primary" type="button" data-action="place">Place order</button></div><p class="note">Delivery in 10 minutes. The promise doesn’t change when stock is low.</p>';
    c += '</div>';
    $('#promise').innerHTML = card('Agent runtime', 'Promise · ' + D.agents.promise.tier + ' model', agentRuntime('promise')) + h + '<div class="cols">' + card('Try the checkout', 'Pick items', pick) + card('Your cart', cart.length + ' of 4 items', c) + '</div>' + card('Recent recoveries', 'Saved choices applied mid-pick', feedList('promise', 6, 'Nothing to recover yet. When an item goes missing in a live order, Promise applies the customer’s saved choice or refunds that item.'));
  }

  // ---------------------------------------------------------------- optimiser
  function renderOpt() {
    var t = D.t, trips = D.pickers.filter(function (p) { return p.trip; }).map(function (p) { return p.trip; });
    var seen = {}; trips = trips.filter(function (x) { if (seen[x.id]) return false; seen[x.id] = 1; return true; });
    var avgB = D.stats.batches ? D.stats.batchedOrders / D.stats.batches : 0;
    var h = stats([[D.layer === 'live' ? D.methods[D.mode] : 'Discrete', 'Picking method now'], [avgB.toFixed(2), 'Orders per trolley trip'], [D.pool, 'Orders in the batching pool'], [D.stats.reroutes, 'Routes bent around busy aisles']]);
    var tr = '<div class="trolleys">' + (trips.length ? trips.map(function (x) {
      var prog = Math.min(100, Math.round((t - x.start) / Math.max(1, x.end - x.start) * 100));
      var method = x.zone ? 'Zone ' + x.zone : x.n > 1 ? 'Cluster' : 'Single';
      return '<div class="trolley"><div class="who"><span>' + esc(x.picker) + '</span><span class="chip ' + (x.zone ? 'c-relay' : x.n > 1 ? 'c-info' : 'c-mute') + '">' + method + '</span></div><div class="totes">' + x.ids.map(function (o) { return '<span class="tote">#' + o + '</span>'; }).join('') + '</div><span class="note">' + x.stops + ' stops · ' + Math.round(x.len * PX_M) + ' m · back in ' + mmss(x.end - t) + '</span><div class="prog"><i style="width:' + prog + '%"></i></div></div>';
    }).join('') : '<p class="note">All pickers are at the bench.</p>') + '</div>';
    var dec = '<div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Method</th><th>Orders</th><th class="n">Walk saved</th><th>Why released</th></tr></thead><tbody>';
    D.decisions.slice(0, 8).forEach(function (d) { dec += '<tr><td class="mono">' + fmt(d.t) + '</td><td>' + d.method + '</td><td class="mono">' + d.ids.map(function (i) { return '#' + i; }).join(' ') + '</td><td class="n">' + (d.save ? d.save + '%' : '—') + '</td><td>' + esc(d.reason) + '</td></tr>'; });
    if (!D.decisions.length) dec += '<tr><td colspan="5" class="note">' + (D.layer === 'live' ? 'No decisions yet.' : 'The static plan is picking: first in, first out.') + '</td></tr>';
    dec += '</tbody></table></div>';
    var how = '<ol class="rules"><li>Pool unreleased orders and compute each one’s time buffer</li><li>Seed with the order that has the least time (Relay’s boosts first)</li><li>Add the order that saves the most walking, keeping every buffer above 45 s</li><li>Release when the trolley is full, a buffer runs low, or Captain’s hold cap is reached</li><li>Route: Ledger’s low-trust items first, chilled and frozen last; bend around busy aisles at most twice</li></ol>';
    $('#opt').innerHTML = h + card('On the floor now', trips.length + ' trolleys out', tr) + '<div class="cols wide-left">' + card('Latest decisions', 'Newest first', dec) + card('How a batch is formed', 'Seed-and-grow, every 5 s, no LLM', how) + '</div>';
  }

  // ---------------------------------------------------------------- coordination
  function renderCoord() {
    var trace = '<div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Decided by</th><th>Actions</th><th>Blocked</th></tr></thead><tbody>';
    D.trace.slice(0, 14).forEach(function (r) {
      var by = r.via === 'llm' ? '<span class="via via-llm">LLM</span> <span class="note">' + esc(r.model || '') + (r.ms ? ' · ' + r.ms + ' ms' : '') + '</span>' : '<span class="via via-rules">Rules</span>' + (r.fallback ? ' <span class="note">(' + esc(r.fallback) + ')</span>' : '');
      if (r.filled) by += ' <span class="note">+ rules filled ' + esc(r.filled.join(', ')) + '</span>';
      var tbl_row = '<tr><td class="mono">' + fmt(r.t) + '</td><td><code>' + r.event + '</code><span class="why">' + esc(r.detail) + '</span></td><td><span class="tag t-' + r.agent + '"><i></i>' + NAMES[r.agent] + '</span></td><td>' + by + '</td><td style="font-size:15px">' + (r.actions.length ? r.actions.map(function (a) { return '<code>' + a + '</code>'; }).join(' ') : '<span class="note">none</span>') + (r.shadow ? ' <span class="would">(shadow)</span>' : '') + '</td><td class="n">' + (r.blocked.length ? '<span class="bad-t">' + r.blocked.length + '</span>' : '0') + '</td></tr>';
      trace += tbl_row;
    });
    if (!D.trace.length) trace += '<tr><td colspan="6" class="note">No agent decisions yet.</td></tr>';
    trace += '</tbody></table></div><p class="note">Every event is routed to the agents that subscribe to it, in order, and the chain completes before the next simulated second. Example: <code>pick_not_found</code> → Ledger hides the item → its write emits <code>sku_hidden</code> → Promise resolves the affected orders.</p>';
    $('#trace').innerHTML = trace;
    $('#state').innerHTML = '<table><thead><tr><th>Field</th><th>Written only by</th><th>Read by</th><th>Live value</th></tr></thead><tbody>' + D.stateRows.map(function (r) { return '<tr><td><b>' + r.field + '</b></td><td><span class="tag t-' + r.owner + '"><i></i>' + NAMES[r.owner] + '</span></td><td>' + r.readers + '</td><td class="mono" style="font-size:15px">' + esc(r.live) + '</td></tr>'; }).join('') + '</tbody></table>';
    var blocked = 0; for (var k in D.agents) blocked += D.agents[k].blocked;
    var items = [
      [true, 'The 10-minute promise is a hard limit', D.stats.bufferHolds + ' orders released early to protect their time buffer. No tool can extend the promise.'],
      [D.lim.hold <= 90, 'Hold cap within the ops bound', 'Now ' + D.lim.hold + ' s; bound 90 s. Captain proposals above it are blocked.'],
      [D.lim.max <= 4, 'Trolley size within the ops bound', 'Now ' + D.lim.max + ' orders; bound 4'],
      [true, 'Field ownership', 'Each shared-state field has one writer; a write by any other agent raises an error'],
      [D.stats.autoSwaps === 0, 'No automatic swaps', 'Only the swap the customer chose, same category, same-or-higher value'],
      [true, 'LLM proposals are checked', blocked + ' agent actions blocked so far; skipped required steps are filled by rules'],
      [D.layer !== 'off', 'Fail-safe', D.layer === 'off' ? 'Agent layer is off: the store runs today’s static picking and orders keep flowing' : 'If the agent layer or the LLM fails, rules take over and the store keeps running'],
      [true, 'No speed league tables', 'Picker data is used for routing, never for ranking pickers']
    ];
    $('#guard').innerHTML = '<ul class="guard">' + items.map(function (g) { return '<li><span class="ok' + (g[0] ? '' : ' alert') + '" aria-hidden="true">' + (g[0] ? '✓' : '!') + '</span><span><b>' + g[1] + '</b><small>' + g[2] + '</small></span></li>'; }).join('') + '</ul>';
    var L = D.llm;
    $('#llmCard').innerHTML = stats([[L.configured ? (D.llmOn ? 'On' : 'Paused') : 'No key', 'Groq LLM'], [L.calls, 'Calls this server run'], [L.errors, 'Errors (fell back to rules)'], [L.rpm_used + '/' + L.rpm_limit, 'Calls in the last minute'], [L.rpd_used + '/' + L.rpd_limit, 'Calls today']]) +
      '<p class="note">Models: smart <code>' + esc(L.models.smart) + '</code> (Captain, Promise), fast <code>' + esc(L.models.fast) + '</code> (Ledger, Relay). ' + (L.last_error ? 'Last error: ' + esc(L.last_error) + '. ' : '') + (L.cooling ? 'Cooling down for ' + L.cooling + ' s. ' : '') + 'The optimiser never calls the LLM.</p>';
  }

  // ---------------------------------------------------------------- log
  function renderLog() {
    var list = D.log.filter(function (l) { return logFilter === 'all' || l.agent === logFilter; }).slice(0, 80);
    $('#log').innerHTML = list.length ? list.map(function (l) {
      return '<li><span class="tm">' + fmt(l.t) + '</span><span class="tag t-' + l.agent + '"><i></i>' + NAMES[l.agent] + '</span><span class="txt">' + viaChip(l) + ' ' + (l.shadow ? '<span class="would">Would have: </span>' : '') + esc(l.text) + (l.why ? '<span class="why">Why: ' + esc(l.why) + '</span>' : '') + (l.hi ? '<span class="hi" lang="hi">' + esc(l.hi) + '</span>' : '') + '</span></li>';
    }).join('') : '<li><span class="tm">—</span><span></span><span class="note">No actions yet for this filter.</span></li>';
  }

  // ---------------------------------------------------------------- frame
  function renderTop() {
    $('#clock').textContent = fmt(D.t);
    var pill = $('#modePill');
    pill.className = 'pill m-' + (D.layer === 'off' ? 'off' : D.mode);
    pill.textContent = D.layer === 'off' ? 'Agents off · static' : MODE_LABEL[D.mode] + ' mode' + (D.layer === 'shadow' ? ' (shadow)' : '');
    $('#play').textContent = D.playing ? 'Pause' : 'Play';
    if (document.activeElement !== $('#speed')) $('#speed').value = String(D.speed);
    document.querySelectorAll('[data-layer]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.layer === D.layer)); });
    document.querySelectorAll('[data-llm]').forEach(function (b) { b.setAttribute('aria-pressed', String((b.dataset.llm === '1') === D.llmOn)); b.disabled = b.dataset.llm === '1' && !D.llm.configured; });
    var th = $('#thinking');
    th.hidden = !D.thinking; if (D.thinking) th.textContent = NAMES[D.thinking.agent] + ' is thinking…';
    $('#floorMethod').textContent = D.layer === 'shadow' ? 'Static plan on the floor' : D.layer === 'off' ? 'Fallback: discrete picking' : D.methods[D.mode] + ' picking';
    $('#floorRole').textContent = D.layer === 'shadow' ? 'Today’s static plan runs; agents only log' : 'Pickers, aisles, packing bench and rider bay';
    var pend = D.approvals.filter(function (a) { return a.status === 'pending'; }).length, hidden = D.skus.filter(function (s) { return s.hidden; }).length;
    setCount('captain', pend ? pend + ' waiting' : '', pend > 0);
    setCount('ledger', hidden ? hidden + ' hidden' : '', hidden > 0);
    setCount('relay', String(D.activeCount));
    setCount('promise', D.stats.swaps ? D.stats.swaps + ' swaps' : '');
    setCount('optimiser', D.pool ? D.pool + ' pooled' : '');
    setCount('coordination', D.trace.length ? String(D.trace.length) : '');
    setCount('log', String(D.log.length));
  }
  function setCount(k, v, alert) { var e = $('#nc-' + k); if (!e) return; e.textContent = v; e.className = 'count' + (alert ? ' alert' : ''); }
  function renderPanels() {
    if (!D) return;
    renderTop();
    if (current === 'overview') { renderKpis(); renderCards(); renderStory(); drawMapSlow(); }
    else if (current === 'captain') renderCaptain();
    else if (current === 'ledger') renderLedger();
    else if (current === 'relay') renderRelay();
    else if (current === 'promise') renderPromise();
    else if (current === 'optimiser') renderOpt();
    else if (current === 'coordination') renderCoord();
    else if (current === 'log') renderLog();
  }
  function interacting() { var a = document.activeElement; return a && (a.tagName === 'SELECT' || a.tagName === 'INPUT') && a.closest('main'); }
  function show(m) {
    if (MODS.indexOf(m) < 0) m = 'overview';
    current = m;
    MODS.forEach(function (k) { $('#mod-' + k).hidden = k !== m; });
    document.querySelectorAll('.nav[data-nav]').forEach(function (b) { b.setAttribute('aria-current', b.dataset.nav === m ? 'page' : 'false'); });
    try { history.replaceState(null, '', '#' + m); } catch (e) {}
    renderPanels();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', function (e) {
    var n = e.target.closest('[data-nav]'); if (n) { show(n.dataset.nav); window.scrollTo(0, 0); return; }
    var b = e.target.closest('[data-action]'); if (!b) return;
    var a = b.dataset.action, id = b.dataset.id;
    if (a === 'approve') send({ cmd: 'approve', id: id });
    else if (a === 'decline') send({ cmd: 'decline', id: id });
    else if (a === 'empty') send({ cmd: 'empty', sku: id });
    else if (a === 'late') send({ cmd: 'late', order_id: Number(id) });
    else if (a === 'cart') { var i = cart.indexOf(id); if (i >= 0) cart.splice(i, 1); else if (cart.length < 4) cart.push(id); else toast('The sample cart holds up to 4 items.'); renderPromise(); }
    else if (a === 'place') { if (cart.length) { send({ cmd: 'place', cart: cart, choices: cartChoice }); cart = []; cartChoice = {}; renderPromise(); } }
    else if (a === 'speak') speak();
  });
  document.addEventListener('change', function (e) {
    var b = e.target;
    if (b.dataset && b.dataset.action === 'choice') cartChoice[b.dataset.id] = b.value;
    if (b.id === 'autoApprove') send({ cmd: 'auto_approve', value: b.checked });
  });
  function speak() {
    var b = D && D.brief; if (!b) return;
    try {
      if (!('speechSynthesis' in window)) throw new Error('none');
      var u = new SpeechSynthesisUtterance(b.hi); u.lang = 'hi-IN'; u.rate = 0.95;
      var v = window.speechSynthesis.getVoices().filter(function (x) { return /^hi/i.test(x.lang); })[0]; if (v) u.voice = v;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch (err) { toast('Voice playback isn’t available in this browser. The text is shown instead.'); }
  }
  $('#play').addEventListener('click', function () { send({ cmd: 'play' }); });
  $('#speed').addEventListener('change', function (e) { send({ cmd: 'speed', value: Number(e.target.value) }); e.target.blur(); });
  $('#reset').addEventListener('click', function () { send({ cmd: 'reset' }); });
  $('#demo').addEventListener('click', function () { send({ cmd: 'demo' }); show('overview'); });
  document.querySelectorAll('[data-layer]').forEach(function (b) { b.addEventListener('click', function () { send({ cmd: 'layer', value: b.dataset.layer }); }); });
  document.querySelectorAll('[data-llm]').forEach(function (b) { b.addEventListener('click', function () { send({ cmd: 'llm', value: b.dataset.llm === '1' }); }); });
  document.querySelectorAll('#filters [data-f]').forEach(function (b) { b.addEventListener('click', function () { logFilter = b.dataset.f; document.querySelectorAll('#filters [data-f]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); renderLog(); }); });
  $('#ledgerAll').addEventListener('click', function () { ledgerAll = !ledgerAll; renderLedger(); });
  $('#doEmpty').addEventListener('click', function () { send({ cmd: 'empty', sku: $('#emptySku').value }); });
  $('#doLate').addEventListener('click', function () { send({ cmd: 'late' }); });
  $('#doSpike').addEventListener('click', function () { send({ cmd: 'spike' }); });

  function loop(now) {
    drawMap();
    if (D && now - lastPanel > 400 && !interacting()) { lastPanel = now; renderPanels(); }
    requestAnimationFrame(loop);
  }
  try { var hh = document.getElementById('top').offsetHeight; document.documentElement.style.setProperty('--head-h', hh + 'px'); } catch (e) {}
  var start = (location.hash || '').replace('#', '');
  current = MODS.indexOf(start) >= 0 ? start : 'overview';
  MODS.forEach(function (k) { $('#mod-' + k).hidden = k !== current; });
  document.querySelectorAll('.nav[data-nav]').forEach(function (b) { b.setAttribute('aria-current', b.dataset.nav === current ? 'page' : 'false'); });
  connect();
  requestAnimationFrame(loop);
})();
