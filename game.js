/* Gate Crash: Act 1 (single bits).
   Modes:
   - local:  everything runs here, 1-2 players on one keyboard.
   - host:   runs the real game, sends snapshots to everyone else.
   - client: moves its own player locally (no input lag), sends position and grab presses,
             and draws everything else from the host's snapshots. */
(() => {
  'use strict';
  const W = 960, H = 600, PROC = 1.0, PR = 18, REACH = 34, SPEED = 250, MAXP = 4, SNAP_DT = 1 / 12, IN_DT = 1 / 15;
  const $ = s => document.querySelector(s);
  const cv = $('#floor'), ctx = cv.getContext('2d');
  let scale = 1;
  const css = getComputedStyle(document.documentElement);
  const C = {};
  'board panel chip sunk edge copper silk muted one zero danger ok gremlin p1 p2 p3 p4'.split(' ').forEach(k => C[k] = css.getPropertyValue('--' + k).trim());
  const PCOL = ['p1', 'p2', 'p3', 'p4'];
  const SPAWN = [[250, 160], [250, 260], [250, 360], [250, 460]];
  const F = { display: '"Silkscreen", "Courier New", monospace', mono: '"IBM Plex Mono", Menlo, monospace', body: '"Chakra Petch", system-ui, sans-serif' };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const coarse = window.matchMedia('(pointer:coarse)').matches;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);

  const GATE_FN = { NOT: i => i[0].v ^ 1, AND: i => i[0].v & i[1].v, OR: i => i[0].v | i[1].v };
  const TABLES = { NOT: [[0, 1], [1, 0]], AND: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]], OR: [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 1]] };
  const GATE_PATH = {
    AND: { body: 'M14 5H30A13 13 0 0 1 30 31H14Z', lead: 'M2 12H14M2 24H14M43 18H58' },
    OR: { body: 'M11 5Q32 5 44 18Q32 31 11 31Q19 18 11 5Z', lead: 'M2 12H15M2 24H15M44 18H58' },
    NOT: { body: 'M14 5L40 18L14 31Z', lead: 'M2 18H14M48 18H58' }
  };
  const P2D = {};
  for (const g in GATE_PATH) P2D[g] = { body: new Path2D(GATE_PATH[g].body), lead: new Path2D(GATE_PATH[g].lead) };

  const SOURCES = [
    { kind: 'src', v: 1, x: 95, y: 190, w: 110, h: 110, ref: 'J1' },
    { kind: 'src', v: 0, x: 95, y: 410, w: 110, h: 110, ref: 'J2' }
  ];
  const WIN = { kind: 'win', x: 880, y: 240, w: 110, h: 170, ref: 'J3' };
  const BIN = { kind: 'bin', x: 880, y: 480, w: 100, h: 90, ref: 'J4' };
  const mkMachine = (gate, ref, y, locked) => ({ kind: 'gate', gate, ref, x: 470, y, w: 170, h: 116, need: gate === 'NOT' ? 1 : 2, inputs: [], proc: 0, out: null, jam: false, locked });
  const mkPlayer = (slot, k, name, local, id) => ({ slot, id: id || null, x: SPAWN[k][0], y: SPAWN[k][1], tx: SPAWN[k][0], ty: SPAWN[k][1], fx: 1, fy: 0, hold: null, name, local, near: null, moving: false, deliv: 0, bonks: 0 });

  /* ---------- session state ---------- */
  let mode = 'local';            // local | host | client
  let phase = 'setup';           // setup | lobby | play | results
  let net = null, mySlot = 0, roomCode = '';
  let roster = [];               // [{slot, id, name}]  (id null for the host)
  let links = {};                // slot -> 'direct' | 'relay' (shown in lobby)
  let opts = { players: 1, len: 180, tables: true };
  let S = null, muted = false, audio = null, snapTimer = 0, inTimer = 0, lastSent = '';

  function fresh(o) {
    const ps = [];
    if (mode === 'local') {
      ps.push(mkPlayer(0, 0, 'P1', true));
      ps[0].y = ps[0].ty = o.players === 2 ? 230 : 300;
      if (o.players === 2) { ps.push(mkPlayer(1, 0, 'P2', true)); ps[1].y = ps[1].ty = 370; }
    } else {
      roster.forEach((r, k) => ps.push(mkPlayer(r.slot, k, r.name, mode === 'host' ? r.slot === 0 : r.slot === mySlot, r.id)));
    }
    return {
      running: false, paused: false, over: false, t: 0, len: o.len, players: ps, tables: o.tables,
      machines: [mkMachine('NOT', 'U1', 118, false), mkMachine('AND', 'U2', 300, false), mkMachine('OR', 'U3', 482, true)],
      gremlins: [], orders: [], orderId: 0, nextOrder: 1.2, meter: 0, score: 0,
      delivered: 0, missed: 0, wrong: 0, flips: 0, bonks: 0, floaters: [], orUnlocked: false, gremCount: 0, ev: []
    };
  }
  const stations = () => [...SOURCES, ...S.machines, WIN, BIN];
  const playing = () => phase === 'play' && S && !S.over;

  /* ---------- input ---------- */
  const keys = new Set();
  const DUO = [
    { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], act: ['KeyE', 'Space'] },
    { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], act: ['Enter', 'NumpadEnter', 'Slash', 'ShiftRight', 'Numpad0'] }
  ];
  const SOLO = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], act: ['KeyE', 'Space', 'Enter', 'NumpadEnter', 'Slash', 'ShiftRight'] };
  const binding = p => (mode === 'local' && S.players.length === 2) ? DUO[p.slot] : SOLO;
  const ALL_KEYS = new Set([...Object.values(SOLO).flat(), ...DUO.flatMap(d => Object.values(d).flat())]);
  const keyLabel = p => coarse ? 'GRAB' : (mode === 'local' && S.players.length === 2 && p.slot === 1 ? 'Enter' : 'E');
  const firstLocal = () => S && S.players.find(p => p.local);

  window.addEventListener('keydown', e => {
    if (!playing()) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (!e.repeat) { if (mode === 'client') toast('Only the host can pause.'); else togglePause(); }
      e.preventDefault(); return;
    }
    if (ALL_KEYS.has(e.code)) e.preventDefault();
    keys.add(e.code);
    if (!e.repeat && !S.paused) S.players.forEach(p => { if (p.local && binding(p).act.includes(e.code)) doAct(p); });
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  const touch = { x: 0, y: 0, id: null };
  const pad = $('#pad'), knob = $('#knob');
  function padMove(e) {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const max = r.width / 2 - 20, d = Math.hypot(dx, dy);
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    const m = Math.hypot(dx, dy) / max;
    touch.x = m > 0.18 ? dx / max : 0; touch.y = m > 0.18 ? dy / max : 0;
  }
  pad.addEventListener('pointerdown', e => { touch.id = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch (_) {} padMove(e); e.preventDefault(); });
  pad.addEventListener('pointermove', e => { if (e.pointerId === touch.id) padMove(e); });
  const padEnd = e => { if (e.pointerId === touch.id) { touch.id = null; touch.x = touch.y = 0; knob.style.transform = ''; } };
  pad.addEventListener('pointerup', padEnd); pad.addEventListener('pointercancel', padEnd);
  $('#grab').addEventListener('pointerdown', e => { e.preventDefault(); if (playing() && !S.paused) { const p = firstLocal(); if (p) doAct(p); } });

  function moveVec(p) {
    const b = binding(p); let x = 0, y = 0;
    if (b.left.some(k => keys.has(k))) x -= 1;
    if (b.right.some(k => keys.has(k))) x += 1;
    if (b.up.some(k => keys.has(k))) y -= 1;
    if (b.down.some(k => keys.has(k))) y += 1;
    if (p === firstLocal() && (touch.x || touch.y)) { x = touch.x; y = touch.y; }
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    return [x, y];
  }
  function doAct(p) {
    if (mode === 'client') { if (net) net.send({ t: 'act', x: Math.round(p.x), y: Math.round(p.y) }); }
    else act(p);
  }

  /* ---------- world rules ---------- */
  function pushOut(p) {
    for (const s of stations()) {
      const hw = s.w / 2 + PR, hh = s.h / 2 + PR, dx = p.x - s.x, dy = p.y - s.y;
      if (Math.abs(dx) < hw && Math.abs(dy) < hh) {
        const ox = hw - Math.abs(dx), oy = hh - Math.abs(dy);
        if (ox < oy) p.x += dx < 0 ? -ox : ox; else p.y += dy < 0 ? -oy : oy;
      }
    }
    p.x = clamp(p.x, PR + 4, W - PR - 4); p.y = clamp(p.y, PR + 4, H - PR - 4);
  }
  function separate(p) {
    for (const q of S.players) {
      if (q === p) continue;
      const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
      if (d > 0.01 && d < PR * 2) {
        const o = (PR * 2 - d) * (q.local ? 0.5 : 1);
        p.x += dx / d * o; p.y += dy / d * o; pushOut(p);
      }
    }
  }
  function nearest(p) {
    let best = null, bd = REACH + PR;
    for (const s of stations()) {
      const cx = clamp(p.x, s.x - s.w / 2, s.x + s.w / 2), cy = clamp(p.y, s.y - s.h / 2, s.y + s.h / 2);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function hintFor(p, s) {
    if (!s) return null;
    if (s.kind === 'src') return p.hold ? null : 'grab a ' + s.v;
    if (s.kind === 'gate') {
      if (s.locked || s.jam || s.proc > 0) return null;
      if (p.hold) return (!s.out && s.inputs.length < s.need) ? 'load input' : null;
      if (s.out) return 'take output';
      if (s.inputs.length) return 'take back';
      return null;
    }
    if (s.kind === 'win') return p.hold ? 'deliver' : null;
    if (s.kind === 'bin') return p.hold ? 'bin it' : null;
    return null;
  }
  function float(x, y, text, ck, big) {
    const f = { x: Math.round(x), y: Math.round(y), text, ck, big: !!big };
    addFloater(f);
    if (mode === 'host') S.ev.push(Object.assign({ k: 'fl' }, f));
  }
  function addFloater(f) { const life = f.big ? 2.2 : 1.2; S.floaters.push({ x: f.x, y: f.y, text: f.text, ck: f.ck, big: f.big, life, max: life }); }

  function act(p) {
    const s = p.near;
    if (!s) return;
    if (s.kind === 'src') {
      if (p.hold) { float(p.x, p.y - 80, 'Hands full', 'muted'); return; }
      p.hold = { v: s.v, gate: null }; sfx('grab', p.slot); return;
    }
    if (s.kind === 'gate') {
      if (s.locked) { float(s.x, s.y, 'Locked', 'muted'); return; }
      if (s.jam) { float(s.x, s.y - s.h / 2 - 30, 'Bonk Bitflip first!', 'danger'); sfx('wrong', p.slot); return; }
      if (s.proc > 0) { float(s.x, s.y - s.h / 2 - 30, 'Busy...', 'muted'); return; }
      if (p.hold) {
        if (s.out) { float(s.x, s.y - s.h / 2 - 30, 'Take the output first', 'muted'); return; }
        if (s.inputs.length >= s.need) return;
        s.inputs.push(p.hold); p.hold = null; sfx('load', p.slot);
        if (s.inputs.length === s.need) s.proc = PROC;
      } else {
        if (s.out) { p.hold = s.out; s.out = null; sfx('grab', p.slot); }
        else if (s.inputs.length) { p.hold = s.inputs.pop(); sfx('grab', p.slot); }
      }
      return;
    }
    if (s.kind === 'win') {
      if (!p.hold) { float(WIN.x, WIN.y - 110, 'Bring a finished bit', 'muted'); return; }
      deliver(p); return;
    }
    if (s.kind === 'bin' && p.hold) { p.hold = null; float(BIN.x, BIN.y - 70, 'Binned', 'muted'); sfx('load', p.slot); }
  }

  function deliver(p) {
    const b = p.hold; p.hold = null;
    const match = S.orders.filter(o => o.gate === b.gate && o.v === b.v).sort((a, c) => a.life - c.life)[0];
    if (match) {
      S.orders.splice(S.orders.indexOf(match), 1);
      const pts = 10 + Math.round(10 * match.life / match.max);
      S.score += pts; S.delivered++; p.deliv++; S.meter = Math.max(0, S.meter - 6);
      cardOut(match.id, 'done');
      float(WIN.x, WIN.y - 110, '+' + pts, 'ok'); sfx('deliver');
    } else {
      S.wrong++; S.meter += 8;
      float(WIN.x - 20, WIN.y - 110, b.gate ? 'No order wants ' + b.gate + ' = ' + b.v : 'Raw bit! Use a gate', 'danger');
      sfx('wrong');
    }
  }

  /* ---------- order rail ---------- */
  const rail = $('#orders'), noOrders = $('#noOrders');
  function gateSVG(g) {
    const bub = g === 'NOT' ? '<circle cx="44" cy="18" r="4"/>' : '';
    return `<svg viewBox="0 0 60 36" aria-hidden="true"><path class="lead" d="${GATE_PATH[g].lead}"/><path class="body" d="${GATE_PATH[g].body}"/>${bub}</svg>`;
  }
  function syncEmpty() { noOrders.hidden = !!rail.querySelector('.order:not(.done):not(.gone)'); }
  function addCard(o) {
    const el = document.createElement('div');
    el.className = 'order'; el.dataset.id = o.id;
    el.innerHTML = `<div class="ord-top">${gateSVG(o.gate)}<span class="eq">=</span><b class="bit b${o.v}">${o.v}</b></div><div class="ord-name">${o.gate} gate</div><div class="bar"><i></i></div>`;
    el.setAttribute('aria-label', `Order: ${o.gate} gate output ${o.v}`);
    rail.appendChild(el); o.bar = el.querySelector('.bar i'); o.el = el; syncEmpty();
  }
  function removeCard(id, how) {
    const el = rail.querySelector(`.order[data-id="${id}"]`);
    if (!el || el.classList.contains('done') || el.classList.contains('gone')) return;
    el.classList.add(how); syncEmpty();
    setTimeout(() => { el.remove(); syncEmpty(); }, reduce ? 0 : 320);
  }
  function cardOut(id, how) { removeCard(id, how); if (mode === 'host') S.ev.push({ k: 'oc', id, how }); }
  function clearCards() { rail.querySelectorAll('.order').forEach(e => e.remove()); syncEmpty(); }
  function spawnOrder(force) {
    const gates = ['NOT', 'AND']; if (S.orUnlocked) gates.push('OR');
    let g, v, tries = 0;
    do { g = force || pick(gates); v = Math.random() < 0.5 ? 0 : 1; tries++; }
    while (tries < 8 && S.orders.some(o => o.gate === g && o.v === v));
    const L = lerp(44, 24, S.t / S.len);
    const o = { id: ++S.orderId, gate: g, v, life: L, max: L };
    S.orders.push(o); addCard(o); sfx('order');
  }

  /* ---------- Bitflip ---------- */
  function spawnGremlin() {
    S.gremCount++;
    S.gremlins.push({ x: W / 2 + rnd(-60, 60), y: 26, state: 'wander', tx: W / 2, ty: H / 2, timer: 1.4, cool: 1.5, target: null, stun: 0, kx: 0, ky: 0, jamM: null, wob: Math.random() * 6, dir: 1 });
  }
  const jamSpot = m => ({ x: m.x, y: m.y - m.h / 2 - 2 });
  function decide(g, prog) {
    const carriers = S.players.filter(p => p.hold);
    const free = S.machines.filter(m => !m.locked && !m.jam && !S.gremlins.some(o => o !== g && o.target === m));
    const r = Math.random(), hunt = lerp(0.35, 0.65, prog), jam = lerp(0.2, 0.35, prog);
    g.state = 'wander';
    if (carriers.length && r < hunt) { g.target = pick(carriers); g.timer = 3.5; }
    else if (free.length && r < hunt + jam) { g.target = pick(free); g.timer = 7; }
    else { g.target = null; g.tx = rnd(60, W - 60); g.ty = rnd(60, H - 60); g.timer = 2.5; }
  }
  function collide(g) {
    for (const p of S.players) {
      const dx = g.x - p.x, dy = g.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d >= 36) continue;
      if (p.hold && g.cool <= 0) {
        p.hold.v ^= 1; S.flips++; g.cool = 2.5;
        float(p.x, p.y - 86, 'FLIPPED!', 'gremlin'); sfx('flip');
        if (g.state !== 'jam') { g.state = 'flee'; g.target = null; g.tx = clamp(g.x + dx / d * 260, 40, W - 40); g.ty = clamp(g.y + dy / d * 260, 40, H - 40); g.timer = 1.4; }
      } else if (!p.hold) {
        if (g.jamM) { g.jamM.jam = false; g.jamM = null; }
        g.state = 'stun'; g.stun = 2.2; g.target = null; g.kx = dx / d * 520; g.ky = dy / d * 520;
        S.bonks++; p.bonks++; float(g.x, g.y - 40, 'BONK!', 'silk'); sfx('bonk');
        return;
      }
    }
  }
  function updateGremlin(g, dt, prog) {
    g.wob += dt * 8; g.cool -= dt;
    g.x += g.kx * dt; g.y += g.ky * dt;
    const f = Math.exp(-5 * dt); g.kx *= f; g.ky *= f;
    g.x = clamp(g.x, 20, W - 20); g.y = clamp(g.y, 20, H - 20);
    if (g.state === 'stun') { g.stun -= dt; if (g.stun <= 0) { g.state = 'wander'; g.timer = 0; } return; }
    if (g.state === 'jam') {
      g.timer -= dt; const sp = jamSpot(g.jamM); g.x = sp.x; g.y = sp.y;
      if (g.timer <= 0) { g.jamM.jam = false; g.jamM = null; g.state = 'wander'; g.target = null; g.timer = 0; }
      collide(g); return;
    }
    g.timer -= dt; if (g.timer <= 0) decide(g, prog);
    if (g.target && g.target.kind !== 'gate' && !S.players.includes(g.target)) { g.target = null; g.timer = 0; }
    let tx, ty;
    if (g.target && g.target.kind === 'gate') { const sp = jamSpot(g.target); tx = sp.x; ty = sp.y; }
    else if (g.target) { if (!g.target.hold) g.timer = 0; tx = g.target.x; ty = g.target.y; }
    else { tx = g.tx; ty = g.ty; }
    const dx = tx - g.x, dy = ty - g.y, d = Math.hypot(dx, dy);
    const sp = lerp(105, 170, prog) * (g.state === 'flee' ? 1.5 : 1);
    if (d > 3) { const st = Math.min(d, sp * dt); g.x += dx / d * st; g.y += dy / d * st; if (Math.abs(dx) > 2) g.dir = dx < 0 ? -1 : 1; }
    if (g.target && g.target.kind === 'gate' && d < 12) {
      const m = g.target;
      if (!m.locked && !m.jam) { m.jam = true; g.jamM = m; g.state = 'jam'; g.timer = lerp(9, 14, prog); float(m.x + 110, m.y - m.h / 2 - 10, 'JAMMED!', 'danger'); sfx('jam'); }
      else g.timer = 0;
    } else if (!g.target && d < 6) g.timer = Math.min(g.timer, 0.3);
    collide(g);
  }

  /* ---------- simulation (local + host) ---------- */
  function update(dt) {
    S.t += dt; const prog = S.t / S.len, n = S.players.length;
    const second = n >= 3 ? 0.35 : 0.55;
    if (S.gremCount === 0 && prog >= 0.08) { spawnGremlin(); float(W / 2, H / 2 - 20, 'BITFLIP GOT IN!', 'gremlin', true); sfx('jam'); }
    if (!S.orUnlocked && prog >= 0.2) { S.orUnlocked = true; S.machines[2].locked = false; float(W / 2, H / 2 - 20, 'OR GATE ONLINE', 'ok', true); sfx('unlock'); spawnOrder('OR'); }
    if (S.gremCount === 1 && prog >= second) { spawnGremlin(); float(W / 2, H / 2 - 20, 'A SECOND BITFLIP!', 'gremlin', true); sfx('jam'); }
    if (S.gremCount === 2 && n === 4 && prog >= 0.7) { spawnGremlin(); float(W / 2, H / 2 - 20, 'A THIRD BITFLIP!', 'gremlin', true); sfx('jam'); }

    for (const p of S.players) {
      if (p.local) {
        const [x, y] = moveVec(p);
        p.moving = !!(x || y);
        if (p.moving) { p.fx = x; p.fy = y; p.x += x * SPEED * dt; p.y += y * SPEED * dt; }
        pushOut(p);
      } else {
        const k = 1 - Math.exp(-16 * dt);
        p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
      }
    }
    S.players.forEach(p => { if (p.local) separate(p); });
    S.players.forEach(p => p.near = nearest(p));

    for (const m of S.machines) {
      if (m.proc > 0 && !m.jam) {
        m.proc -= dt;
        if (m.proc <= 0) { m.proc = 0; m.out = { v: GATE_FN[m.gate](m.inputs), gate: m.gate }; m.inputs = []; sfx('ding'); }
      }
    }

    for (let k = S.orders.length - 1; k >= 0; k--) {
      const o = S.orders[k]; o.life -= dt;
      if (o.life <= 0) {
        S.orders.splice(k, 1); cardOut(o.id, 'gone');
        S.missed++; S.meter += 22;
        float(WIN.x - 30, WIN.y - 110, 'MISSED ' + o.gate + ' = ' + o.v, 'danger'); sfx('miss');
      } else bar(o);
    }
    S.nextOrder -= dt;
    const maxO = (prog < 0.3 ? 3 : 4) + (n >= 3 ? 1 : 0);
    if (S.nextOrder <= 0) { if (S.orders.length < maxO) spawnOrder(); S.nextOrder = lerp(13, 6.5, prog) / (1 + 0.22 * (n - 1)); }
    if (S.orders.length === 0 && S.nextOrder > 1.5) S.nextOrder = 1.5;

    S.gremlins.forEach(g => updateGremlin(g, dt, prog));
    tickFloaters(dt);
    S.meter = clamp(S.meter, 0, 100);
    hud();
    if (S.meter >= 100) end(false);
    else if (S.t >= S.len) end(true);
  }
  function bar(o) {
    if (!o.bar) return;
    o.bar.style.width = (clamp(o.life / o.max, 0, 1) * 100).toFixed(1) + '%';
    o.el.classList.toggle('urgent', o.life < 8);
  }
  function tickFloaters(dt) {
    for (let k = S.floaters.length - 1; k >= 0; k--) {
      const f = S.floaters[k]; f.life -= dt; if (!f.big && !reduce) f.y -= 30 * dt;
      if (f.life <= 0) S.floaters.splice(k, 1);
    }
  }

  /* ---------- host: snapshots ---------- */
  function snapshot() {
    return {
      t: 's', tm: +S.t.toFixed(2), len: S.len, m: Math.round(S.meter * 10) / 10, sc: S.score, pa: S.paused ? 1 : 0, tb: S.tables ? 1 : 0,
      p: S.players.map(p => [p.slot, Math.round(p.x), Math.round(p.y), +p.fx.toFixed(2), +p.fy.toFixed(2), p.moving ? 1 : 0, p.hold ? p.hold.v : -1, p.hold ? p.hold.gate : null]),
      mc: S.machines.map(m => [m.inputs.map(b => b.v), m.out ? m.out.v : -1, +m.proc.toFixed(2), m.jam ? 1 : 0, m.locked ? 1 : 0]),
      g: S.gremlins.map(g => [Math.round(g.x), Math.round(g.y), g.state === 'stun' ? 1 : 0, g.dir]),
      o: S.orders.map(o => [o.id, o.gate, o.v, +o.life.toFixed(1), +o.max.toFixed(1)]),
      ev: S.ev.splice(0)
    };
  }

  /* ---------- client: apply snapshots, predict own player ---------- */
  function applySnapshot(m) {
    if (!S || phase !== 'play') return;
    S.t = num(m.tm, S.t); S.len = num(m.len, S.len); S.meter = num(m.m, 0); S.score = num(m.sc, 0); S.tables = !!m.tb;
    const wasPaused = S.paused; S.paused = !!m.pa;
    if (S.paused !== wasPaused) showPause();

    for (const e of (m.ev || [])) {
      if (e.k === 'fl') addFloater(e);
      else if (e.k === 'sfx') { if (e.w == null || e.w === mySlot) play(e.n); }
      else if (e.k === 'oc') { removeCard(e.id, e.how === 'done' ? 'done' : 'gone'); S.orders = S.orders.filter(o => o.id !== e.id); }
    }

    const seen = new Set();
    for (const a of (m.p || [])) {
      const slot = a[0]; seen.add(slot);
      let p = S.players.find(q => q.slot === slot);
      if (!p) {
        const r = roster.find(q => q.slot === slot);
        p = mkPlayer(slot, clamp(slot, 0, 3), r ? r.name : 'P' + (slot + 1), slot === mySlot);
        p.x = p.tx = a[1]; p.y = p.ty = a[2];
        S.players.push(p);
      }
      if (!p.local) { p.tx = a[1]; p.ty = a[2]; p.fx = a[3]; p.fy = a[4]; p.moving = !!a[5]; }
      p.hold = a[6] < 0 ? null : { v: a[6] ? 1 : 0, gate: a[7] || null };
    }
    S.players = S.players.filter(p => seen.has(p.slot));

    (m.mc || []).forEach((a, k) => {
      const mc = S.machines[k]; if (!mc) return;
      mc.inputs = (a[0] || []).map(v => ({ v: v ? 1 : 0, gate: null }));
      mc.out = a[1] < 0 ? null : { v: a[1] ? 1 : 0, gate: mc.gate };
      mc.proc = num(a[2], 0); mc.jam = !!a[3]; mc.locked = !!a[4];
    });

    const gs = m.g || [];
    while (S.gremlins.length < gs.length) { const a = gs[S.gremlins.length]; S.gremlins.push({ x: a[0], y: a[1], tx: a[0], ty: a[1], state: 'wander', dir: 1, wob: Math.random() * 6 }); }
    S.gremlins.length = gs.length;
    gs.forEach((a, k) => { const g = S.gremlins[k]; g.tx = a[0]; g.ty = a[1]; g.state = a[2] ? 'stun' : 'wander'; g.dir = a[3] || 1; });

    const ids = new Set();
    for (const a of (m.o || [])) {
      ids.add(a[0]);
      let o = S.orders.find(q => q.id === a[0]);
      if (!o) {
        if (!GATE_PATH[a[1]]) continue;
        o = { id: a[0], gate: a[1], v: a[2] ? 1 : 0, life: a[3], max: a[4] };
        S.orders.push(o); addCard(o);
      }
      o.life = num(a[3], o.life); o.max = num(a[4], o.max);
    }
    for (const o of S.orders.filter(q => !ids.has(q.id))) removeCard(o.id, 'gone');
    S.orders = S.orders.filter(q => ids.has(q.id));
  }
  function clientUpdate(dt) {
    if (!S.paused) S.t = Math.min(S.len, S.t + dt);
    const me = firstLocal();
    if (me && !S.paused) {
      const [x, y] = moveVec(me);
      me.moving = !!(x || y);
      if (me.moving) { me.fx = x; me.fy = y; me.x += x * SPEED * dt; me.y += y * SPEED * dt; }
      pushOut(me); separate(me);
    }
    const k = 1 - Math.exp(-16 * dt);
    for (const p of S.players) if (!p.local) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
    for (const g of S.gremlins) { g.x += (g.tx - g.x) * k; g.y += (g.ty - g.y) * k; g.wob += dt * 8; }
    if (!S.paused) {
      for (const mc of S.machines) if (mc.proc > 0 && !mc.jam) mc.proc = Math.max(0, mc.proc - dt);
      for (const o of S.orders) { o.life -= dt; bar(o); }
    }
    if (me) me.near = nearest(me);
    tickFloaters(dt);
    hud();
    inTimer -= dt;
    if (me && net && inTimer <= 0) {
      inTimer = IN_DT;
      const msg = { t: 'in', x: Math.round(me.x), y: Math.round(me.y), fx: +me.fx.toFixed(2), fy: +me.fy.toFixed(2), mv: me.moving ? 1 : 0 };
      const key = msg.x + ',' + msg.y + ',' + msg.mv;
      if (key !== lastSent) { lastSent = key; net.send(msg); }
    }
  }

  /* ---------- drawing ---------- */
  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  let bg = null;
  function buildBg() {
    bg = document.createElement('canvas'); bg.width = W * 2; bg.height = H * 2;
    const g = bg.getContext('2d'); g.scale(2, 2);
    g.fillStyle = C.board; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(233,239,230,0.05)';
    for (let x = 15; x < W; x += 30) for (let y = 15; y < H; y += 30) g.fillRect(x - 1, y - 1, 2, 2);
    const r = mulberry(11); g.lineCap = 'round'; g.lineJoin = 'round';
    for (let n = 0; n < 48; n++) {
      let x = Math.round(r() * 32) * 30, y = Math.round(r() * 20) * 30;
      g.beginPath(); g.moveTo(x, y);
      const segs = 2 + Math.floor(r() * 3);
      for (let s = 0; s < segs; s++) {
        const dir = Math.floor(r() * 3), len = (2 + Math.floor(r() * 6)) * 30, sg = r() < 0.5 ? -1 : 1;
        if (dir === 0) x += sg * len; else if (dir === 1) y += sg * len; else { x += len * 0.7 * sg; y += len * 0.7 * (r() < 0.5 ? -1 : 1); }
        g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(200,135,63,0.15)'; g.lineWidth = 3; g.stroke();
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.strokeStyle = 'rgba(200,135,63,0.3)'; g.lineWidth = 2; g.stroke();
    }
    g.strokeStyle = 'rgba(233,239,230,0.12)'; g.lineWidth = 1.5; g.strokeRect(10, 10, W - 20, H - 20);
    g.fillStyle = 'rgba(233,239,230,0.25)'; g.font = '10px ' + F.display; g.textBaseline = 'alphabetic';
    g.textAlign = 'left'; g.fillText('LOGIC FOUNDRY  REV A1.2', 22, H - 20);
    g.textAlign = 'right'; g.fillText('CPU CITADEL  SUBLEVEL 2', W - 22, H - 20);
  }
  function label(text, x, y, color, align) {
    ctx.font = '11px ' + F.display; ctx.fillStyle = color || C.silk; ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }
  function drawBit(x, y, b, r, badge) {
    const col = b.v ? C.one : C.zero;
    ctx.save();
    ctx.shadowColor = col; ctx.shadowBlur = 14;
    ctx.fillStyle = C.sunk; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 2.5; ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = col; ctx.font = `700 ${Math.round(r * 1.3)}px ${F.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(b.v), x, y + 1);
    if (badge) {
      const t = b.gate || 'RAW';
      ctx.font = '9px ' + F.display; const tw = ctx.measureText(t).width + 8;
      ctx.fillStyle = b.gate ? C.silk : C.muted; rr(x - tw / 2, y + r + 3, tw, 13, 3); ctx.fill();
      ctx.fillStyle = C.sunk; ctx.fillText(t, x, y + r + 10);
    }
    ctx.restore();
  }
  function drawSource(s) {
    const L = s.x - s.w / 2, T = s.y - s.h / 2;
    ctx.fillStyle = C.chip; rr(L, T, s.w, s.h, 8); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.copper; ctx.stroke();
    label(`${s.ref} · SOURCE`, L, T - 8);
    const col = s.v ? C.one : C.zero;
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 18;
    ctx.fillStyle = col; ctx.font = `700 56px ${F.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(s.v), s.x, s.y - 6); ctx.restore();
    ctx.font = `500 12px ${F.body}`; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`endless ${s.v}s`, s.x, T + s.h - 12);
  }
  const slotPos = (m, k) => m.need === 1 ? [m.x - 64, m.y] : [m.x - 64, m.y - 26 + 52 * k];
  function drawGateIcon(g, cx, cy, s, color) {
    ctx.save(); ctx.translate(cx - 30 * s, cy - 18 * s); ctx.scale(s, s);
    ctx.lineWidth = 2; ctx.strokeStyle = C.copper; ctx.stroke(P2D[g].lead);
    ctx.lineWidth = 2.4; ctx.strokeStyle = color; ctx.fillStyle = 'rgba(233,239,230,0.06)';
    ctx.fill(P2D[g].body); ctx.stroke(P2D[g].body);
    if (g === 'NOT') { ctx.beginPath(); ctx.arc(44, 18, 4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
  function emptySlot(x, y, t) {
    ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = C.muted;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.font = '10px ' + F.display; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y + 1);
  }
  function drawMachine(m) {
    const L = m.x - m.w / 2, T = m.y - m.h / 2, R = L + m.w, B = T + m.h;
    ctx.fillStyle = C.copper;
    for (let px = L + 12; px < R - 8; px += 16) { ctx.fillRect(px, T - 6, 7, 6); ctx.fillRect(px, B, 7, 6); }
    ctx.fillStyle = C.chip; rr(L, T, m.w, m.h, 6); ctx.fill();
    ctx.lineWidth = m.jam ? 3 : 1.5; ctx.strokeStyle = m.jam ? C.danger : C.edge; ctx.stroke();
    ctx.fillStyle = C.board; ctx.beginPath(); ctx.arc(L, m.y, 8, -Math.PI / 2, Math.PI / 2); ctx.fill();
    label(`${m.ref} · ${m.gate}`, L, T - 12);
    drawGateIcon(m.gate, m.x - 2, m.y - 4, 1.25, C.silk);
    for (let k = 0; k < m.need; k++) {
      const [sx, sy] = slotPos(m, k);
      if (m.inputs[k]) drawBit(sx, sy, m.inputs[k], 13, false);
      else emptySlot(sx, sy, m.need === 1 ? 'A' : 'AB'[k]);
    }
    const ox = m.x + 66, oy = m.y - 6;
    if (m.out) drawBit(ox, oy, m.out, 13, true); else emptySlot(ox, oy, 'Q');
    if (m.proc > 0) {
      ctx.fillStyle = C.sunk; rr(L + 12, B - 13, m.w - 24, 5, 2); ctx.fill();
      ctx.fillStyle = m.jam ? C.danger : C.one; rr(L + 12, B - 13, (m.w - 24) * (1 - m.proc / PROC), 5, 2); ctx.fill();
    }
    if (m.locked) {
      ctx.fillStyle = 'rgba(6,22,20,0.82)'; rr(L - 2, T - 8, m.w + 4, m.h + 16, 6); ctx.fill();
      ctx.font = '700 16px ' + F.display; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('LOCKED', m.x, m.y - 6);
      ctx.font = `500 12px ${F.body}`; ctx.fillText('comes online mid-shift', m.x, m.y + 16);
    }
    if (S.tables && !m.locked) {
      const tx = R + 18, ty = T + 8, cw = 17, rh = 17;
      const cols = m.gate === 'NOT' ? ['A', 'Q'] : ['A', 'B', 'Q'];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '10px ' + F.display; ctx.fillStyle = C.muted;
      cols.forEach((c, k) => ctx.fillText(c, tx + k * cw + cw / 2, ty + rh / 2));
      ctx.strokeStyle = 'rgba(233,239,230,0.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tx, ty + rh); ctx.lineTo(tx + cols.length * cw, ty + rh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx + (cols.length - 1) * cw, ty + 2); ctx.lineTo(tx + (cols.length - 1) * cw, ty + rh * (TABLES[m.gate].length + 1)); ctx.stroke();
      ctx.font = `700 12px ${F.mono}`;
      TABLES[m.gate].forEach((row, ri) => row.forEach((v, k) => { ctx.fillStyle = v ? C.one : C.zero; ctx.fillText(String(v), tx + k * cw + cw / 2, ty + rh * (ri + 1) + rh / 2 + 1); }));
    }
  }
  function drawWin() {
    const L = WIN.x - WIN.w / 2, T = WIN.y - WIN.h / 2;
    ctx.fillStyle = C.chip; rr(L, T, WIN.w, WIN.h, 8); ctx.fill();
    ctx.save(); rr(L, T, WIN.w, 34, 8); ctx.clip();
    ctx.fillStyle = C.one; ctx.fillRect(L, T, WIN.w, 34);
    ctx.strokeStyle = C.sunk; ctx.lineWidth = 7;
    for (let x = L - 40; x < L + WIN.w + 40; x += 20) { ctx.beginPath(); ctx.moveTo(x, T + 34); ctx.lineTo(x + 34, T); ctx.stroke(); }
    ctx.restore();
    rr(L, T, WIN.w, WIN.h, 8); ctx.lineWidth = 2; ctx.strokeStyle = C.copper; ctx.stroke();
    label(`${WIN.ref} · ORDERS`, L, T - 8);
    ctx.fillStyle = C.silk; ctx.beginPath(); ctx.moveTo(WIN.x - 16, WIN.y - 8); ctx.lineTo(WIN.x + 14, WIN.y + 12); ctx.lineTo(WIN.x - 16, WIN.y + 32); ctx.closePath(); ctx.fill();
    ctx.font = `500 12px ${F.body}`; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('deliver gate bits', WIN.x, T + WIN.h - 14);
  }
  function drawBin() {
    const L = BIN.x - BIN.w / 2, T = BIN.y - BIN.h / 2;
    ctx.fillStyle = C.chip; rr(L, T, BIN.w, BIN.h, 8); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.edge; ctx.stroke();
    label(`${BIN.ref} · BIT BIN`, L, T - 8);
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(BIN.x - 16, BIN.y - 18); ctx.lineTo(BIN.x - 12, BIN.y + 16); ctx.lineTo(BIN.x + 12, BIN.y + 16); ctx.lineTo(BIN.x + 16, BIN.y - 18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(BIN.x - 20, BIN.y - 18); ctx.lineTo(BIN.x + 20, BIN.y - 18); ctx.stroke();
  }
  function highlight(s, color) {
    ctx.save(); ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = color;
    rr(s.x - s.w / 2 - 7, s.y - s.h / 2 - 7, s.w + 14, s.h + 14, 10); ctx.stroke(); ctx.restore();
  }
  function drawPlayer(p) {
    const col = C[PCOL[p.slot] || 'p1'];
    const bob = p.moving && !reduce ? Math.sin(performance.now() / 90 + p.slot) * 1.5 : 0;
    const x = p.x, y = p.y + bob;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + PR - 2, 16, 5, 0, 0, Math.PI * 2); ctx.fill();
    if (p.local && mode !== 'local') { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(p.x, p.y + PR - 2, 22, 8, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, PR, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.sunk; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 15, y - 10); ctx.lineTo(x + 3 + p.fx * 4, y - 40); ctx.lineTo(x + 15, y - 10); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.stroke();
    ctx.strokeStyle = C.copper; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 13, y - 13); ctx.lineTo(x + 13, y - 13); ctx.stroke();
    ctx.fillStyle = C.sunk;
    const ex = p.fx * 5, ey = p.fy * 3;
    ctx.beginPath(); ctx.arc(x - 5 + ex, y + 1 + ey, 2.6, 0, Math.PI * 2); ctx.arc(x + 5 + ex, y + 1 + ey, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px ' + F.display; ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(p.name, p.x, p.y + PR + 13);
    if (p.hold) drawBit(x, y - 64, p.hold, 13, true);
    const h = (phase === 'play' && p.local && !S.over) ? hintFor(p, p.near) : null;
    if (h) {
      const t = `[${keyLabel(p)}] ${h}`;
      ctx.font = `600 12px ${F.body}`; const tw = ctx.measureText(t).width + 12;
      const hx = clamp(p.x, tw / 2 + 4, W - tw / 2 - 4), hy = p.y + PR + 20;
      ctx.fillStyle = 'rgba(6,22,20,0.85)'; rr(hx - tw / 2, hy, tw, 19, 4); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = C.silk; ctx.textBaseline = 'middle'; ctx.fillText(t, hx, hy + 10);
    }
  }
  function drawGremlin(g) {
    const bob = reduce ? 0 : Math.sin(g.wob) * 2;
    ctx.save(); ctx.translate(g.x, g.y + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, 18 - bob, 15, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2 + g.wob * 0.05, r = i % 2 ? 12 : 19; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath();
    ctx.fillStyle = C.gremlin; ctx.shadowColor = C.gremlin; ctx.shadowBlur = g.state === 'stun' ? 0 : 14; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = C.silk; ctx.beginPath(); ctx.arc(-5, -3, 4.5, 0, Math.PI * 2); ctx.arc(5, -3, 4.5, 0, Math.PI * 2); ctx.fill();
    if (g.state === 'stun') {
      ctx.strokeStyle = C.sunk; ctx.lineWidth = 1.8;
      [-5, 5].forEach(ex => { ctx.beginPath(); ctx.moveTo(ex - 2.5, -5.5); ctx.lineTo(ex + 2.5, -0.5); ctx.moveTo(ex + 2.5, -5.5); ctx.lineTo(ex - 2.5, -0.5); ctx.stroke(); });
      ctx.fillStyle = C.one;
      for (let k = 0; k < 3; k++) { const a = g.wob * 0.7 + k * 2.09; ctx.beginPath(); ctx.arc(Math.cos(a) * 18, -26 + Math.sin(a) * 5, 3, 0, Math.PI * 2); ctx.fill(); }
    } else {
      ctx.fillStyle = C.sunk; ctx.beginPath(); ctx.arc(-5 + g.dir * 1.6, -2.5, 2, 0, Math.PI * 2); ctx.arc(5 + g.dir * 1.6, -2.5, 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.sunk; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 4, 6, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      ctx.font = '9px ' + F.display; ctx.fillStyle = C.gremlin; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('BITFLIP', 0, -25);
    }
    ctx.restore();
  }
  function drawFloaters() {
    for (const f of S.floaters) {
      const col = C[f.ck] || C.silk;
      ctx.globalAlpha = clamp(f.life / f.max * 1.6, 0, 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (f.big) {
        ctx.font = '700 28px ' + F.display; const tw = ctx.measureText(f.text).width + 40;
        ctx.fillStyle = 'rgba(6,22,20,0.85)'; rr(f.x - tw / 2, f.y - 26, tw, 52, 6); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = col; ctx.fillText(f.text, f.x, f.y + 1);
      } else {
        ctx.font = '700 15px ' + F.display; ctx.lineWidth = 4; ctx.strokeStyle = C.sunk; ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = col; ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }
  }
  function draw() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(bg, 0, 0, W, H);
    SOURCES.forEach(drawSource);
    S.machines.forEach(drawMachine);
    drawWin(); drawBin();
    if (phase === 'play' && !S.over) S.players.forEach(p => { if (p.local && p.near && hintFor(p, p.near)) highlight(p.near, C[PCOL[p.slot]]); });
    S.players.forEach(drawPlayer);
    S.gremlins.forEach(drawGremlin);
    drawFloaters();
  }

  /* ---------- HUD + panels ---------- */
  const fmt = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const timeEl = $('#time'), scoreEl = $('#score'), meterEl = $('#meter'), meterFill = $('#meterFill'), meterPct = $('#meterPct');
  function hud() {
    timeEl.textContent = fmt(S.len - S.t);
    scoreEl.textContent = S.score;
    const m = Math.round(S.meter);
    meterFill.style.width = m + '%'; meterPct.textContent = m + '%';
    meterEl.classList.toggle('hot', m >= 70);
  }
  const setup = $('#setup'), lobby = $('#lobby'), results = $('#results'), pauseOv = $('#pauseOv'), pauseBtn = $('#pauseBtn');
  const onlineMsg = $('#onlineMsg');
  function setMsg(text, kind) { onlineMsg.textContent = text || ''; onlineMsg.className = 'msg' + (kind ? ' ' + kind : ''); }
  let toastT = null;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2200); }
  const scrollTo = el => el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  function showPhase() {
    setup.hidden = phase !== 'setup';
    lobby.hidden = phase !== 'lobby';
    results.hidden = phase !== 'results';
    pauseBtn.disabled = !(phase === 'play' && mode !== 'client');
    if (phase !== 'play') { pauseOv.hidden = true; }
  }
  function showPause() {
    pauseOv.hidden = !S.paused;
    $('#pauseTitle').textContent = mode === 'client' ? 'Paused by the host' : 'Paused';
    $('#pauseActs').hidden = mode === 'client';
    pauseBtn.textContent = S.paused ? 'Resume' : 'Pause';
  }

  function readLocalOpts() {
    opts.players = +document.querySelector('input[name=players]:checked').value;
    opts.len = +document.querySelector('input[name=len]:checked').value;
    opts.tables = document.querySelector('input[name=tables]:checked').value === 'on';
  }
  function readHostOpts() {
    return { players: roster.length, len: +document.querySelector('input[name=olen]:checked').value, tables: document.querySelector('input[name=otables]:checked').value === 'on' };
  }

  function beginPlay(o) {
    initAudio(); clearCards(); keys.clear();
    opts = o; S = fresh(o); S.running = true; snapTimer = 0; inTimer = 0; lastSent = '';
    phase = 'play'; showPhase(); showPause(); hud();
    scrollTo($('#stage')); try { cv.focus({ preventScroll: true }); } catch (_) {}
  }
  function startLocal() { mode = 'local'; readLocalOpts(); beginPlay(Object.assign({}, opts)); }
  function startHosted() {
    const o = readHostOpts();
    beginPlay(o);
    net.broadcast({ t: 'start', o: { len: o.len, tables: o.tables }, r: rosterOut() });
  }
  function togglePause() {
    if (!playing() || mode === 'client') return;
    S.paused = !S.paused; keys.clear(); showPause();
    if (!S.paused) { try { cv.focus({ preventScroll: true }); } catch (_) {} }
  }
  function end(win, quit) {
    if (S.over) return;
    S.over = true; S.running = false; S.paused = false; keys.clear();
    S.gremlins.forEach(g => { if (g.jamM) g.jamM.jam = false; });
    const mins = Math.max(S.t / 60, 0.5), rate = S.delivered / mins;
    const per = rate / (1 + 0.35 * (S.players.length - 1));
    const res = {
      win: !!win, quit: !!quit, t: S.t, len: S.len,
      stars: win ? (per >= 4 ? 3 : per >= 2.5 ? 2 : 1) : 0,
      stats: [['Orders delivered', S.delivered], ['Orders missed', S.missed], ['Wrong deliveries', S.wrong], ['Bits flipped by Bitflip', S.flips], ['Bonks landed', S.bonks], ['Score', S.score]],
      team: S.players.map(p => [p.slot, p.name, p.deliv, p.bonks])
    };
    if (mode === 'host' && net) net.broadcast({ t: 'end', res });
    showResults(res);
    sfx(win ? 'win' : 'lose');
  }
  function showResults(res) {
    S.over = true; S.orders = []; clearCards();
    $('#resTitle').textContent = res.win ? 'Shift complete' : res.quit ? 'Shift ended early' : 'The foundry went dark';
    $('#resSub').textContent = res.win
      ? `You held the Null Meter under 100% for the whole ${fmt(res.len)} shift.`
      : res.quit ? `The shift ended at ${fmt(res.t)}.` : `The Null Meter hit 100% at ${fmt(res.t)} into the shift.`;
    document.querySelectorAll('#leds .led').forEach((l, k) => l.classList.toggle('on', k < res.stars));
    const grid = $('#resGrid'); grid.textContent = '';
    for (const [k, v] of res.stats || []) {
      const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k; dd.textContent = v; d.append(dt, dd); grid.append(d);
    }
    const team = $('#resTeam'); team.textContent = '';
    if ((res.team || []).length > 1) {
      for (const [slot, name, deliv, bonks] of res.team) {
        const s = document.createElement('span'), dot = document.createElement('i'), b = document.createElement('b');
        dot.className = 'dot'; dot.style.background = C[PCOL[slot]] || C.edge;
        b.textContent = name;
        s.append(dot, b, document.createTextNode(` ${deliv} delivered · ${bonks} bonks`));
        team.append(s);
      }
    }
    $('#againBtn').hidden = mode === 'client';
    $('#settingsBtn').hidden = mode === 'client';
    $('#settingsBtn').textContent = mode === 'host' ? 'Back to lobby' : 'Change settings';
    $('#resLeaveBtn').hidden = mode === 'local';
    $('#resNote').hidden = mode !== 'client';
    phase = 'results'; showPhase(); scrollTo(results);
  }

  /* ---------- online: lobby ---------- */
  const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), x => CODE_ABC[x % CODE_ABC.length]).join('');
  const nameIn = $('#nameIn'), codeIn = $('#codeIn');
  try { nameIn.value = localStorage.getItem('gatecrash-name') || ''; } catch (_) {}
  const qs = new URLSearchParams(location.search);
  if (qs.get('room')) codeIn.value = qs.get('room').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
  function myName(slot) {
    const n = cleanName(nameIn.value);
    try { localStorage.setItem('gatecrash-name', n); } catch (_) {}
    return n || 'P' + (slot + 1);
  }
  const rosterOut = () => roster.map(r => ({ s: r.slot, n: r.name }));
  function rosterIn(list) {
    roster = (Array.isArray(list) ? list : []).filter(r => r && typeof r.s === 'number' && r.s >= 0 && r.s < MAXP)
      .map(r => ({ slot: r.s, id: null, name: cleanName(r.n) || 'P' + (r.s + 1) }));
    if (S) S.players.forEach(p => { const r = roster.find(q => q.slot === p.slot); if (r) p.name = r.name; });
  }
  function renderLobby() {
    $('#roomCode').textContent = roomCode;
    const link = location.origin + location.pathname + '?room=' + roomCode + (window.GCNet && GCNet.local ? '&relay=local' : '');
    $('#roomLink').textContent = link;
    const ul = $('#roster'); ul.textContent = '';
    for (let s = 0; s < MAXP; s++) {
      const r = roster.find(q => q.slot === s);
      const li = document.createElement('li'), dot = document.createElement('i'), who = document.createElement('div');
      const nm = document.createElement('span'), sub = document.createElement('span');
      dot.className = 'dot'; who.className = 'who'; nm.className = 'nm'; sub.className = 'sub';
      if (r) {
        dot.style.background = C[PCOL[s]];
        nm.textContent = r.name;
        const tags = [];
        if (s === 0) tags.push('Host');
        if (s === mySlot) tags.push('You');
        if (s !== 0 && mode === 'host' && net && r.id) tags.push(net.link(r.id) === 'direct' ? 'direct link' : 'via relay');
        sub.textContent = tags.join(' · ') || 'Player ' + (s + 1);
      } else { li.className = 'open'; nm.textContent = 'Open slot'; sub.textContent = 'Waiting for a player'; }
      who.append(nm, sub); li.append(dot, who); ul.append(li);
    }
    const isHost = mode === 'host';
    $('#hostOpts').hidden = !isHost;
    $('#lobbyStart').hidden = !isHost;
    $('#lobbyNote').textContent = isHost
      ? `Share the code. Up to 4 players. Connected through ${net ? net.servers() : 'relay'}.`
      : 'Waiting for the host to start the shift.';
  }
  function hostLobbyPing() { if (mode === 'host' && net && phase !== 'play') net.broadcast({ t: 'lobby', ph: phase, r: rosterOut() }); }

  async function hostGame() {
    if (net) return;
    setMsg('Opening a room...');
    $('#hostBtn').disabled = $('#joinBtn').disabled = true;
    roomCode = newCode();
    try {
      net = await GCNet.host(roomCode, { onMsg: hostOnMsg, onLeave: hostOnLeave, onLink: hostOnLink });
    } catch (e) {
      net = null;
      $('#hostBtn').disabled = $('#joinBtn').disabled = false;
      setMsg('Could not reach the game relay servers from this network. A school firewall may be blocking them. Same keyboard play still works.', 'err');
      return;
    }
    $('#hostBtn').disabled = $('#joinBtn').disabled = false;
    setMsg('');
    mode = 'host'; mySlot = 0; links = {}; opts = readHostOpts();
    roster = [{ slot: 0, id: null, name: myName(0) }];
    phase = 'lobby'; showPhase(); renderLobby(); idle(); scrollTo(lobby);
  }
  function hostOnMsg(id, m) {
    if (m.t === 'hello') {
      let r = roster.find(q => q.id === id);
      if (!r) {
        const used = new Set(roster.map(q => q.slot));
        let slot = -1; for (let s = 1; s < MAXP; s++) if (!used.has(s)) { slot = s; break; }
        if (slot < 0) { net.send(id, { t: 'full' }); net.kick(id); return; }
        r = { slot, id, name: cleanName(m.name) || 'P' + (slot + 1) };
        roster.push(r); roster.sort((a, b) => a.slot - b.slot);
        net.accept(id);
        if (phase === 'play' && S && !S.over) {
          const p = mkPlayer(slot, slot, r.name, false, id);
          S.players.push(p); S.players.sort((a, b) => a.slot - b.slot);
          float(W / 2, 60, r.name + ' joined', 'ok');
        }
        renderLobby();
        net.broadcast({ t: 'roster', r: rosterOut() });
      }
      net.send(id, { t: 'welcome', slot: r.slot, code: roomCode, ph: phase, r: rosterOut(), o: { len: opts.len, tables: opts.tables } });
      if (phase === 'play' && S && !S.over) net.send(id, { t: 'start', o: { len: S.len, tables: S.tables }, r: rosterOut(), mid: 1 });
      return;
    }
    if (!S) return;
    const p = S.players.find(q => q.id === id);
    if (m.t === 'in' && p && phase === 'play') {
      p.tx = clamp(num(m.x, p.tx), 0, W); p.ty = clamp(num(m.y, p.ty), 0, H);
      p.fx = clamp(num(m.fx, p.fx), -1, 1); p.fy = clamp(num(m.fy, p.fy), -1, 1); p.moving = !!m.mv;
    } else if (m.t === 'act' && p && playing() && !S.paused) {
      p.x = p.tx = clamp(num(m.x, p.x), 0, W); p.y = p.ty = clamp(num(m.y, p.y), 0, H);
      pushOut(p); p.near = nearest(p); act(p);
    }
  }
  function hostOnLeave(id) {
    const r = roster.find(q => q.id === id); if (!r) return;
    roster = roster.filter(q => q !== r); delete links[r.slot];
    if (S && phase === 'play') {
      const p = S.players.find(q => q.id === id);
      if (p) { S.players = S.players.filter(q => q !== p); if (!S.over) float(W / 2, 60, r.name + ' left', 'muted'); }
    }
    renderLobby();
    if (net) net.broadcast({ t: 'roster', r: rosterOut() });
  }
  function hostOnLink(id) {
    const r = roster.find(q => q.id === id); if (!r || !net) return;
    links[r.slot] = net.link(id); renderLobby();
  }

  async function joinGame() {
    if (net) return;
    const code = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { setMsg('Room codes are 4 letters.', 'err'); codeIn.focus(); return; }
    setMsg('Looking for room ' + code + '...');
    $('#hostBtn').disabled = $('#joinBtn').disabled = true;
    mode = 'client';
    try {
      net = await GCNet.join(code, myName(1), { onMsg: clientOnMsg, onLost: clientOnLost, onLink: () => {} });
      roomCode = code;
      try { history.replaceState(null, '', location.pathname + '?room=' + code + (GCNet.local ? '&relay=local' : '')); } catch (_) {}
    } catch (e) {
      net = null; mode = 'local';
      const why = e && e.message;
      setMsg(why === 'full' ? 'That room already has 4 players.'
        : why === 'nonet' ? 'Could not reach the game relay servers from this network. A school firewall may be blocking them.'
        : `No room found with code ${code}. Check the code on the host's screen and try again.`, 'err');
    }
    $('#hostBtn').disabled = $('#joinBtn').disabled = false;
  }
  function clientOnMsg(m) {
    if (m.t === 'welcome') {
      mySlot = num(m.slot, 1); rosterIn(m.r); setMsg('');
      if (m.o) opts = { players: 0, len: num(m.o.len, 180), tables: !!m.o.tables };
      if (phase === 'setup') { phase = 'lobby'; showPhase(); renderLobby(); idle(); scrollTo(lobby); }
    } else if (m.t === 'roster') { rosterIn(m.r); if (phase === 'lobby') renderLobby(); }
    else if (m.t === 'lobby') {
      rosterIn(m.r);
      if (m.ph === 'lobby' && phase !== 'lobby') { phase = 'lobby'; showPhase(); idle(); }
      if (phase === 'lobby') renderLobby();
    } else if (m.t === 'start') {
      if (m.mid && phase === 'play') return;
      rosterIn(m.r);
      const o = { players: roster.length, len: num(m.o && m.o.len, 180), tables: !!(m.o && m.o.tables) };
      beginPlay(o);
      if (m.mid) toast('You joined mid-shift. Get to work!');
    } else if (m.t === 's') applySnapshot(m);
    else if (m.t === 'end') { if (S && phase === 'play') { showResults(m.res || {}); play(m.res && m.res.win ? 'win' : 'lose'); } }
  }
  function clientOnLost(why) {
    net = null;
    leaveToSetup(why === 'hostgone' ? 'The host closed the room.' : 'Lost the connection to the host.');
  }
  function leaveToSetup(msg) {
    if (net) { try { net.close(); } catch (_) {} net = null; }
    mode = 'local'; mySlot = 0; roster = []; links = {}; roomCode = '';
    if (S) S.over = true;
    clearCards();
    phase = 'setup'; showPhase(); idle();
    setMsg(msg || '', msg ? 'err' : '');
    try { history.replaceState(null, '', location.pathname + (GCNet.local ? '?relay=local' : '')); } catch (_) {}
  }

  /* ---------- buttons ---------- */
  function selectTab(online) {
    $('#tabOnline').setAttribute('aria-selected', online ? 'true' : 'false');
    $('#tabLocal').setAttribute('aria-selected', online ? 'false' : 'true');
    $('#paneOnline').hidden = !online; $('#paneLocal').hidden = online;
  }
  $('#tabOnline').addEventListener('click', () => selectTab(true));
  $('#tabLocal').addEventListener('click', () => selectTab(false));
  $('#startBtn').addEventListener('click', startLocal);
  $('#hostBtn').addEventListener('click', hostGame);
  $('#joinBtn').addEventListener('click', joinGame);
  $('#lobbyStart').addEventListener('click', () => { if (mode === 'host') startHosted(); });
  $('#leaveBtn').addEventListener('click', () => leaveToSetup());
  $('#resLeaveBtn').addEventListener('click', () => leaveToSetup());
  $('#againBtn').addEventListener('click', () => { if (mode === 'host') startHosted(); else startLocal(); });
  $('#settingsBtn').addEventListener('click', () => {
    if (mode === 'host') { phase = 'lobby'; showPhase(); renderLobby(); idle(); hostLobbyPing(); scrollTo(lobby); }
    else { phase = 'setup'; showPhase(); idle(); scrollTo(setup); }
  });
  $('#copyBtn').addEventListener('click', () => {
    const t = $('#roomLink').textContent;
    const ok = () => { $('#copyBtn').textContent = 'Copied'; setTimeout(() => $('#copyBtn').textContent = 'Copy link', 1500); };
    const fallback = () => { const r = document.createRange(); r.selectNodeContents($('#roomLink')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
    try { navigator.clipboard.writeText(t).then(ok, fallback); } catch (_) { fallback(); }
  });
  pauseBtn.addEventListener('click', togglePause);
  $('#resumeBtn').addEventListener('click', togglePause);
  $('#quitBtn').addEventListener('click', () => { if (playing()) end(false, true); });
  const muteBtn = $('#muteBtn');
  muteBtn.addEventListener('click', () => { muted = !muted; muteBtn.textContent = muted ? 'Sound off' : 'Sound on'; if (!muted) initAudio(); });
  window.addEventListener('pagehide', () => { if (net) { try { net.close(); } catch (_) {} } });

  /* ---------- sound ---------- */
  function initAudio() { if (audio) { if (audio.state === 'suspended') audio.resume(); return; } try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audio = null; } }
  const SFX = { grab: [520, .06, 'square'], load: [380, .07, 'square'], ding: [880, .12, 'triangle'], deliver: [1040, .16, 'triangle'], wrong: [170, .22, 'sawtooth'], miss: [130, .3, 'sawtooth'], flip: [300, .18, 'square'], bonk: [210, .1, 'triangle'], jam: [150, .25, 'square'], order: [660, .05, 'sine'], win: [784, .45, 'triangle'], lose: [110, .6, 'sawtooth'], unlock: [700, .22, 'triangle'] };
  function sfx(n, who) {
    if (mode === 'host' && S && n !== 'win' && n !== 'lose') S.ev.push({ k: 'sfx', n, w: who == null ? null : who });
    if (who == null || mode === 'local' || who === mySlot) play(n);
  }
  function play(n) {
    if (muted || !audio) return; const s = SFX[n]; if (!s) return;
    try {
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = s[2]; o.frequency.setValueAtTime(s[0], t);
      if (n === 'deliver' || n === 'win' || n === 'unlock') o.frequency.exponentialRampToValueAtTime(s[0] * 1.5, t + s[1]);
      if (n === 'flip' || n === 'lose' || n === 'miss') o.frequency.exponentialRampToValueAtTime(Math.max(40, s[0] * 0.5), t + s[1]);
      g.gain.setValueAtTime(0.07, t); g.gain.exponentialRampToValueAtTime(0.0001, t + s[1]);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + s[1] + 0.02);
    } catch (_) {}
  }

  /* ---------- boot ---------- */
  function idle() {
    const keepMode = mode;
    mode = 'local'; readLocalOpts(); S = fresh(opts); mode = keepMode;
    S.machines[0].out = { v: 1, gate: 'NOT' };
    S.machines[1].inputs = [{ v: 1, gate: null }];
    S.players[0].hold = { v: 1, gate: null };
    S.players[0].x = 290; S.players[0].y = 300; S.players[0].local = false;
    hud();
  }
  function resize() {
    const r = cv.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    scale = cv.width / W;
  }
  document.querySelectorAll('#paneLocal input').forEach(i => i.addEventListener('change', () => { if (phase === 'setup') idle(); }));
  document.querySelectorAll('#hostOpts input').forEach(i => i.addEventListener('change', () => { if (phase === 'lobby') { opts.len = readHostOpts().len; opts.tables = readHostOpts().tables; hostLobbyPing(); } }));
  buildBg(); idle(); resize(); showPhase();
  if (codeIn.value.length === 4) { selectTab(true); setMsg('Type your name, then press Join.'); }
  if (window.ResizeObserver) new ResizeObserver(resize).observe($('#stage')); else window.addEventListener('resize', resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildBg);

  let last = performance.now(), lobbyT = 0;
  function step(dt) {
    if (phase === 'play' && S && !S.over) {
      if (mode === 'client') clientUpdate(dt);
      else if (!S.paused) update(dt);
      if (mode === 'host' && net) {
        snapTimer -= dt;
        if (snapTimer <= 0 && phase === 'play') { snapTimer = SNAP_DT; if (!S.over) net.broadcast(snapshot()); }
      }
    } else if (S && S.floaters.length) tickFloaters(dt);
    if (mode === 'host' && phase !== 'play') { lobbyT -= dt; if (lobbyT <= 0) { lobbyT = 1; hostLobbyPing(); } }
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); draw(); requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // Keep the host's game running if its tab gets covered by another window (rAF stops when hidden).
  setInterval(() => {
    if (!(document.hidden && mode === 'host' && phase === 'play')) return;
    const now = performance.now(); let dt = Math.min(2, (now - last) / 1000); last = now;
    while (dt > 0) { const d = Math.min(0.05, dt); step(d); dt -= d; }
  }, 100);

  window.__gc = { get S() { return S; }, get phase() { return phase; }, get mode() { return mode; }, get roster() { return roster; }, get net() { return net; }, keys };
})();
