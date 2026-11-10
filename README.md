# NEON QUEBRADA

**Guerra de território** — a real-time, top-down pixel-art RPG set in a Brazilian cyberpunk city.
Favelas on the hills, neon downtown towers, docks, jungle parks and a Copacabana-style beach boardwalk.
Play **PvE** as one gang taking the city from the Milícia, the NeoBrás corporate security and the Comando Cromo,
or **PvP** where every color is a rival gang.

Runs in the browser. No install, no server: one player hosts and friends join with a 4-letter code.

---

## How to play

### Start a game
1. Open the game page. Make your character (skin, hair, jacket...), type your name and pick your **name color**
   (it is your color on the map, on your name tag and on your waypoint).
2. **NEW GAME** opens the setup screen:
   - **Mode**: *PvE · Campaign* (everyone in one gang) or *PvP · Gang War* (players pick a gang color).
   - **Map**: Coastal, Island, Lakes, River or Archipelago. A **live preview** of the city is shown on the right.
   - **Size**: Small, Medium or Large.
   - **Seed**: press **REROLL** for another city, or paste a seed code (like `CM-1A2B3C`) to replay a map you liked.
   - **Save slot**: up to 5 saved games.
3. Press **ESC → COPY INVITE LINK** (or the **COPY INVITE** button, bottom right) and send it to your friends.
   They can also type the 4-letter room code on the title screen and press **JOIN**.
4. Up to **6 players**. Friends can drop in and out at any time.

The host's browser runs the world, so **the host must keep the tab open**. The game **autosaves every minute**
(and after captures, lost districts and players leaving) in the host's browser — look for *SAVED ✓* at the bottom right.
Next time, the host loads the game from the title screen and friends rejoin as their saved characters.

**Closed the tab by accident?** Just join again with the same name: your level, cash, arms, mods and crew come back.

