# LEVIATHAN — production contract

An 83-second, 24 fps, 1920×1040 anime short rendered in the browser with three.js r170 (WebGL2), captured
frame by frame with headless Chrome and encoded with ffmpeg. It is a shot-for-shot retelling of a reference
film (dark, photoreal) in **our style**: the same story, shots, framing, camera moves and timing, but drawn
as bright theatrical anime.

Reference frames lived in `ref/` during production (not included in this repository).
OPEN THE REFERENCE FRAMES OF YOUR SHOTS with the Read tool before you start and match their composition,
subject placement, lens feel and camera move. (extract frames with ffmpeg when you need in-betweens).

The engine and tooling come from our previous film **Sunshower**, one folder up at `../sunken-patrol/`
(read-only for you). Read how it solved things before inventing new ways:
`src/robot.js` (convex-hull armour, superellipsoids, cbox, projected panel decals, IK arms, anchors),
`src/kingfisher3d.js` + `kf3d-*.js` (a rigged 3D creature in cel style), `src/textures.js` (hand lettering, panel
seams, bolts), `src/fx-*.js` (drawn water FX), `src/birds*.js`, `src/world.js`, `src/audio*.js`.

## Art direction (client's words, take them literally)
- **Bright, eye-catching, high-key.** The reference is grey and gloomy; ours is a blazing sunny day: deep-blue sky,
  towering white cumulus with lavender shadow sides, cobalt-to-turquoise sea, white foam, saturated colour. Drama
  comes from scale and contrast, never from murk. Underwater is luminous cyan with god rays, not black.
- **Theatrical cel anime**: crisp cel shading (two hard tones, cool lavender-blue shadows, sharp highlights), confident
  ink lines, gouache painted backgrounds. It must NOT read as CGI, vector art, or Minecraft blocks.
- **Dense detail and real volume.** The client rejected "clean, boxy, Minecraft" looks twice. Silhouettes must be
  sculpted; surfaces carry panel lines, bolts, markings, wear. Never paste flat 2D sprites onto a 3D scene for
  main subjects, never let things float: contact and scale must read.
- **Weight and timing.** Characters animate on twos (`onTwos`), water FX on threes, held poses, snappy accents; huge
  things move slowly with mass. Natural joint motion, no breaking wrists, no sliding.
- The robot and monster must stay **as close as possible to the reference designs** (below).

## Story
A colossal silver archer robot stands on a coastal headland and draws a giant bow. Blue energy charges the arrow. It
fires; the arrow splits the sky and climbs into orbit. Out at sea, a fleet of container ships crosses a colossal
shadow. Four whales rise beside a ship… they are lures inside the mouth of a leviathan, which breaches through the
fleet, sends a giant swell that stands a container ship on end, and vanishes. The arrow turns over high above the
planet, comes back down red-hot, strikes the sea, drives through the leviathan's back in a storm of blue lightning,
punches out through its belly into the rock. A mountain of water rises; the dying leviathan flips over the ships and
falls, and the wall of water takes the fleet.

## Designs
- **Archer** (~110 m tall): sleek silver-steel humanoid, angular overlapping armour plates like a samurai-gundam, round
  smooth helmet with a dark visor slit, dark inner frame, bronze accents at joints, chest with a faceted reactor core
  that glows blue; deep lunge stance. **Bow**: taller than the robot, recurve black-steel limbs with cams and a cable;
  **arrow**: long dark shaft with a barbed multi-blade arrowhead, red-orange inlay lines (see s11, s26, s28).
- **Leviathan** (~900 m): whale-like mass with crocodile-rough dark teal skin, pale ribbed throat grooves, ridged back
  with spines, huge flippers with claws, whale flukes. A mouth like a cavern ringed with teeth; inside it four
  whale-shaped **lures** on long necks (humpback-like, pale bellies, dark spots), s18–s19. In s31–s37 it crawls the
  sea floor with clawed forelimbs.
