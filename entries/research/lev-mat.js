import * as THREE from 'three';
import { G, COMMON, MRT_OUT } from './glsl.js';
import { spineGLSL } from './lev-spine.js';

// The creature's material: spine-skinned vertex stage + a cel-shaded hide painted entirely in
// the fragment stage. Hard two-tone shading is lit through a bumped normal so the terminator
// breaks along the scutes; each scute gets its own material id, so the ink pass draws a real
// line around it. aInfo = (jaw weight, part, around-the-body metres, belly 0 back..1 belly).
// part: 0 hide, 1 tooth, 2 mouth lining, 3 bony spine, 4 claw, 5 eye, 6 web, 7 stalk, 8 whale, 9 tongue, 10 gum

const VS = (n) => /* glsl */ `
attribute vec4 aInfo;
varying vec3 vWorld, vNormalW, vNormalV, vRest;
varying vec4 vInfo;
varying float vDepth;
varying vec2 vUv;
uniform vec2 uJaw, uHinge;
uniform float uWide, uFat;
${spineGLSL(n)}
void main(){
  vec3 p = position, nr = normal;
  float jw = aInfo.x;
  if(abs(jw) > 1e-4){
    float ang = jw > 0.0 ? uJaw.x * jw : uJaw.y * jw;
    float c = cos(ang), s = sin(ang);
    vec2 r = p.yz - uHinge;
    p.yz = uHinge + vec2(c * r.x - s * r.y, s * r.x + c * r.y);
    nr.yz = vec2(c * nr.y - s * nr.z, s * nr.y + c * nr.z);
  }
  p.x *= 1.0 + uWide * smoothstep(0.66, 0.84, p.z / uLen);     // a broader skull for the head-on shots
  if(uFat > 0.0){ float fk = uFat * smoothstep(0.6, 0.0, p.z / uLen); p.x *= 1.0 + fk; p.y *= 1.0 + 0.6 * fk; }   // a mound of back under the flukes
  float zc = clamp(p.z, 0.0, uLen);
  vec3 b; vec4 q; float sc;
  spineAt(zc / uLen, b, q, sc);
  vec3 wp = b + qrot(q, vec3(p.xy * sc, p.z - zc));
  vWorld = wp;
  vNormalW = qrot(q, nr);
  vNormalV = mat3(viewMatrix) * vNormalW;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vDepth = -mv.z;
  vUv = uv; vRest = position; vInfo = aInfo;
  gl_Position = projectionMatrix * mv;
  if(uFat > 0.0 && aInfo.y > 2.5 && aInfo.y < 3.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}
`;

