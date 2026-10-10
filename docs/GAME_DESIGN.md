# SISYPHUS — Game Design Doc (v0.5)

## Name
Sisyphus — the king condemned to push a boulder up a hill forever, only for it to roll back down. That is this game: climb, get shoved, fall, climb again.

## Pitch
A chaotic anime party race for up to 24 players to the top of one of four maps, played in public prize rounds. Everyone starts at the bottom; the first fighter to grab the flag at the top **and hold it for 3 seconds** wins. On the way up you blast, shove, stab and rocket each other, lay traps, dodge pistons, rockfalls and wrecking balls, and knock rivals off ledges, sending them levels back down.

**The clip moment we design around:** someone is *one second* from winning on the flag platform, gets shoved off, and falls past four floors into a safety net while their friends scream.

## Core loop
1. Spawn at the start line with everyone else, armed with a Blaster. The two lobby racks hold a Rocket or a Railgun: the first ones there get them.
2. Each level: pick a route (two rooms per floor in the buildings, the road or the cliff jumps on Olympus), get through its obstacles, climb to the next.
3. Fight and sabotage: shoot and shove rivals into holes and off edges, drop traps, grab better guns from the racks and supply drops.
4. Reach the top, grab the flag, survive the hold.
5. Round ends → next round (public arenas move on to the next map).

## Match rules
| Rule | Value |
|---|---|
| Players | Up to 24 per round; bots fill public rounds to 12 |
| Round length | 8 min; if time runs out, the highest fighter wins |
| Win | Grab the flag and stay within the zone for `FLAG_HOLD_SECONDS` (3 s). Getting stunned or knocked out of the zone drops it |
| Falling | No deaths — falling is the punishment. Holes drop you a floor; the atrium drops you to the next safety net (floors 3, 6 and 9) or the lobby |
| Flag holder | Takes 65% knockback, 60% stun and half damage, so one shooter can't end a hold alone; a real knockdown (stun of 0.5 s or more) or a knockout still makes them drop it |
| Maps | Olympus → Tower → Construction Site → Haunted Hotel, in turn (public arenas); the host picks in a friends room; you pick in practice |

## The maps
Every map follows the same contract (`src/arena.ts`): 12 levels of 6 m, the flag at (0, 72, 0), 24 spawn points, 48 supply-drop spots (4 per level), 24 weapon-rack spots (2 per level), and a route graph with alternatives that the bots follow. The server's anti-cheat relies on that contract, so a new map only needs its own start area in `server/guard.mjs`.

| Map | What it is |
|---|---|
| **Mount Olympus** | A spiral road around a mountain on an island: three tiers, ramps with jump gaps, rockfalls, bronze axes, lightning gates, shoving statues, wind off the cliffs. The flag sits on a bronze dais inside a ring of columns, guarded by a sweeper and two axes. |
| **The Tower** | The original glass skyscraper (below). |
| **Construction Site** | The same frame with no walls: yellow girders, a dirt yard, gusts of wind that push you toward the edge, and a crane arm sweeping the roof. |
| **Haunted Hotel** | The same frame as a grand hotel at midnight: chandeliers instead of wrecking balls, ghosts drifting through every room and across the roof. |

The three buildings share the tower's layout below; each theme adds its own extras (more pendulums over the stair passages and doorways, landing pushers, sweepers at the bridge ends, boulder lanes on the roof), so no stretch of floor is free to stand on.

## The building (Tower, Construction Site, Haunted Hotel)
64 × 64 m, 12 floors (6 m each) around an 18 m open atrium, plus the roof — big enough that 24 players spread out instead of queueing. Every floor has **two rooms** (north and south, 64 × 23 m each, doors at both ends) with different obstacle courses, so you choose your way up; both lead to an 8 m‑wide switchback staircase at the far wall, where the crowds meet and the brawls happen.