- **Ships**: 300 m container ships (navy/dark-red hull, stacked multicolour containers, white aft bridge tower, blue
  funnel), plus deck details (railings, cranes, lashing bars).

## Shots
Times are in `src/shots.js` (`SHOTS`), story beats in `CUES`. Owner sets the camera and look (see below). "fx" marks work
the FX department adds in the same shot.

| id | name | time | set | owner | what happens (reference) |
|---|---|---|---|---|---|
| s01 | grip | 0–0.67 | coast | archer | CU of the bow hand gripping the bow, arrow across, robot's head behind, coast far below |
| s02 | limb | 0.67–1.47 | coast | archer | macro of the bow limb and cable block over the blurred shore |
| s03 | archer wide | 1.47–2.6 | coast | archer | wide: lunge on the headland, bow drawn, sea left, surf |
| s04 | draw | 2.6–4.37 | coast | archer | CU of forearm and draw hand on the string, shaft running left |
| s05 | foot | 4.37–5.8 | coast | archer | front foot planted in the surf line, slow push |
| s06 | charge | 5.8–9.17 | coast | archer + fx | CU draw hand; blue energy crawls along the shaft into the chest armour, plates light up |
| s07 | charge wide | 9.17–11.8 | coast | archer + fx | wide: energy runs the arrow, surf blown flat |
| s08 | arrowhead | 11.8–13.03 | coast | archer + fx | low CU: huge crystal-bright arrowhead with lightning, helmet behind |
| s09 | release | 13.03–14.53 | coast | archer + fx | wide: string snaps at CUES.release, recoil, shockwave on the sea |
| s10 | sky splits | 14.53–16.8 | deck | ships + fx | from a ship deck looking up past a container stack: a streak tears the clouds; clouds part into two walls |
| s11 | climb | 16.8–19.9 | sky | world | tracking the arrow through cloud tops up into the stratosphere |
| s12 | orbit | 19.9–21.07 | orbit | world | Earth's limb from space, tiny arrow glint |
| s13 | flash | 21.07–21.57 | orbit | world + fx | blue shock flash along the limb |
| s14 | shadow | 21.57–23.17 | ocean | monster | high aerial: ships' wakes and a colossal dark shadow gliding under the sea |
| s15 | whales | 23.17–26.97 | deck | monster + fx | from the ship rail: four whales rise, breach and dive, tails last |
| s16 | bridge wing | 26.97–28.4 | deck | ships | down from the bridge wing over containers, lashing, spray |
| s17 | below | 28.4–31.1 | under | under | looking up from below: shapes of whales under the churning bright surface |
| s18 | lures | 31.1–33.5 | ocean | monster + fx | four whale heads rising on long necks from a boiling sea |
| s19 | maw | 33.5–35.5 | ocean | monster + fx | a ring of teeth rises around them: the whales are inside a mouth; it closes, looming over camera |
| s20–21 | breach | 35.5–42.37 | ocean | monster + fx | (one continuous camera) fleet in foreground; the leviathan breaches and arcs across the frame, slowly |
| s22 | belly | 42.37–45.1 | bridge | ships + monster | through the bridge windows: its belly and flipper slide past |
| s23 | big wave | 45.1–49.33 | ocean | ships + fx | three ships climb a giant swell, crest curling; one stands on end, containers fall |
| s24 | fog | 49.33–51.3 | ocean | monster + fx | spray fog: the ridged back and flukes sink; a ship's bow in foreground |
| s25 | port | 51.3–52.57 | port | world | stratosphere over a coastal port city, the arrow a dark line diving in |
| s26 | reentry | 52.57–54 | orbit | world + fx | arrow CU with red plasma trails over the planet |
| s27 | canyon | 54–57.73 | under | under | undersea canyon, the leviathan's flank moving past cliffs, slow |
| s28 | plasma | 57.73–59.57 | sky | world + fx | arrow CU through the sky, then top view: a white-hot streak above tiny ships |
| s29 | monster head | 59.57–60.9 | under | under | the head and maw underwater, a whale fleeing past |
| s30 | impact | 60.9–62.9 | ocean | ships + fx | horizon line with ships: a thin streak meets the sea, a white plume swells up |
| s31 | pierce | 62.9–65.23 | under | under + fx | the arrow drives through the back in a blue-white flash, lightning arcs along the body |
| s32 | claws | 65.23–66.83 | under | under + fx | CU clawed forelimb, lightning under it |
| s33 | surface | 66.83–68.17 | under | under | wide up toward the surface and canyon spires, flash far below |
| s34 | mound | 68.17–69.23 | under | under | low: the belly drags over a rock mound |
| s35 | tip out | 69.23–70.2 | under | under + fx | the barbed tip bursts out of the belly and stabs the rock |
| s36 | rock burst | 70.2–72.3 | under | under + fx | the mound shatters, boulders fly |
| s37 | run through | 72.3–74.73 | under | under + fx | the pierced leviathan, the arrow through its tail; silhouette rising against the bright surface |
| s38 | water mountain | 74.73–77 | ocean | monster + fx | a mountain of water swells from a calm sea and collapses |
| s39 | flip | 77–83 | ocean | monster + fx | the leviathan rolls in the air between ships, lightning on it, falls; a wall of water smashes a ship, containers fly |

