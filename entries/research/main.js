import * as THREE from 'three';
import { Engine } from './engine.js';
import { G } from './glsl.js';
import { makeFoliageAtlas } from './tex-foliage.js';
import { applyLook } from './look.js';
import { FPS, FRAMES, CUES, SHOTS, evalFrame, registerCams } from './shots.js';
import { onTwos, deg } from './util.js';

// URL params:
//   scale=2            internal supersampling (1 for quick previews)
//   frame=N            show this frame on load
//   test=1&cam=x,y,z&at=x,y,z&fov=35&t=30   free camera at film time t
//   k=1&elev=3&az=6    override the light (with test=1)
//   world=0 archer=0 leviathan=0 ships=0 under=0 energy=0 splash=0   skip a department;  flat=1  disable weathering
const P = new URLSearchParams(location.search);
const S = parseFloat(P.get('scale') ?? '2');
const W = 1920, H = 1040;

const canvas = document.getElementById('c');
const engine = new Engine(canvas, W, H, S);
const scene = new THREE.Scene();
const overlay = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 9000);

const atlas = makeFoliageAtlas();
const ctx = { THREE, scene, overlay, engine, camera, atlas, G, CUES, SHOTS, FPS, shadowRoots: [] };
if (P.get('flat') === '1') G.uFlat.value = 1;

// Each department owns the cameras/looks of its shots in src/cams/<dept>.js
for (const c of ['archer', 'monster', 'ships', 'world', 'under']) {
  try { registerCams(await import(`./cams/${c}.js`)); } catch (e) { console.error(`[cams/${c}] failed to load: ${e.stack || e}`); }
}
// Departments load independently: a broken module falls back to a no-op so the
// others can keep rendering. Skip one with e.g. &fx=0 / &leviathan=0.
const NOOP = { update() {} };
async function dept(name, file, fn) {
  if (P.get(name) === '0') return NOOP;
  try {
    const mod = await import(file);
    return (await mod[fn](ctx)) || NOOP;
  } catch (e) {
    console.error(`[${name}] failed to load: ${e.stack || e}`);
    return NOOP;
  }
}
ctx.world = await dept('world', './world.js', 'buildWorld');
ctx.archer = await dept('archer', './archer.js', 'createArcher');
ctx.leviathan = await dept('leviathan', './leviathan.js', 'createLeviathan');
ctx.ships = await dept('ships', './ships.js', 'createShips');
ctx.under = await dept('under', './under.js', 'createUnder');
ctx.energy = await dept('energy', './fx-energy.js', 'createEnergy');
ctx.splash = await dept('splash', './fx-splash.js', 'createSplash');
ctx.tether = await dept('tether', './tether.js', 'createTether');
const ORDER = ['world', 'archer', 'leviathan', 'ships', 'under', 'energy', 'splash', 'tether'];

const num3 = (s) => s.split(',').map(Number);

function stateFor(frame) {
  const st = evalFrame(frame);
  if (P.get('test') === '1') {
    if (P.get('cam')) st.cam = { pos: num3(P.get('cam')), look: num3(P.get('at') ?? '0,1.5,0'), fov: parseFloat(P.get('fov') ?? '35') };
    const L = { ...st.look };
    if (P.get('k')) L.k = parseFloat(P.get('k'));
    if (P.get('elev')) L.sunElev = parseFloat(P.get('elev'));
    if (P.get('az')) L.sunAz = parseFloat(P.get('az'));
    st.look = L;
    if (P.get('fade') === '0') st.fade = 0;
  }
  return st;
}

const _sc = new THREE.Vector3();
function renderState(st) {
  G.uTime.value = st.t;
  G.uDrawTime.value = onTwos(st.t);
  applyLook(ctx, st.look);
  if (st.key) G.uKeyDir.value.set(...st.key).normalize(); else G.uKeyDir.value.copy(G.uSunDir.value);
  engine.mWater.uniforms.uOn.value = st.look.water === false ? 0 : 1;
  const c = st.cam;
  camera.position.set(...c.pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(_sc.set(...c.look));
  if (c.roll) camera.rotateZ(deg(c.roll));
  camera.updateMatrixWorld();
  camera.fov = c.fov;
  camera.near = c.near ?? 0.5;
  camera.far = c.far ?? 9000;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);
  for (const d of ORDER) {
    try { ctx[d].update(st); } catch (e) { console.error(`[${d}] update failed: ${e.stack || e}`); }
  }
  scene.updateMatrixWorld(true);
  overlay.updateMatrixWorld(true);
  engine.render(scene, overlay, camera, {
    shadow: st.shadow && { center: _sc.set(...st.shadow.center).clone(), radius: st.shadow.radius, depth: st.shadow.depth },
    shadowRoots: ctx.shadowRoots.length ? ctx.shadowRoots : undefined,
    frame: st.frame, fade: st.fade, fadeColor: st.fadeColor,
    inkSeed: Math.floor(st.t * 12) % 5, paintRadius: st.look.paintRadius ?? 4, inkWidth: st.look.inkWidth, waterLevel: st.look.waterLevel ?? 0,
  });
  ctx.lastState = st;
}

window.FILM = {
  FPS, FRAMES, CUES, SHOTS, ctx,
  renderFrame(n) { renderState(stateFor(n)); return true; },
  capture(q = 0.93) { return canvas.toDataURL('image/jpeg', q); },
  stateFor,
};
// warm-up: the very first render after load differs slightly (lazy GPU state);
// render once and discard so every captured frame is deterministic
renderState(stateFor(0));
window.FILM_READY = true;

const startFrame = parseInt(P.get('frame') ?? (P.get('t') ? Math.round(parseFloat(P.get('t')) * FPS) : 0), 10);
if (P.get('headless') !== '1') {
  window.FILM.renderFrame(startFrame);
  document.dispatchEvent(new CustomEvent('film-ready', { detail: { frame: startFrame } }));
}