const FS = /* glsl */ `
${COMMON}
${MRT_OUT}
uniform vec3 uBack, uFlank, uBelly, uBone;
uniform float uIdBase, uRun, uFoamLine, uScale, uInner, uTint, uPleat;
uniform vec3 uTintCol;
varying vec3 vWorld, vNormalW, vNormalV, vRest;
varying vec4 vInfo;
varying float vDepth;
varying vec2 vUv;

vec3 voro(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for(int y = -1; y <= 1; y++) for(int x = -1; x <= 1; x++){
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(i + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if(d < d1){ d2 = d1; d1 = d; id = hash12(i + g + 3.7); } else if(d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
// bump a normal by a screen-space height
vec3 bump(vec3 N, float h, float k){
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  float hx = dFdx(h) * k, hy = dFdy(h) * k;
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * N - g);
}

void main(){
  if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
  if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1.0); oData = vec4(0.0); return; }
  vec3 N = normalize(vNormalW), NV = normalize(vNormalV);
  if(!gl_FrontFacing){ N = -N; NV = -NV; }
  float part = floor(vInfo.y + 0.5);
  vec2 uvm = vec2(vRest.z, vInfo.z) * uScale;       // metres along, metres around (hero scale)
  float mpp = max(length(dFdx(uvm)), length(dFdy(uvm)));   // metres per pixel
  float lod1 = smoothstep(2.2, 0.7, mpp);          // scutes readable
  float lod2 = smoothstep(0.7, 0.18, mpp);         // fine skin readable
  float id = uIdBase, h = 0.0, gloss = 0.5, shadeMix = 0.0, occ = 1.0;
  vec3 col = vec3(1.0), shade = vec3(-1.0);

  if(part < 0.5){
    // ---------------------------------------------------- hide: wet, lumpy whale skin
    float wob = fbm2(uvm * 0.016 + 3.1) - 0.5;
    float belly = vInfo.w + wob * 0.16;
    float bl = smoothstep(0.615, 0.655, belly);
    // broad painted patches, darker over the spine, sea-washed along the flank
    float blot = step(0.52, fbm2(uvm * 0.021 + 11.0));
    float blot2 = step(0.57, fbm2(uvm * 0.066 + 21.0));
    vec3 backC = mix(uBack, uBack * vec3(0.70, 0.74, 0.88), blot * 0.85);
    backC = mix(backC, uBack * vec3(1.26, 1.22, 1.3), blot2 * 0.5);
    float flankK = smoothstep(0.26, 0.5, belly + 0.3 * (blot - 0.5));
    col = mix(backC, mix(uFlank, uFlank * vec3(0.8, 0.82, 0.96), blot2), flankK);
    gloss = 0.95;
    if(bl < 0.5){
      // lumps and folds instead of plates; the cel terminator breaks along them
      float lump = fbm2(uvm * 0.05 + 2.0);
      float lump2 = fbm2(uvm * vec2(0.15, 0.21) + 7.0);
      h = lump * 11.0 + lump2 * 2.4 * lod1;
      // long wrinkles
      float rid = 1.0 - abs(2.0 * fbm2(uvm * vec2(0.021, 0.055) + 50.0) - 1.0);
      float fold = step(0.945, rid);
      col = mix(col, col * vec3(0.56, 0.6, 0.76), fold * lod1);
      h -= fold * 1.6 * lod1;
      col *= 0.92 + 0.2 * step(0.5, lump2) * lod1;
      col = mix(col, col * vec3(1.3, 1.34, 1.36), step(0.55, lump));
      // barnacle crusts: pale rings in clumps
      float patchB = smoothstep(0.6, 0.65, fbm2(uvm * 0.024 + 40.0));
      if(patchB > 0.01){
        vec3 b = voro(uvm / 3.4 + 9.0);
        float rr = b.x * (1.0 + 0.7 * b.z);
        float ring = step(rr, 0.44) * patchB * step(0.24, b.z);
        float hole = step(rr, 0.15);
        col = mix(col, mix(vec3(0.8, 0.8, 0.74), vec3(0.14, 0.18, 0.27), hole), ring);
        h += ring * (1.0 - hole) * 1.6;
        if(ring > 0.5 && lod1 > 0.5) id = uIdBase + 3.0 + floor(b.z * 7.0);
      }
      // scars: long pale slashes with a darkened edge
      float sc1 = abs(fract((uvm.x * 0.62 + uvm.y * 0.8) / 150.0 + 0.5 * wob) - 0.5);
      float scm = step(0.56, fbm2(uvm * 0.012 + 80.0));
      float sw = 0.008 + 0.006 * sin(uvm.x * 0.09);
      float scar = step(sc1, sw) * scm;
      col = mix(col, vec3(0.7, 0.56, 0.6), scar);
      float scarE = step(sc1, sw + 0.008) * (1.0 - scar) * scm;
      col = mix(col, col * 0.55, scarE);
      if(scar > 0.5) id = uIdBase + 11.0;
    } else {
      // ---------------------------------------------- pale throat grooves
      float gp = (vUv.y - 4.712) * 21.0 + 0.5 * sin(uvm.x * 0.008);
      float gi = floor(gp);
      float gf = abs(fract(gp) - 0.5) * 2.0;
      float gz = smoothstep(0.40 * 900.0, 0.58 * 900.0, uvm.x + 70.0 * hash12(vec2(gi, 7.0)));
      gf *= mix(0.0, 1.0, gz);
      h = (1.0 - gf * gf) * 0.34 * gz;
      col = mix(uBelly, uBelly * vec3(0.9, 0.9, 0.93), step(0.5, hash12(vec2(gi, 2.0))) * 0.6);
      col = mix(col, col * vec3(0.74, 0.76, 0.88), smoothstep(0.86, 0.97, gf));
      // pink flush and old scrapes
      col = mix(col, col * vec3(1.0, 0.9, 0.9), step(0.62, fbm2(uvm * vec2(0.012, 0.05) + 5.0)) * 0.5);
      // old scars and pale mottling keep the long belly from going blank
      col = mix(col, col * vec3(0.8, 0.88, 0.96), step(0.6, fbm2(uvm * vec2(0.02, 0.03) + 31.0)) * 0.7);
      id = uIdBase + 1.0 + mod(floor(gi / 7.0), 2.0) * 2.0 * gz;
      gloss = 0.7;
      // waterline between pale and teal: broken edge
      float edgeB = 1.0 - smoothstep(0.615, 0.70, belly);
      col = mix(col, flankKmix(col), 0.0 * edgeB);
    }
  } else if(part < 1.5){
    // ---------------------------------------------------- tooth
    float k = clamp(vUv.x, 0.0, 1.0);
    float tage = hash12(vec2(floor(vInfo.w), 4.0));
    col = mix(vec3(1.0, 0.99, 0.95), vec3(0.72, 0.62, 0.5), smoothstep(0.16 + 0.2 * tage, 0.0, k));
    col = mix(col, col * vec3(0.9, 0.84, 0.72), step(0.7, tage) * 0.8);
    col = mix(col, vec3(1.0), smoothstep(0.8, 0.96, k));
    id = uIdBase + 45.0 + mod(floor(vInfo.w), 6.0);
    gloss = 1.0;
    shade = col * vec3(0.5, 0.47, 0.7);
  } else if(part < 2.5){
    // ---------------------------------------------------- mouth lining (vUv.x: 0 back..1 lip, vUv.y across)
    float k = vUv.x;
    float acr = vUv.y * 2.0 - 1.0;
    float ch = vRest.z * uScale / 19.0 + 3.2 * acr * acr + 0.25 * sin(vRest.x * 0.07) + 0.4 * fbm2(vRest.xz * 0.02);
    float rug = abs(fract(ch) - 0.5) * 2.0;
    h = (1.0 - rug) * 1.4;
    vec3 flesh = mix(vec3(0.17, 0.03, 0.11), vec3(0.50, 0.17, 0.22), smoothstep(0.55, 1.0, k));
    col = mix(flesh * vec3(0.8, 0.74, 0.84), flesh, step(0.34, rug));
    col = mix(col, flesh * 1.3, step(0.86, rug) * smoothstep(0.7, 0.95, k));
    col = mix(col, col * vec3(0.72, 0.58, 0.7), step(abs(acr), 0.03));
    // the deep throat falls away to dark wine, never black
    col = mix(vec3(0.015, 0.008, 0.035), col, smoothstep(0.36, 0.8, k));
    gloss = 0.6;
    id = uIdBase + 55.0;
    shade = col * vec3(0.46, 0.34, 0.66);
    // the lip throws a hard shadow into the mouth
    occ = step(0.72 + 0.03 * sin(acr * 7.0 + vRest.z * 0.03), k);
  } else if(part < 3.5){
    // ---------------------------------------------------- bony spines and plates
    float k = clamp(vUv.x, 0.0, 1.0);
    col = mix(uBack * 0.8, uBone, smoothstep(0.3, 0.85, k));
    col = mix(col, vec3(0.92, 0.9, 0.82), smoothstep(0.86, 0.98, k));
    float ridge = fbm2(vRest.zy * 0.12);
    col *= 0.86 + 0.28 * step(0.5, ridge);
    id = uIdBase + 50.0 + mod(floor(vInfo.w), 4.0);
    gloss = 0.8;
  } else if(part < 4.5){
    float k = clamp(vUv.x, 0.0, 1.0);
    col = mix(vec3(0.33, 0.25, 0.3), vec3(0.98, 0.93, 0.8), smoothstep(0.1, 0.7, k));
    id = uIdBase + 54.0;
    gloss = 1.0;
  } else if(part < 5.5){
    // ---------------------------------------------------- eye: uv across the eyeball
    float r = length(vUv - 0.5) * 2.0;
    col = mix(vec3(0.92, 0.66, 0.2), vec3(0.5, 0.16, 0.08), smoothstep(0.1, 0.5, r));
    float pup = step(abs(vUv.x - 0.5) * 2.4 + abs(vUv.y - 0.5) * 0.9, 0.34);
    col = mix(col, vec3(0.05, 0.03, 0.08), pup);
    col = mix(col, vec3(0.06, 0.05, 0.1), step(0.66, r));
    gloss = 2.0;
    id = uIdBase + 60.0;
    shade = col * 0.82;
  } else if(part < 6.5){
    // ---------------------------------------------------- flipper web: coral underside, veined
    float belly = vInfo.w;
    float vein = abs(fract(vUv.y * 11.0 + 0.5 * fbm2(uvm * 0.03)) - 0.5);
    vec3 pale = mix(vec3(0.96, 0.68, 0.5), vec3(0.98, 0.86, 0.72), step(0.5, fbm2(uvm * 0.04 + 7.0)));
    col = mix(uBack, pale, smoothstep(0.42, 0.58, belly));
    col = mix(col, col * vec3(0.7, 0.62, 0.72), step(vein, 0.05));
    float torn = fbm2(uvm * 0.05);
    col = mix(col, col * 0.86, step(0.55, torn));
    h = 0.5 * step(vein, 0.06);
    id = uIdBase + 58.0;
  } else if(part < 7.5){
    // ---------------------------------------------------- lure stalk: wet pink flesh, ringed
    float rg = abs(fract(vRest.z * uScale / 11.0) - 0.5) * 2.0;
    col = mix(vec3(0.15, 0.05, 0.1), vec3(0.22, 0.08, 0.13), step(0.5, rg));
    col = mix(col, vec3(0.62, 0.2, 0.34), smoothstep(-0.2, -0.75, N.y) * 0.0);
    h = rg;
    gloss = 1.0;
    id = uIdBase + 5.0 + mod(floor(vRest.z * uScale / 11.0), 2.0);
    shade = col * vec3(0.62, 0.52, 0.78);
  } else if(part < 8.5){
    // ---------------------------------------------------- whale (humpback): dark back, pale belly, spots, pleats
    float wob = fbm2(uvm * 0.05 + 3.0) - 0.5;
    float belly = vInfo.w + wob * 0.26;
    vec3 back = uBack;
    float pale = step(0.585, belly);
    col = mix(back, uBelly, pale);
    // dark spots across the pale belly, like the reference's lures
    vec3 s = voro(uvm / 17.0 + 3.0);
    float spot = step(s.x * (1.0 + s.z), 0.40) * step(0.44, s.z);
    col = mix(col, back * 1.05, spot * pale);
    // pale flecks on the back
    vec3 s2 = voro(uvm / 9.0 + 13.0);
    col = mix(col, mix(back, uBelly, 0.45), step(s2.x, 0.2) * step(0.68, s2.z) * (1.0 - pale));
    if(belly > 0.6 && vInfo.x > -0.5){
      float gp = (vUv.y - 4.712) * 22.0;
      float gf = abs(fract(gp) - 0.5) * 2.0;
      float front = vRest.z * uScale;
      float pm = smoothstep(uPleat, uPleat + 8.0, front);
      h = (1.0 - gf * gf) * pm * 0.6;
      col = mix(col, col * vec3(0.72, 0.76, 0.9), smoothstep(0.84, 0.97, gf) * pm);
      id = uIdBase + 1.0 + mod(floor(gp / 4.0), 2.0) * pm;
    }
    gloss = 1.0;
  } else if(part < 9.5){
    // ---------------------------------------------------- tongue
    float rug = abs(fract(vRest.x * 0.08 + vRest.z * 0.015) - 0.5);
    col = mix(vec3(0.34, 0.1, 0.17), vec3(0.24, 0.06, 0.14), step(rug, 0.2));
    id = uIdBase + 59.0;
    gloss = 1.0;
    shade = col * vec3(0.62, 0.52, 0.8);
  } else {
    // ---------------------------------------------------- gums
    float k = fbm2(vRest.xz * 0.05 + 9.0);
    col = mix(vec3(0.19, 0.06, 0.1), vec3(0.12, 0.035, 0.07), step(0.5, k));
    id = uIdBase + 57.0;
    gloss = 0.15;
    shade = col * vec3(0.55, 0.42, 0.72);
    if(vInfo.w > 1.5){ col = vec3(0.05, 0.02, 0.04); shade = col; gloss = 0.0; id = uIdBase + 56.0; }   // the socket round a tooth
  }

  // ---- lighting: two hard tones through the bumped normal
  vec3 Nb = (h != 0.0) ? bump(N, h, part < 1.5 ? 1.0 : 1.6) : N;
  float ndl = dot(Nb, uKeyDir);
  float sh = uInner > 1.5 ? 1.0 : sunShadow(vWorld + N * 3.0, N);
  float lit = smoothstep(-0.02, 0.04, ndl) * sh * occ;
  vec3 litCol = col * mix(uSkyTint, uSunColor * 1.08, uSunStrength);
  float up = smoothstep(-0.7, 0.6, N.y);
  vec3 shadeCol = (shade.x >= 0.0 ? shade : col * uShadeTint * mix(uBounce, vec3(1.0), up));
  vec3 outc = mix(mix(shadeCol, litCol, 0.1), litCol, lit);
  float deep = step(ndl, -0.5) * step(N.y, -0.3) * step(shade.x, -0.5);
  outc = mix(outc, col * uDeepTint, deep * 0.75);

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 H = normalize(uKeyDir + V);
  float sp = dot(Nb, H);
  // wet hide: sharp broken highlights
  float wetn = 0.6 + 0.4 * step(0.5, fbm2(vWorld.xy * 0.05 + vWorld.z * 0.03));
  float spec = step(0.968, sp) * lit * step(0.38, gloss * wetn);
  outc = mix(outc, vec3(1.0, 0.99, 0.95), spec * 0.8);
  // sky rim on the shadow side keeps the mass readable against the sea
  float fres = 1.0 - max(dot(N, V), 0.0);
  float rimS = smoothstep(0.62, 0.72, fres) * (1.0 - lit) * step(N.y, 0.5) * step(-0.8, N.y) * ((part > 1.5 && part < 2.5) || part > 8.5 ? 0.0 : 1.0);
  outc = mix(outc, mix(outc, vec3(0.62, 0.86, 0.98), 0.75), rimS);
  float back = smoothstep(0.1, 0.5, dot(-V, uKeyDir));
  float rimL = smoothstep(0.66, 0.72, fres) * smoothstep(-0.1, 0.1, ndl) * back;
  outc = mix(outc, uSunColor * 1.2, rimL * 0.8);

  // ---- water sheeting off the body: hard white streaks running down in world space
  if(uRun > 0.002 && (part < 0.5 || part > 7.5) && part < 9.5 && uInner < 0.5){
    float dn = (vWorld.y + uDrawTime * 42.0);
    float ra = vUv.y * 60.0;
    float wig = 6.0 * sin(dn * 0.02 + ra * 0.03);
    float st = fbm2(vec2((ra + wig) * 0.055, dn * 0.004 + uvm.x * 0.0008));
    float st2 = vnoise(vec2((ra + wig) * 0.19, dn * 0.012));
    float downF = smoothstep(0.75, -0.2, N.y);
    float th = mix(0.86, 0.46, uRun);
    float sheet = step(th, st + 0.14 * st2) * downF;
    float core = step(th + 0.1, st + 0.14 * st2) * downF;
    outc = mix(outc, mix(vec3(0.72, 0.84, 0.98), vec3(1.0), lit), sheet * 0.5);
    outc = mix(outc, vec3(1.0), core * (0.4 + 0.6 * lit));
  }
  // foam collar where the hide meets the sea
  if(uFoamLine > 0.0 && part < 0.5 && uPass < 0.5){
    float fy = vWorld.y - uWaterLevel;
    float n0 = vnoise(vWorld.xz * 0.05 + uDrawTime * 0.5);
    float collar = step(fy, uFoamLine * (0.4 + 0.9 * n0));
    outc = mix(outc, mix(vec3(0.74, 0.86, 0.98), vec3(1.0), lit), collar);
  }
  if(part < 0.5 && !gl_FrontFacing && vRest.z > 500.0 && uInner < 0.5) outc = vec3(0.015, 0.008, 0.035);
  writeOut(outc, 1.0, NV, vDepth, id);
}
`;