## Sets and scale (meters; water at y = 0 unless noted)
Only one `set` is on screen at a time: `state.set` ∈ coast, deck, sky, orbit, ocean, bridge, under, port. Every department
must set `visible = false` on its groups when its set is not active, so sets can overlap in space and frames stay fast.
Keep everything within 8000 m of the camera (view depth > 8000 is treated as sky by the engine); cheat distances and use
fog. Per-shot `cam.near` / `cam.far` are available.
- coast: archer stands near the origin on a headland; aims out to sea.
- ocean: fleet near the origin; the leviathan's breach within 1–2 km of camera.
- under: `look.water = false`; the Underwater department draws the sea floor, canyon, backdrop and surface from below.

## Departments and file ownership — edit ONLY your files
Others edit their files at the same time. Never edit, reformat or "fix" a file you don't own; put requests in your report.

| Department | Owns |
|---|---|
| Director (main session) | `src/main.js`, `src/engine.js`, `src/glsl.js`, `src/materials.js`, `src/shots.js`, `src/util.js`, `index.html`, `tools/*` except below |
| World | `src/world.js`, `src/world-*.js`, `src/bgmaterials.js`, `src/passes-env.js`, `src/tex-foliage.js`, `src/look.js`, `src/cams/world.js` |
| Archer | `src/archer.js`, `src/archer-*.js`, `src/arrow.js`, `src/textures.js`, `src/cams/archer.js` |
| Leviathan | `src/leviathan.js`, `src/lev-*.js`, `src/cams/monster.js` |
| Ships | `src/ships.js`, `src/ships-*.js`, `src/cams/ships.js` |
| Underwater | `src/under.js`, `src/under-*.js`, `src/cams/under.js` |
| FX Energy | `src/fx-energy.js`, `src/fx-energy-*.js` |
| FX Water | `src/fx-splash.js`, `src/fx-splash-*.js` |
| Sound | `src/audio*.js`, `audio.html`, `tools/render-audio.mjs` |

## Cameras and looks
Each owner fills `src/cams/<dept>.js`:
`export const CAMS = { s05: (lt, d, t, st) => ({ pos: [x,y,z], look: [x,y,z], fov, roll?, near?, far? }) };`
`export const LOOKS = { s05: (lt, d, t, st) => ({ k, sunElev, sunAz, shafts, water, waterLevel, shadow: {center, radius, depth}, key: [x,y,z], mistMul, fogMul, paintRadius, inkWidth }) };`
`lt` = seconds into the shot, `d` = shot length, `t` = film time. Match the reference camera move. `look.key` is the
character key light (an anime cheat: light characters independently of the sun so they never sink into shade).
`look.shadow` turns on the character shadow map around `center`; add your character roots to `ctx.shadowRoots`.

