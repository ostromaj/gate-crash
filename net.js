/* Gate Crash networking. No libraries, no server of our own.
   - Relay: public MQTT brokers over secure WebSockets carry messages between computers in a room.
   - Direct: once two computers find each other through the relay, they try a WebRTC data channel.
     If that works, game traffic goes direct; if not, it stays on the relay.
   - ?relay=local swaps the brokers for BroadcastChannel, so several tabs on one computer can test a room. */
(function () {
  'use strict';

  const params0 = new URLSearchParams(location.search);
  const BROKERS = params0.get('broker') ? [params0.get('broker')] : [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const BASE = 'gatecrash/v1/';
  const HOST_TIMEOUT = 8000, PEER_TIMEOUT = 8000, JOIN_TIMEOUT = 10000, RTC_TIMEOUT = 15000;
  const params = new URLSearchParams(location.search);
  const LOCAL = params.get('relay') === 'local';
  const NO_RTC = params.get('rtc') === 'off' || typeof RTCPeerConnection === 'undefined';

  const te = new TextEncoder(), td = new TextDecoder();
  const now = () => performance.now();
  function rid(n) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = '';
    const r = crypto.getRandomValues(new Uint8Array(n));
    for (const x of r) s += a[x % a.length];
    return s;
  }

  /* ---------- minimal MQTT 3.1.1 client (QoS 0 only) ---------- */
  function mstr(s) {
    const b = te.encode(s), out = new Uint8Array(b.length + 2);
    out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2);
    return out;
  }
  function cat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const u = new Uint8Array(n); let k = 0;
    for (const p of parts) { u.set(p, k); k += p.length; }
    return u;
  }
  function packet(type, body) {
    const rl = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; rl.push(d); } while (n > 0);
    return cat([new Uint8Array([type, ...rl]), body]);
  }

  class Mqtt {
    constructor(url, will) {
      this.url = url; this.will = will; this.id = 'gc' + rid(14);
      this.onmsg = null; this.onclose = null; this.open = false;
      this.buf = new Uint8Array(0); this.pid = 1; this.ping = null; this.ws = null;
    }
    connect(timeout) {
      return new Promise((res, rej) => {
        let done = false;
        const fin = (ok, why) => { if (done) return; done = true; clearTimeout(tm); ok ? res(this) : rej(new Error(why)); };
        const tm = setTimeout(() => { fin(false, 'timeout'); this._kill(); }, timeout || 7000);
        let ws;
        try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { fin(false, 'blocked'); return; }
        this.ws = ws; ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          let flags = 0x02; // clean session
          const parts = [mstr(this.id)];
          if (this.will) { flags |= 0x04; parts.push(mstr(this.will.topic), mstr(this.will.payload)); }
          const vh = new Uint8Array([0, 4, 77, 81, 84, 84, 4, flags, 0, 30]); // "MQTT", level 4, keepalive 30s
          this._send(packet(0x10, cat([vh, ...parts])));
        };
        ws.onmessage = e => this._feed(new Uint8Array(e.data), fin);
        ws.onerror = () => fin(false, 'error');
        ws.onclose = () => {
          const was = this.open; this.open = false; clearInterval(this.ping);
          fin(false, 'closed');
          if (was && this.onclose) this.onclose();
        };
      });
    }
    _feed(chunk, fin) {
      const b = cat([this.buf, chunk]); let i = 0;
      for (;;) {
        if (b.length - i < 2) break;
        let mult = 1, len = 0, j = i + 1, byte, ok = true;
        do {
          if (j >= b.length) { ok = false; break; }
          byte = b[j++]; len += (byte & 127) * mult; mult *= 128;
        } while (byte & 128);
        if (!ok || j + len > b.length) break;
        this._packet(b[i], b.subarray(j, j + len), fin);
        i = j + len;
      }
      this.buf = b.slice(i);
    }
    _packet(h, body, fin) {
      const type = h >> 4;
      if (type === 2) { // CONNACK
        if (body[1] === 0) {
          this.open = true;
          this.ping = setInterval(() => this._send(new Uint8Array([0xC0, 0])), 20000);
          fin(true);
        } else fin(false, 'refused');
      } else if (type === 3) { // PUBLISH
        const qos = (h >> 1) & 3, tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        const k = 2 + tl + (qos ? 2 : 0);
        if (this.onmsg) this.onmsg(topic, td.decode(body.subarray(k)));
      }
    }
    _send(u) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(u); } catch (_) {} } }
    _kill() { try { this.ws && this.ws.close(); } catch (_) {} }
    subscribe(topic) {
      const id = this.pid++ & 0xffff || 1;
      this._send(packet(0x82, cat([new Uint8Array([id >> 8, id & 255]), mstr(topic), new Uint8Array([0])])));
    }
    publish(topic, s) { this._send(packet(0x30, cat([mstr(topic), te.encode(s)]))); }
    close() {
      this.open = false; clearInterval(this.ping);
      this._send(new Uint8Array([0xE0, 0]));
      setTimeout(() => this._kill(), 50);
    }
  }

  /* ---------- same-computer test relay ---------- */
  class LocalRelay {
    constructor(will) {
      this.will = will; this.subs = new Set(); this.onmsg = null; this.onclose = null; this.open = true;
      this.bc = new BroadcastChannel('gatecrash-local');
      this.bc.onmessage = e => { const d = e.data; if (d && this.subs.has(d.topic) && this.onmsg) this.onmsg(d.topic, d.payload); };
    }
    connect() { return Promise.resolve(this); }
    subscribe(t) { this.subs.add(t); }
    publish(t, p) { try { this.bc.postMessage({ topic: t, payload: p }); } catch (_) {} }
    close() { this.open = false; try { this.bc.close(); } catch (_) {} }
  }

  /* Connect to every relay we can. onRelay fires for each one that opens.
     Resolves true once the first opens, false if none do. */
  function openRelays(will, onRelay) {
    if (LOCAL) { const r = new LocalRelay(will); onRelay(r); return Promise.resolve(true); }
    return new Promise(res => {
      let left = BROKERS.length, any = false;
      BROKERS.forEach(url => {
        const m = new Mqtt(url, will);
        m.connect(7000).then(() => { onRelay(m); if (!any) { any = true; res(true); } })
          .catch(() => {})
          .finally(() => { if (--left === 0 && !any) res(false); });
      });
    });
  }
  const parse = s => { try { const m = JSON.parse(s); return m && typeof m === 'object' ? m : null; } catch (_) { return null; } };
  const sdpOf = d => ({ type: d.type, sdp: d.sdp });

  /* ---------- host ---------- */
  async function host(code, H) {
    const up = BASE + code + '/h', down = BASE + code + '/c';
    const will = { topic: down, payload: JSON.stringify({ t: 'hostgone', f: 'host', n: 1e15 }) };
    const relays = [], peers = new Map();
    let seq = 0, lastOut = 0, closed = false;

    const ok = await openRelays(will, r => {
      relays.push(r);
      r.subscribe(up);
      r.onmsg = (topic, payload) => fromRelay(r, payload);
      r.onclose = () => { const i = relays.indexOf(r); if (i >= 0) relays.splice(i, 1); };
    });
    if (!ok) throw new Error('nonet');

    function fromRelay(r, payload) {
      const m = parse(payload);
      if (!m || typeof m.f !== 'string' || m.f === 'host') return;
      let p = peers.get(m.f);
      if (!p) {
        if (m.t !== 'hello') return;
        p = { id: m.f, relay: r, last: now(), n: typeof m.n === 'number' ? m.n : 0, pc: null, dc: null, ice: [] };
        peers.set(m.f, p);
        H.onMsg(p.id, m);
        return;
      }
      if (m.t === 'sdp' || m.t === 'ice') { p.last = now(); rtc(p, m); return; }
      receive(p, m);
    }
    function receive(p, m) {
      p.last = now();
      if (typeof m.n === 'number') { if (m.n <= p.n && m.t !== 'hello') return; p.n = Math.max(p.n, m.n); }
      if (m.t === 'bye') { drop(p.id, 'left'); return; }
      if (m.t === 'hb') return;
      H.onMsg(p.id, m);
    }
    function stamp(msg, extra) { return JSON.stringify(Object.assign({}, msg, extra, { f: 'host', n: ++seq })); }
    function send(id, msg, relayOnly) {
      const p = peers.get(id); if (!p || closed) return;
      const s = stamp(msg, { to: id });
      if (!relayOnly && p.dc && p.dc.readyState === 'open') { try { p.dc.send(s); return; } catch (_) {} }
      p.relay.publish(down, s);
    }
    function broadcast(msg) {
      if (closed) return;
      lastOut = now();
      const s = stamp(msg), need = new Set();
      for (const p of peers.values()) {
        if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(s); continue; } catch (_) {} }
        need.add(p.relay);
      }
      for (const r of need) r.publish(down, s);
    }
    function startRtc(p) {
      if (NO_RTC || p.pc) return;
      let pc;
      try { pc = new RTCPeerConnection({ iceServers: ICE }); } catch (_) { return; }
      p.pc = pc;
      const dc = pc.createDataChannel('g');
      dc.onopen = () => { if (p.pc === pc) { p.dc = dc; H.onLink && H.onLink(p.id); } };
      dc.onclose = () => { if (p.dc === dc) { p.dc = null; H.onLink && H.onLink(p.id); } };
      dc.onmessage = e => { const m = parse(e.data); if (m && peers.get(p.id) === p) receive(p, m); };
      pc.onicecandidate = e => { if (e.candidate) send(p.id, { t: 'ice', c: e.candidate.toJSON() }, true); };
      pc.createOffer().then(o => pc.setLocalDescription(o))
        .then(() => send(p.id, { t: 'sdp', d: sdpOf(pc.localDescription) }, true))
        .catch(() => {});
      setTimeout(() => { if (p.pc === pc && !p.dc) { try { pc.close(); } catch (_) {} p.pc = null; } }, RTC_TIMEOUT);
    }
    function rtc(p, m) {
      const pc = p.pc; if (!pc) return;
      if (m.t === 'sdp' && m.d && m.d.type === 'answer') {
        pc.setRemoteDescription(m.d).then(() => { p.ice.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {})); }).catch(() => {});
      } else if (m.t === 'ice' && m.c) {
        if (pc.remoteDescription) pc.addIceCandidate(m.c).catch(() => {}); else p.ice.push(m.c);
      }
    }
    function drop(id, why) {
      const p = peers.get(id); if (!p) return;
      peers.delete(id);
      try { p.pc && p.pc.close(); } catch (_) {}
      H.onLeave(id, why);
    }
    const tick = setInterval(() => {
      const t = now();
      for (const p of [...peers.values()]) if (t - p.last > PEER_TIMEOUT) drop(p.id, 'timeout');
      if (t - lastOut > 900) broadcast({ t: 'hb' });
    }, 500);

    return {
      code, send, broadcast,
      accept(id) { const p = peers.get(id); if (p) startRtc(p); },
      kick(id) { peers.delete(id); },
      link(id) { const p = peers.get(id); return p && p.dc && p.dc.readyState === 'open' ? 'direct' : 'relay'; },
      servers() { return LOCAL ? 'this computer' : relays.length + ' relay server' + (relays.length === 1 ? '' : 's'); },
      close() {
        if (closed) return;
        broadcast({ t: 'hostgone' });
        closed = true; clearInterval(tick);
        for (const p of peers.values()) { try { p.pc && p.pc.close(); } catch (_) {} }
        peers.clear();
        setTimeout(() => relays.forEach(r => r.close()), 150);
      }
    };
  }

  /* ---------- client ---------- */
  function join(code, name, H) {
    const id = 'c' + rid(12);
    const up = BASE + code + '/h', down = BASE + code + '/c';
    const will = { topic: up, payload: JSON.stringify({ t: 'bye', f: id, n: 1e15 }) };
    const relays = [];
    let relay = null, seq = 0, hostN = 0, pc = null, dc = null, ice = [], lastHost = 0, lastOut = 0;
    let closed = false, welcomed = false, helloTimer = null, tick = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = why => {
        if (settled) return; settled = true;
        shutdown(true);
        reject(new Error(why));
      };
      const sendRelay = (r, msg) => r.publish(up, JSON.stringify(Object.assign({}, msg, { f: id, n: ++seq })));
      const hello = () => relays.forEach(r => sendRelay(r, { t: 'hello', name }));

      function fromRelay(r, payload) {
        const m = parse(payload);
        if (!m || m.f !== 'host' || closed) return;
        if (m.to && m.to !== id) return;
        if (!relay) {
          if (m.to !== id) return;
          if (m.t === 'full' || m.t === 'started') { fail(m.t); return; }
          if (m.t !== 'welcome') return;
          relay = r;
          relays.filter(x => x !== r).forEach(x => x.close());
        } else if (r !== relay) return;
        if (m.t === 'sdp' || m.t === 'ice') { lastHost = now(); rtc(m); return; }
        deliver(m);
      }
      function deliver(m) {
        lastHost = now();
        if (typeof m.n === 'number') { if (m.n <= hostN) return; hostN = m.n; }
        if (m.t === 'hostgone') { lost('hostgone'); return; }
        if (m.t === 'hb') return;
        if (m.t === 'welcome') {
          if (welcomed) return;
          welcomed = true; clearInterval(helloTimer);
          if (!settled) { settled = true; resolve(api); }
        }
        H.onMsg(m);
      }
      function rtc(m) {
        if (NO_RTC) return;
        if (m.t === 'sdp' && m.d && m.d.type === 'offer') {
          try { pc && pc.close(); } catch (_) {}
          let mine;
          try { mine = pc = new RTCPeerConnection({ iceServers: ICE }); } catch (_) { pc = null; return; }
          mine.ondatachannel = e => {
            const ch = e.channel;
            ch.onopen = () => { if (pc === mine) { dc = ch; H.onLink && H.onLink('direct'); } };
            ch.onclose = () => { if (dc === ch) { dc = null; H.onLink && H.onLink('relay'); } };
            ch.onmessage = ev => { const x = parse(ev.data); if (x && x.f === 'host') deliver(x); };
          };
          mine.onicecandidate = e => { if (e.candidate && relay) sendRelay(relay, { t: 'ice', c: e.candidate.toJSON() }); };
          mine.setRemoteDescription(m.d)
            .then(() => { ice.splice(0).forEach(c => mine.addIceCandidate(c).catch(() => {})); return mine.createAnswer(); })
            .then(a => mine.setLocalDescription(a))
            .then(() => { if (relay) sendRelay(relay, { t: 'sdp', d: sdpOf(mine.localDescription) }); })
            .catch(() => {});
        } else if (m.t === 'ice' && m.c) {
          if (pc && pc.remoteDescription) pc.addIceCandidate(m.c).catch(() => {}); else ice.push(m.c);
        }
      }
      function shutdown(silent) {
        if (closed) return; closed = true;
        clearInterval(helloTimer); clearInterval(tick);
        try { if (!silent && relay) sendRelay(relay, { t: 'bye' }); } catch (_) {}
        try { pc && pc.close(); } catch (_) {}
        setTimeout(() => relays.forEach(r => r.close()), 120);
      }
      function lost(why) {
        if (closed) return;
        shutdown(true);
        if (settled) H.onLost && H.onLost(why); else fail(why);
      }
      const api = {
        id,
        send(msg) {
          if (closed || !relay) return;
          lastOut = now();
          const s = JSON.stringify(Object.assign({}, msg, { f: id, n: ++seq }));
          if (dc && dc.readyState === 'open') { try { dc.send(s); return; } catch (_) {} }
          relay.publish(up, s);
        },
        link() { return dc && dc.readyState === 'open' ? 'direct' : 'relay'; },
        close() { shutdown(false); }
      };

      openRelays(will, r => {
        if (closed || relay) { r.close(); return; }
        relays.push(r);
        r.subscribe(down);
        r.onmsg = (topic, payload) => fromRelay(r, payload);
        r.onclose = () => { if (r === relay) lost('relay'); };
        setTimeout(() => { if (!relay && !closed) sendRelay(r, { t: 'hello', name }); }, 150);
      }).then(ok => {
        if (!ok) { fail('nonet'); return; }
        helloTimer = setInterval(() => { if (!relay) hello(); }, 1000);
        setTimeout(() => { if (!welcomed) fail('nohost'); }, JOIN_TIMEOUT);
        lastHost = now();
        tick = setInterval(() => {
          if (!welcomed) return;
          if (now() - lastHost > HOST_TIMEOUT) lost('timeout');
          else if (now() - lastOut > 900) api.send({ t: 'hb' });
        }, 500);
      });
    });
  }

  window.GCNet = { host, join, local: LOCAL };
})();