### Controls
| Key | Action |
| --- | --- |
| **W A S D** / arrows | Move (8 directions) / fly a vehicle |
| **Mouse** | Aim |
| **Left click** | Left-arm weapon |
| **Right click** | Right-arm weapon |
| **Q** / Space / Shift | Dash in the direction you move, diagonals included *(needs Leg Servos)* |
| **E** | Nano-Heal *(needs Nanite Regen)* |
| **R** | Cloak: enemies lose you, next hit does 2× *(needs Optical Camo)* |
| **F** | Kinetic Shield *(needs Kinetic Shield)* |
| **V** | Get in / out of a flying vehicle |
| **G** | Talk to a civilian: recruit them into your crew |
| **B** | Base menu (at your QG — stand at a building's door to open that shop), compound upgrades (near the core of a district you own), or the bar counter / dealer |
| **E** | At a bar door: go inside |
| **1 / 2 / 3** | Use the drink or stim in that belt slot |
| **T** | Dance (passinho, crip walk or rebolado — you can't move or shoot until it ends) |
| **TAB** | Territory map: click to place your waypoint, click a district to see / upgrade it |
| **Enter** | Chat |
| **E** (hold) | Next to a downed gang-mate: revive them |
| **X** | While downed: give up (respawn at the QG) |
| **ESC** | Menu: invite link, volume, graphics quality, blood on/off, save, quit |
| **M** | Music on/off |

### The game loop (PvE)
1. **Leave the QG** and go to a district that **borders your turf** (check the minimap or the TAB map).
2. **Kill the garrison.** Each district has a garrison count (top-right panel). Districts farther from your HQ have
   bigger, nastier enemies. Enemies close to you show up as red dots on the minimap.
3. **Capture the core.** When the garrison hits 0, stand on the glowing antenna in the middle of the compound
   until the ring fills. Several players capture faster. Enemies near the core stop the capture.
4. **The people join you.** A captured compound gets **guards** and pays **income** into the **gang vault**.
   Everyone standing on the core also gets a **crew member**: a follower bot that fights at your side
   (stronger from tougher districts). **If a crew member dies, it is gone for good.**
   You can also recruit **civilians** (see below). Each player can lead up to **4** crew members in total.
5. **Fortify.** Press **B** near the core of a district you own (or click it on the TAB map) to spend the vault on
   **turrets** and **upgrades** for that compound (see below).
6. **Defend.** The factions send **raids** at your border districts. You get a 30-second warning and red arrows
   point to the target. Raids are big and nasty — later ones bring a starred lieutenant. If raiders hold the core
   with no defenders (players, guards or turrets) around, you lose the district.
7. **Take the HQs.** Control half of a faction's districts to unlock its **HQ** (yellow square on the map).
   A boss waits there: **Coronel Caveira** (Milícia), **CEO Androide** (NeoBrás) or **Rei do Baile** (Comando Cromo).
8. **Win** by capturing all three HQs. You can keep playing afterwards, or start a new city.

### Civilians and respect
The streets are full of people going about their lives. Walk up to one and press **G** to talk: if your gang has
enough **respect** in that district, they join your crew with a pistol or a machete and follow you into fights.
- The panel at the top right shows how the **locals** see your gang here: *Friendly*, *Neutral* or *Hostile*.
  Districts your gang controls start friendlier.
- Civilians run from gunfire and explosions. Stray bullets and blasts can hurt them, and **hurting or killing
  civilians makes the locals hate your gang** for a while — they flee and refuse to join. Respect slowly comes back.
- Recruited civilians count toward your crew limit of 4 and are gone for good if they die.

### Weight and impact
Movement has a little momentum, every gun **kicks back** (shotguns, rockets and the rail arm the most; melee
lunges you forward), and **explosions throw** players, bots and civilians around. Red barrels, gas cylinders,
transformers and cars are great for that.

### PvP · Gang War
- When you join, you **pick a gang color**. Same color = same gang. A new color starts a new gang at its own base
  (up to 4 gangs on small maps, 6 on medium and large).
- Rival players, their guards, crews, turrets and vehicles are all enemies. Killing a rival pays a bounty.
- The bot factions still hold the rest of the city and raid every gang (a bit weaker than in PvE).
  Faction bosses guard their HQs from the start; taking an HQ pays the gang a big bonus.
- To capture a rival's district, clear its defenders and hold the core (bases take longer).
- **Lose your main base** and you respawn at your other compounds. **Lose all your turf** and your gang is out —
  you can then **join another gang**.
- **Win** by being the last gang standing, or by holding **60% of the city**.

### Money, levels and death
- **Kills pay cash (R$)** to whoever got the kill. Teammates nearby get a 40% share. Crew kills pay their owner half.
- **XP** levels you up: more max HP and damage. Some weapons need a minimum level.
- **Going down**: at 0 HP you fall and crawl slowly, leaving a blood trail. A gang-mate holds **E** next to you for
  3 seconds to pick you up (30% HP); your crew will also kneel by you and revive you in 10 seconds (they can be shot
  meanwhile). Enemies can finish you: every hit takes time off your **1:30** bleed-out timer. **X** gives up.
- **Dying** sends you back to the QG and costs **25% of your cash** (gone for good) plus **40% of your progress**
  toward the next level (you never drop a level). Revive your friends!
- **Enemies level up after 4 kills** (players, guards, crew, turrets): they grow into the next, bigger tier and get a ★.
- **Police give no XP.** Killing cops while you have 3 or more wanted stars costs you XP.

### The base (QG)
Your QG is an occupied favela block: low brick walls with several alley entrances, a little town of brick houses,
stalls and laundry lines packed around it, and tall brick buildings inside for each shop — **Arsenal, Clínica,
Armário, Cofre** and the **Garagem** (new vehicles roll out of its door into the parking bay, where they recharge and
repair fastest). Your gang hangs out there: dancing at the paredão, sitting at plastic tables, guarding the gates. Walk up to a building's door and press **B** to open that shop, or press **B** anywhere
inside for the full menu. Inside the QG walls you are **safe**: nobody can shoot, enemies and police won't come for you,
and the cops wait outside. (During a raid on the QG the safe zone switches off — defend it!)
- **ARSENAL** buys new **cyber-arms** (weapons) and upgrades them up to Mk5.
- **CLÍNICA** installs **body mods**. They change how your character looks and plays:
  *Subdermal Armor* (HP, less damage), *Leg Servos* (speed, Dash), *Nanite Regen* (regen, Nano-Heal),
  *Optical Camo* (Cloak), *Kinetic Shield* (Shield).
- **ARMÁRIO** (lockers) chooses which weapon goes on each arm.
- **GARAGEM** sells **battery cells** (your money) and **flying vehicles** for the gang (vault money).
- **COFRE** (vault): anyone can **take money out** for themselves (up to 25% of the vault, once a minute — the gang
  sees who took what), and spend the gang vault on upgrades for the whole gang:
  Guard Training, More Recruits, Business Network (income), Bounty Board (+cash per kill),
  Black Market (cheaper shops), Informants (earlier raid warnings), Rescue Squad (faster respawn).
- **DEFESA** puts turrets and upgrades on the base itself.
- **Pay off the police**: if you have wanted stars, the base menu lets you pay R$350 per star to clear them.

### Boca de fumo
Every gang compound has a **boca** (a small building, or a street stall in tiny compounds). Locals walk in from the
street, buy, and the money goes straight to the **gang vault**. Friendly locals come more often. Stand at the boca and
press **B** (or use the compound menu) to upgrade it — up to level 4, with more customers who spend more.

### Crew levels
Your crew (followers) level up with their kills, up to level 5: more health, more damage, faster attacks, and they
look the part (armor, visors, gold stars over their heads). Every kill also heals them 15% and adds +2% max HP for good.
Each level brings a stronger weapon: gunners go pistol → SMG → shotgun → burst rifle → rail beam; fighters go
claws → blade → hammer (ground slam). They can still die for good.

### Blood
Hits spray blood that falls and stains the floor; bodies leave pools; badly hurt characters drip. Drones, mechs and
armored trucks leak oil and sparks instead. Stains fade after about 30 seconds. **ESC → BLOOD: ON/OFF** turns it off.

### Flags and capturing
Every district has a holographic flag floating over its core, waving in the owner's color, with a capture ring around it.
Take a district and the walls and flag repaint themselves in your gang color in a wave from the flag outward.
Smaller districts are **gang outposts**: little favela shacks in the corners, bunting strung across the yard and the flag in the middle.

### Police (wanted stars)
- Crimes that **civilians see** raise your heat: shooting near people, hurting or killing civilians, explosions, hitting cops.
  Every 100 heat is a ★, up to 5.
- Each new star sends the **Polícia Militar 2099** in flying patrol cars. More stars, heavier units: soldiers, shotguns,
  riot squads, police drones and finally the riot mech.
- Three ways out: **beat the response** (kill every cop that came — stars go to zero), **lose them** (stay far from every cop
  until the escape bar fills), or **pay them off** at your QG. Stars also fade slowly when nobody is chasing you.
  Hiding in a bar or at the QG freezes your stars — the cops wait outside.

### Bars, drinks and stims
- Bars are marked by a neon cocktail sign and a lit doorway. Press **E** at the door (or walk into it) to go inside:
  a DJ plays live electronic music, people dance, and the bartender sells drinks at the **counter (B)**.
- Drinks last a few minutes, so you drink and head back out powered up:

| Drink | Effect | Price |
| --- | --- | --- |
| Caipirinha Neon | +20% damage, 3 min | R$260 |
| Guaraná Volt | +25% speed, 3 min | R$220 |
| Açaí Nanotech | heal 40% + regen, 2 min | R$240 |
| Cerveja Cromada | −15% damage taken, 3 min (a bit tipsy) | R$200 |
| Chopp Turbo | +25% fire rate, 2.5 min | R$300 |
| Água de Coco | cures poison and burning, small heal | R$90 |

- Some bars have a **dealer** in the back selling stronger, pricier **cyber stims** — *Pó Rosa, Balão, Pedra Azul, Loló, Bala,
  Doce* — but **20% are a bad batch** that poisons you for 20s (it never takes you below 1 HP).
- Everything goes on your **belt** (3 slots, kept when you die). Use them with **1 2 3**. Different effects stack;
  taking the same one again refreshes it.

### Compound upgrades (every district you own)
| Upgrade | What it does |
| --- | --- |
| **Turret slots** | 2 slots, up to 4 with **Fortify**. Choose per slot: **Machine Gun**, **Rocket Pod**, **Tesla Coil** (chains 3 targets), **Flame Turret**, **Rail Sentry**. Upgrade each to Mk3. Destroyed turrets repair themselves after 60s. |
| **Armored Walls** | Raiders capture slower; guards and turrets there take less damage |
| **Barracks** | More guards in that district |
| **Medic Post** | Heals your players, guards and crew inside the compound |
| **Charge Pad** | Recharges and repairs flying vehicles parked there |
| **Radar Tower** | Hostiles in that district appear on your minimap; earlier raid warning |

Upgrades are lost if the district falls.

### Flying vehicles
Vehicles are parked around the city (they show on the minimap and map). Press **V** next to one.
- **Moto Voadora**: 2 seats — a driver and a gunner behind.
- **Carro Voador**: 4 seats — a driver and 3 gunners.
- They **fly over buildings** and water. The driver can't shoot; gunners use their arms.
- Flying uses **charge**. When it runs out the vehicle can only **crawl on the ground**: drive it back to the QG or a
  compound with a **Charge Pad** to recharge (it takes a moment), or carry a **battery cell** and get in to give it
  +60% charge on the spot.
- Vehicles take damage instead of their riders, and repair while parked at the QG. If one is wrecked,
  everyone falls off **unhurt**, and a new vehicle appears somewhere in the city a few minutes later.

### Weapons (arms)
| Arm | Style |
| --- | --- |
| Cyber Fist | fast melee punches (starter) |
| Pulse Pistol | medium-range shots (starter) |
| Mantis Blade | wide, fast slashes |
| Shotgun Arm | close-range spread |
| Monowire | long razor wire that cuts through a line of enemies |
| Hydraulic Fist | ground slam, area damage and big knockback |
| Flamethrower Arm | short fire cone that sets targets ablaze |
| Smart SMG | self-guiding bullets |
| Rocket Arm | explosive rockets |
| Rail Arm | instant piercing beam |

### The city
- **Explosive props**: red barrels, gas cylinders (*botijões*), transformers and parked cars blow up when shot,
  hurting whoever is close. Lure enemies next to them. They come back after a while.
- Every new game builds a new city. The **music** is Brazilian funk made live in code, chiptune style:
  every district has its own track, and the faction holding it picks the style — *Volt Mix* on your turf,
  dark *bruxaria* in Milícia land, *funk melody* in NeoBrás districts and fast *funk 150* in Comando Cromo turf.
  It gets heavier in fights and raids.
- The city is drawn like the classic top-down GTA games: buildings are real 3D boxes whose walls lean away from the
  center of the screen as you move, with lit windows that switch on and off. If you walk behind a tall building
  your character shows as an outline.
- The city is lit by its own lights: streetlights, neon signs (some flicker or change colors), trash fires,
  windows, gunshots and explosions. Days feel like dusk and nights are very dark. Bases are floodlit.
- On an older laptop, set **ESC → GRAPHICS: LOW** for a faster mode.

### Tips
- Only districts touching your turf can be captured. Expand outward like a stain.
- Put waypoints on the map (**TAB**) to call your friends to a raid. Everyone in your gang sees them, in your color.
- Spend the vault on turrets at your border districts before you spread too thin.
- A gunner in a flying car with a Rail Arm or Rocket Arm is a great raid response team.

---

## Publishing on GitHub Pages
The game is plain static files (no build step), ready for GitHub Pages:

1. Create a GitHub repository and push this folder's contents to it (`index.html` must be at the root).
2. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` and `/ (root)`, then save.
3. After a minute the game is live at `https://<your-user>.github.io/<repo-name>/`. Share that link.
   Invite links (`?room=CODE`) work on that address too.

Everyone should reload the page after you publish an update (hosts and friends must run the same version).

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
- Saves from the first version show up as save slot 1 and keep working.

## Project structure
```
index.html        page shell (loads PeerJS + the game)
style.css         UI styling
js/main.js        app flow, hosting/joining, save slots, game loop, prediction, vehicles, events → effects/sounds
js/game.js        the simulation the host runs: combat, AI, gangs, territory, turrets, vehicles, raids, economy, saving
js/world.js       procedural city generator (5 map types, bridges, props) + collision + pathfinding
js/render.js      canvas renderer: ground chunks, sprites, light map + bloom, 3D buildings pass, effects, waypoints
js/buildings.js   GTA2-style 3D buildings: wall/roof textures, neon signs, lit windows, baking for the light
js/sprites.js     all pixel art, drawn in code (characters, enemies, arms, vehicles, turrets, buildings, signs, props)
js/ui.js          title screen, new-game setup + map preview, HUD, base and compound menus, maps, gang picker
js/music.js       generative Brazilian funk (Web Audio, made entirely with code)
js/audio.js       synthesized sound effects + vehicle engine
js/net.js         PeerJS wrapper (rooms, codes, message chunking)
js/input.js       keyboard + mouse
js/font.js        tiny bitmap font for in-world text
js/data.js        weapons, mods, vehicles, turrets, upgrades, factions, drinks/stims, police, prices — tweak balance here
js/rng.js         seeded random + noise
```

## Credits
- All graphics, sound effects and music are generated in code. No external assets. All brands are made up.
- Fonts: [Silkscreen](https://fonts.google.com/specimen/Silkscreen) and [VT323](https://fonts.google.com/specimen/VT323) (Google Fonts, OFL).
- Networking: [PeerJS](https://peerjs.com/) (MIT).
