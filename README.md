# NEON QUEBRADA

**Guerra de território** — a real-time, top-down pixel-art RPG set in a Brazilian cyberpunk city.
Favelas on the hills, neon downtown towers, docks, jungle parks and a Copacabana-style beach boardwalk.
You and your friends are one gang. Start at your HQ, carve up the city district by district, and hold it
against the Milícia, the NeoBrás corporate security and the Comando Cromo.

Runs in the browser. No install, no server: one player hosts and friends join with a 4-letter code.

---

## How to play

### Start a game
1. Open the game page. Make your character (skin, hair, jacket...) and type your name.
2. **HOST NEW GAME** creates a brand-new, randomly generated city and opens an online room.
3. Press **ESC → COPY INVITE LINK** (or the **COPY INVITE** button, bottom right) and send it to your friends.
   They can also type the 4-letter room code on the title screen and press **JOIN**.
4. Up to **6 players**. Friends can drop in and out at any time.

The host's browser runs the world, so **the host must keep the tab open**. The campaign autosaves in the
host's browser. Next time, the host clicks **CONTINUE CAMPAIGN** and friends rejoin as their saved characters.

### Controls
| Key | Action |
| --- | --- |
| **W A S D** / arrows | Move (8 directions) |
| **Mouse** | Aim |
| **Left click** | Left-arm weapon |
| **Right click** | Right-arm weapon |
| **Q** (or Space) | Dash *(needs Leg Servos)* |
| **E** | Nano-Heal *(needs Nanite Regen)* |
| **R** | Cloak: enemies lose you, next hit does 2× *(needs Optical Camo)* |
| **F** | Kinetic Shield *(needs Kinetic Shield)* |
| **B** | Base menu (only at your HQ, *QG da Laje*) |
| **TAB** | Territory map |
| **Enter** | Chat |
| **ESC** | Menu: invite link, volume, quit |
| **M** | Music on/off |

### The game loop
1. **Leave the QG** and go to a district that **borders your turf** (check the minimap or the TAB map).
2. **Kill the garrison.** Each district has a garrison count (top-right panel). Enemies come from weak to strong:
   districts farther from your HQ have bigger, nastier enemies.
3. **Capture the core.** When the garrison hits 0, stand on the glowing antenna in the middle of the compound
   until the ring fills. Several players capture faster. Enemies near the core stop the capture.
4. **The people join you.** A captured compound gets **guards** that defend it and pays **income** into the
   **gang vault** every 10 seconds.
5. **Defend.** The factions send **raids** at your border districts. You get a 30-second warning and red arrows
   point to the target. If raiders hold the core with no defenders around, you lose the district.
6. **Take the HQs.** Control half of a faction's districts to unlock its **HQ** (yellow square on the map).
   A boss waits there: **Coronel Caveira** (Milícia), **CEO Androide** (NeoBrás) or **Rei do Baile** (Comando Cromo).
   Beat the boss, capture the HQ, and that faction is finished.
7. **Win** by capturing all three HQs. You can keep playing afterwards, or start a new city.

### Money, levels and death
- **Kills pay cash (R$)** to whoever got the kill. Teammates nearby get a 40% share, so supporting pays too.
- **XP** levels you up: more max HP and damage. Some weapons need a minimum level.
- **Dying** sends you back to the QG after 5 seconds and drops **25% of your cash** where you fell.
  A teammate can pick it up, or you can go back for it.
- **The enemy that kills a player levels up**: it grows into the next, bigger tier and gets a ★.
  Watch out for starred enemies.

### The base (QG da Laje)
Walk into your HQ and press **B**:
- **ARSENAL** buys new **cyber-arms** (weapons) and upgrades them up to Mk5.
- **CLÍNICA** installs **body mods**. They change how your character looks and plays:
  - *Subdermal Armor*: more HP, less damage taken
  - *Leg Servos*: faster, unlocks **Dash**
  - *Nanite Regen*: health regeneration, unlocks **Nano-Heal**
  - *Optical Camo*: unlocks **Cloak**
  - *Kinetic Shield*: unlocks **Shield**
- **ARMÁRIO** (lockers) chooses which weapon goes on each arm. Both arms can carry the same weapon.
- **COFRE** (vault) spends the gang vault on upgrades for everyone: tougher guards, more guards, more income.
  Anyone can donate cash to it.

Standing in the QG also heals you quickly.

### Weapons (arms)
| Arm | Style |
| --- | --- |
| Cyber Fist | fast melee punches (starter) |
| Pulse Pistol | medium-range shots (starter) |
| Mantis Blade | wide, fast slashes |
| Shotgun Arm | close-range spread |
| Monowire | long razor wire that cuts through a line of enemies |
| Hydraulic Fist | ground slam, area damage and big knockback |
| Smart SMG | self-guiding bullets |
| Rocket Arm | explosive rockets |
| Rail Arm | instant piercing beam |

Every player starts equal. Your path depends on which arms and mods you buy: a fast cloaked blade
assassin, a tanky hammer brawler, a rocket and rail sniper...

### Tips
- Only districts touching your turf can be captured. Expand outward like a stain.
- Ranged enemies keep their distance; melee ones rush you. Big ones telegraph slams with a red circle, so dodge out.
- Spend the vault on **More Recruits** and **Guard Training** before you spread too thin. Guards hold the line while you're away.
- Night falls every few minutes. The city looks best then.
- Every new game builds a new city. The music is generated live too (ESC → **NEW MUSIC TRACK** for a different one).

---

## Publishing on GitHub Pages
The game is plain static files (no build step), ready for GitHub Pages:

1. Create a GitHub repository and push this folder's contents to it (`index.html` must be at the root).
2. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` and `/ (root)`, then save.
3. After a minute the game is live at `https://<your-user>.github.io/<repo-name>/`. Share that link.
   Invite links (`?room=CODE`) work on that address too.

To test locally, serve the folder with any static server (opening `index.html` directly from disk won't load
the JavaScript modules), for example:
```
python -m http.server 8000
```
Then open `http://localhost:8000`.

### Online play notes
- Connections are browser-to-browser (WebRTC) via [PeerJS](https://peerjs.com/). PeerJS's free public server only
  introduces players to each other. No game server is needed.
- Some strict networks (corporate, some university Wi-Fi, some mobile hotspots) block direct WebRTC connections.
  If a friend can't connect, try another network.
- If the online room can't be created, the host still plays solo offline.

## Project structure
```
index.html        page shell (loads PeerJS + the game)
style.css         UI styling
js/main.js        app flow, hosting/joining, game loop, prediction, events → effects/sounds
js/game.js        the simulation the host runs: combat, enemy AI, territory, raids, economy, saving
js/world.js       procedural city generator + collision + pathfinding
js/render.js      canvas renderer: tile chunks, sprites, neon lighting, effects
js/sprites.js     all pixel art, drawn in code (characters, enemies, arms, buildings, tiles, props)
js/ui.js          title screen, character creator, HUD, base menu, maps
js/music.js       generative micro house (Web Audio, made entirely with code)
js/audio.js       synthesized sound effects
js/net.js         PeerJS wrapper (rooms, codes, message chunking)
js/input.js       keyboard + mouse
js/font.js        tiny bitmap font for in-world text
js/data.js        weapons, mods, enemies, factions, prices — tweak balance here
js/rng.js         seeded random + noise
```

## Credits
- All graphics, sound effects and music are generated in code. No external assets.
- Fonts: [Silkscreen](https://fonts.google.com/specimen/Silkscreen) and [VT323](https://fonts.google.com/specimen/VT323) (Google Fonts, OFL).
- Networking: [PeerJS](https://peerjs.com/) (MIT).