## Department APIs (what others can rely on)
Factories get `ctx` = `{ THREE, scene, overlay, engine, camera, atlas, G, CUES, SHOTS, FPS, shadowRoots }` and later
`ctx.world / archer / leviathan / ships / under / fx`. Update order each frame: world, archer, leviathan, ships, under, energy, splash.
- `src/arrow.js` (Archer): `export function makeArrow(ctx, opts)` returns an Object3D of the arrow, tip along +Z, length 1
  unit scaled by the caller, so World can fly it in s11/s12/s25/s26/s28 and Underwater/FX can use it in s31–s37.
  `ctx.archer.anchor(name, vec3)`: arrowTip, arrowNock, drawHand, bowHand, chest, head, bowTop, bowBottom.
- `ctx.leviathan`: `root`; `pose(p)` where p = { pos:[x,y,z], yaw, pitch, roll, spine: 0..1 curl, jaw: 0..1, flukes, flippers,
  crawl: 0..1 phase }; `show(bool)`; `anchor(name, vec3)`: head, jaw, back, belly, tail, clawL, clawR, lure0..3. The Leviathan
  department drives its own surface shots; in `under` shots the Underwater department calls `show(true)` and `pose()` from
  its update (it runs after leviathan's). `ctx.leviathan.makeWhale(opts)` gives a single rigged whale for s15, s17, s29, s31.
- `ctx.ships`: `fleet` (array of `{ root, pos, heading }` for the ocean set), `makeShip(opts)`, `makeContainer(i)` (for FX debris).
- `ctx.world`: `sky`; `perch`-free; `terrain` height at coast if the Archer needs foot contact.
- FX Energy: charge glow, lightning, arrow streaks and trails, sky tear, shock flash, re-entry plasma, undersea lightning. FX Water: everything wet: breach sheets, spray, fog, plumes, impact, water mountain, crash wall, thrown containers and boulders. Both read the anchors above and `state`; cel FX ink ids 60–99, no-ink 100+.

## Engine facts
- Pass order: shadow → reflection → main MRT → paint (Kuwahara brush on painted pixels) → ink (cel pixels) → water plane
  → atmosphere → overlay sprites → bloom → grade. See `../sunken-patrol/CONTRACT.md` and `src/engine.js`, `src/glsl.js`.
- Material ids in `writeOut`: 0 painted (brushwork, no ink), 1–99 inked cel, 100+ cel without ink. Parts of one character
  use different ids so ink lines fall at plate boundaries; ids wrap, keep neighbours different.
- `celMaterial` (src/materials.js) options: color, dark, id, weather [grime,chip,rust,algae], gloss, map, emissive, emisMode,
  det [projected decals]. Use `aRest` as in robot.js `bakeRest`, or weather `[0,0,0,0]`.
- Everything must be a pure function of `state.t` / CUES: frames render in random order. Seeded RNG in src/util.js, no Math.random.
- Budget: a typical frame under ~0.4 s at --scale 2.

## Running and checking your work
Stills (use them for every change, open the JPGs with Read and judge critically):
`node tools/snap.mjs --scale 1 --out out/<dept> --sheet name s:foot "s:archer wide" t:12.4 f:300`
Free camera: `node tools/snap.mjs --scale 1 --out out/<dept> "q:test=1&cam=0,60,300&at=0,60,0&fov=35&t=10=name:mytest"`
Skip departments: `&energy=0&splash=0&ships=0&leviathan=0&archer=0&under=0&world=0`. Page load errors: `node tools/check.mjs 40`.
`out/` is a local folder. Save your current best stills to `out/<dept>/latest/` as you go: the client asks to see progress.
node_modules are already wired in tools/env.mjs. ffmpeg is on PATH.