export function hideMaterial(spine, o = {}) {
  const u = {
    ...G, ...spine.uniforms,
    uBack: { value: new THREE.Color(o.back ?? '#3a6377') },
    uFlank: { value: new THREE.Color(o.flank ?? '#5c8fa3') },
    uBelly: { value: new THREE.Color().setRGB(...(o.bellyRGB ?? (o.back ? [0.94, 1.0, 1.17] : [0.52, 0.62, 0.74]))) },
    uBone: { value: new THREE.Color(o.bone ?? '#8d9490') },
    uIdBase: { value: o.id ?? 2 },
    uRun: o.run ?? { value: 0 },
    uFoamLine: o.foam ?? { value: 0 },
    uScale: { value: o.scale ?? 1 },
    uInner: { value: o.inner ?? 0 }, uPleat: { value: o.pleat ?? 0 },
    uTint: { value: 0 }, uTintCol: { value: new THREE.Color('#000000') },
  };
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u, vertexShader: VS(spine.n), fragmentShader: FS.replace('col = mix(col, flankKmix(col), 0.0 * edgeB);', ''),
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------- geometry accumulator
export class Geo {
  constructor() { this.p = []; this.n = []; this.uv = []; this.info = []; this.idx = []; this.count = 0; }
  v(x, y, z, u, v2, a, b, c, d) {
    this.p.push(x, y, z); this.n.push(0, 0, 0); this.uv.push(u, v2); this.info.push(a, b, c, d);
    return this.count++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }
}

// closed tapered tube along a polyline (rest space). r(i) radius; flatten squashes y
export function addTube(g, pts, radii, o) {
  const seg = o.seg ?? 8, n = pts.length, first = g.count;
  const fl = o.flat ?? 1, part = o.part ?? 0, jaw = o.jaw ?? 0, belly = o.belly ?? 0, seed = o.seed ?? 0;
  const T = new THREE.Vector3(), Up = new THREE.Vector3(0, 1, 0), S = new THREE.Vector3(), U = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    T.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    S.crossVectors(o.up ?? Up, T).normalize(); U.crossVectors(T, S).normalize();
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th), r = radii[i];
      g.v(pts[i][0] + S.x * c * r + U.x * s * r * fl, pts[i][1] + S.y * c * r + U.y * s * r * fl, pts[i][2] + S.z * c * r + U.z * s * r * fl,
        i / (n - 1), j / seg, o.jawAt ? o.jawAt(i) : jaw, part, (o.around ?? 0) + s * r, belly < 0 ? 0.5 - 0.5 * s : belly === undefined ? 0 : belly + 1e-3 * seed);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = first + i * seg + j, b = first + i * seg + (j + 1) % seg, c = a + seg, d = b + seg;
    g.quad(a, c, d, b);
  }
  // caps
  const last = first + (n - 1) * seg;
  for (let j = 1; j < seg - 1; j++) { g.tri(first, first + j, first + j + 1); g.tri(last, last + j + 1, last + j); }
}