| Floor | North room | South room | Extras |
|---|---|---|---|
| 0 | Lobby lounge (moving walkway) | Lobby lounge | Atrium sprint past the fountain between two giant spinning bars |
| 1 | Office partition slalom (pistons, wrecking balls) | Cubicle aisles (balls, backwards belt) | |
| 2 | Classroom desks (spinning bars, backwards belt) | Treadmills (belts both ways, balls, pistons) | *bridge* |
| 3 | Fan hall (four big fans, wall pistons) | Crumbling bands | *safety net* |
| 4 | Broken floor (island jumps, hard lane of stepping stones) | Boulder run | |
| 5 | Library shelf maze | Laser gates | *bridge* |
| 6 | Cargo lifts (timed jumps) | Turntables with spinning bars | *safety net* |
| 7 | Boulder run | Flip floor (panels drop in waves) | |
| 8 | Laser gates | Fan hall | *bridge* |
| 9 | Turntables | Steel beams over a drop | *safety net* |
| 10 | Steel beams | Cargo lifts | *bridge* |
| 11 | The Gauntlet (balls, fan, pistons, laser, boulder) | Flip floor | |
| Roof | Flag platform over the atrium with a spinning bar, three catwalks, wrecking balls over two of them | | |

New obstacles: **boulders** (Sisyphus' revenge — they roll out of hatches in the wall and across the room), **laser gates** (curtains that blink on and off and bounce you back), **turntables** (spinning floors with a bar on top), **flip floors** (panels open in waves and drop you a floor). Every moving obstacle runs off the shared match clock, so it's in the same place on every screen.

**Safety nets** are trampolines: they catch atrium falls and a jump off one launches you back up to the floor.

## Camera & controls
Third‑person, over the shoulder.

| Input | Action |
|---|---|
| WASD / Shift / Space | Move / sprint / jump |
| Mouse | Look (click-drag if the browser refuses mouse lock) |
| Left click or F | Shoot (hold for the Blaster) |
| Right click or E | Shove / melee weapon |
| 1 2 3 4 | Grease / Spring / Trapdoor / Bear trap |
| Scroll | Camera zoom |
| M / R / Esc | Music / restart / pause |

**Controller** (any standard gamepad: Xbox, PlayStation, Switch Pro, Steam Deck): left stick move (analog: tilt a little to walk), right stick look, A jump, RT shoot (hold for the Blaster), RB or X melee, LB or click the left stick to sprint, d-pad traps (↑ grease, → spring, ↓ trapdoor, ← bear trap), Y camera distance, Start pause. Menus work with the d-pad or stick, A to select, B to go back, left/right on sliders. With a controller, shots that would just miss bend onto the target (a few degrees of aim assist), and it rumbles when you're hit, knocked out, land hard or fire a big gun.

## Combat: a shooter where nobody dies
Every hit pushes. HP exists, but 0 HP is a **KO** (long knockdown, you go back to the Blaster and fists), not death. Everyone has a gun from the start, so open floors aren't safe; melee is on its own button.

| Weapon | Source | Feel |
|---|---|---|
| Blaster | Everyone, unlimited | Automatic, light push; 6 hits knock someone out |
| Shotgun | Racks, drops | 6 pellets, big push; 2 shots up close (damage counts every pellet that lands) |
| Rocket | Lobby racks, racks, drops | Splash knockback, 2 direct hits; rocket-jump yourself (no self damage) |
| Railgun | Lobby racks, racks, drops | Instant beam, huge push; 2 hits |
| Freeze ray | Racks, drops | Freezes the target in place for 2.2 s |
| Shove | Default melee | Two-handed lunge, medium push; 8 hits |
| Combat Knife | Racks, drops | Very fast stab, small push; 3 stabs |
| Sledgehammer | Racks, drops | Slow overhead strike, **huge launch**; 3 hits |

**Weapon racks** (orange) stand on every level and refill 25 s after someone empties one. **Supply drops** parachute in every 30 s (a weapon plus a trap).

## Traps
| Trap | Effect |
|---|---|
| Grease | You can't stop; knockback ×1.4 |
| Spring pad | Launches anyone up and the way it faces |
| Trapdoor | Drops the victim through the floor to the level below |
| Bear trap | Roots for 2 s (you can still swing) |

## Fighters & the Locker
Anime fighters (7 VRoid CC0 models, 5 girls + 2 boys) with spring-physics hair and expressive faces (scream while falling, wince when knocked down, smile holding the flag). The **Locker** (modelled on the INKWAVE locker, MIT) lets you pick a fighter, hair colour, outfit colourway, eye colour, headgear (snapback, beanie, cat ears, headphones, bucket hat), one-click preset looks, and a name. Choices save locally. Bots roll random looks.

Animation = retargeted Mixamo Idle/Walk/Run + authored pose layers (jump, fall, knockdown, landing, bear trap, cheer, shotgun aim) and one-shot actions (shove lunge, stab, hammer strike, recoil).

## Built for virality (roadmap)
- **Proximity voice chat** — the #1 driver of funny moments in friend games.
- **Fall replay / kill-cam** and "biggest fall of the round" stats (stats are in).
- **Shareable lobby links** — done: `?room=CODE` drops a friend straight into your room.
- Spectator / streamer mode, custom lobbies, cosmetic unlocks (cosmetics only).

## Phase roadmap
1. **P1 – Prototype:** single-player vs bots in the browser. ✅
2. **P2 – Online multiplayer:** friends rooms with invite links ✅, public 24‑player prize rounds ✅. Next: server-side physics (see Anti-cheat), reconnects, regions.
3. **P3 – Juice & identity:** proximity voice, original character art, more rooms, emotes, replays.
4. **P4 – Publish:** itch.io / CrazyGames / Poki, then Steam via a desktop wrapper.

## Home page
The loading screen is just the logo and a progress bar. Behind the menu runs a live match of bots, filmed by an auto-director, moving to the next map after each round. While you wait for an online round, the background switches to that round's map (which also builds it ahead of time). The director follows the leader, cuts to whoever just got shoved or is about to fall, and replays the round when someone takes the flag (sound muted). On top: the SISYPHUS logo and tagline ("Whoever holds the flag takes the prize"), and a play card like Regicide's: playing-as name, **$25 PRIZE POOL**, **PLAY ONLINE**, players online and the round clock (live from the server), How to Play / Leaderboard / My Wins / Locker / Records / Settings, and links to *Play with friends* and *Practice offline*.

## Online play
- **Public rounds (PLAY ONLINE):** you join the busiest public arena with room (up to 24 players; a new arena opens when they're full). Rounds start on their own — 30 s after someone's waiting, 8 s when 12+ are — and bots fill the field to 12. Arrive mid-round and you drop straight in at the start line (a bot makes room if it's full).
- **Prize rounds:** a public round with at least `MIN_PRIZE_PLAYERS` real players (default 4) when it starts is a prize round — the HUD and the arena screen say so; otherwise it's a warm-up. Whoever holds the flag 3 s (or is highest at the bell) wins the round; bots can't win the prize. The server records every public round's winner (`DATA_DIR/stats.json`) and the leaderboard of wins. **Paying out is manual** — whoever runs the server checks the results and pays winners outside the game.
- **Maps:** each arena rotates Olympus → Tower → Construction → Hotel, one map per round (new arenas start at different points in the rotation). The arena screen shows the next map; the round opens with its name on screen.
- **Friends rooms:** pick a name, CREATE ROOM, share the 5-letter code or the invite link. Up to 24 players; the host picks the map, can fill empty slots with bots (8 fighters), and presses START. No prize.
- **Who simulates what:** each player runs their own fighter (instant controls) and sends its state 20×/s; everyone else is drawn 110 ms in the past and interpolated. Bots run on one player's machine — the server hands them to someone whose tab is in front, so alt-tabbing never freezes them. If the host leaves, the next player becomes host and takes the bots.
- **Hits** are sent to whoever owns the target, so a shove always lands on the victim's own simulation.
- **The server decides** what must be fair: the map, the shared match clock (all hazards are time-based, so pistons and sweepers line up on every screen), the flag holder and the 3-second hold, weapon racks, supply drops and their loot, and the time-up winner.
- State is batched: the server sends one packet per room 20×/s with everyone's latest position, instead of every client relaying to every other.

### Anti-cheat (what the server checks)
Movement is simulated on the players' machines, so a modified client could teleport or fly. The server (`server/guard.mjs`):
- refuses to relay impossible movement (faster than 34 m/s sideways — a railgun knockout is about 26 — or climbing faster than springs/nets allow), so everyone else keeps seeing your last believable position;
- tracks the floor it has *watched* you climb to, one floor at a time — reappearing higher after going quiet doesn't count — and only lets you grab the flag if it saw you reach the roof;
- checks hits come from your own fighter within weapon reach and clamps their strength; only accepts flag/crate/trap messages for fighters you control;
- flags a player who keeps tripping the checks: a flagged winner gets no prize.
Honest limit: a careful cheat that "flies" within the speed limits can still get through. The real fix is running the physics on the server (Rapier runs in Node) — the next big step before large prizes.

### Running it
- Dev: `npm run server` (game server on :8787) and `npm run dev` (Vite on :5173, proxies `/ws` and `/api`). Open two tabs to play yourself.
- Production: `npm start` builds and serves the game, the socket and `/api/stats` + `/api/leaderboard` from one Node process. Any Node host with WebSocket support works (Railway, Render, Fly.io, a VPS); give it a persistent disk for `DATA_DIR`.
- Settings (environment): `PORT` (8787), `DATA_DIR` (./data), `PRIZE_PER_ROUND` (25), `PRIZE_CURRENCY` ($), `MIN_PRIZE_PLAYERS` (4), `ARENA_FILL` (12), `INTERMISSION_SECONDS` (30), `MATCH_SECONDS` (480). `server/test.env` has quick-test values (`node --env-file=server/test.env server/index.mjs`).

## Tech notes
- Vite + TypeScript, three.js (cel shading, merged static geometry), Rapier physics (kinematic character controller), three-vrm.
- Multiplayer: `server/index.mjs` (Node + ws, rooms/clock/flag/crates), `src/net.ts` (socket + clock sync), `src/lobby.ts` (room UI), roster/online logic in `src/game.ts`. Home backdrop camera: `src/director.ts`.
- Maps: `src/arena.ts` (shared base: hazards, route, the contract above, clean-up on a map change), `src/building.ts` (the tower and its themes: `TOWER`, `CONSTRUCTION`, `HOTEL`; rooms are built in u/v room coordinates), `src/maps/olympus.ts`, and the list in `src/maps/index.ts`. A map's routes are checked when it's built in dev (the console warns if a waypoint is in a wall or over a hole).
- Tunables: `src/config.ts`. Weapons: `WEAPONS` in `src/combat.ts`. Looks: `src/style.ts` (append-only tables).
- Surfaces: `toon(color, { pattern })` in `src/toon.ts` draws tiles, planks, carpet, stonework, cliff rock, cobbles, concrete, grass, sand, marble, wallpaper and wainscot in the shader from world position, so merged scenery gets texture-like detail with nothing to download. Each building theme picks its surfaces in `looks` and per floor in `plan[k].look`. Book spines are one small canvas texture. Shaders are compiled behind the loading screen and right after a map change.
- Shadows only come from the level you're on (the light sits just under the next floor up), so the desks and stairs of the floors above don't blotch your floor.
- Controller: `src/gamepad.ts` (`Pad` polling, `PadNav` for menus); in-game mapping in `src/player.ts`, right-stick look in `src/camera.ts`.
- Rapier 0.21 quirk: a capsule standing still *exactly* on a box's diagonal sinks through it, so `Character.teleport` offsets every placement by about a centimetre.
- 24 fighters on a laptop GPU: each VRM is parsed once per base and copied (`src/vrmclone.ts`, ~30 ms instead of ~800 ms); its hair strands are merged into a few meshes and copies share one skeleton; fighters get a level of detail each frame (nearest 4 full, next 4 without hair physics/face/outlines/shadows, the rest a two-mesh stand-in, off-screen ones skipped); moving obstacles more than a floor from the camera aren't drawn.
- Character files are optimised for the web with `npm run optimize:vrm` (textures → 1024 px WebP; originals in `assets-src/anime`). Full download ≈ 36 MB.
