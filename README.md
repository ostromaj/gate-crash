# Gate Crash

IB Computer Science (2027) A1.2 review game: binary, hex and logic gates.

Overcooked-style co-op in a logic foundry inside the CPU. Grab bits, run them through NOT / AND / OR machines, deliver the right outputs to the order window, and keep Bitflip the gremlin from flipping your bits and jamming the machines. Missed orders fill the Null King's Null Meter.

Part of the Null King Saga (one co-op game per IB CS topic).

**Play:** https://ostromaj.github.io/gate-crash/

## Playing online (up to 4 computers)

1. One student presses **Host a game** and reads out the 4-letter room code (or shares the link).
2. Everyone else types the code and presses **Join**.
3. The host picks the shift length and presses **Start shift**.

The host's computer runs the game, so the host should keep that tab open and in front.

## How the online part works

There's no game server. Computers find each other through free public MQTT relay servers (EMQX, HiveMQ, Mosquitto), then try a direct WebRTC link. If the network blocks direct links, the game keeps running through the relay (about 3 KB/s per room).

If **Host a game** says it can't reach the relay servers, the school firewall is blocking all three (ports 8084, 8884, 8081). Same-keyboard play still works offline.

Testing tip: add `?relay=local` to the URL to run a room across several tabs on one computer with no internet.

## Files

- `index.html`: page and styles
- `game.js`: the game (host runs the simulation, other players mirror it)
- `net.js`: room codes, relay and direct links (no libraries)
 
 
