import { perspective, lookAt, multiply, transform, invert, orbitPose, direction, ORBIT_FOV } from './camera.js';
import { ribbonVertices } from './city.js';

const VERTICES = new Float32Array([
  // top
  0,0,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1, 0,1,1,
  // front
  0,1,0, 1,1,0, 1,1,1, 0,1,0, 1,1,1, 0,1,1,
  // back
  1,0,0, 0,0,0, 0,0,1, 1,0,0, 0,0,1, 1,0,1,
  // left
  0,0,0, 0,1,0, 0,1,1, 0,0,0, 0,1,1, 0,0,1,
  // right
  1,1,0, 1,0,0, 1,0,1, 1,1,0, 1,0,1, 1,1,1,
  // bottom
  0,1,0, 0,0,0, 1,0,0, 0,1,0, 1,0,0, 1,1,0,
]);

// Instance kinds in the box program.
export const KIND = { building: 0, block: 1, ground: 2, beacon: 3, wall: 4 };
const FLOATS_PER_INSTANCE = 16;

// Landscape heights are exaggerated relative to the 1000x680 map so small repositories still read as 3D.
const LANDSCAPE_HEIGHT_SCALE = 420 / 170;
const CITY_FOV = 55 * Math.PI / 180;
export const EYE_HEIGHT = 1.7;

// Shared by every program. 2D is an orthographic map; 3D goes through the same view-projection
// matrix that project() uses in JS, so WebGL, the overlay and picking agree exactly.
const PROJECT = `
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uZoom;
uniform float uMode;
uniform mat4 uViewProj;
uniform float uHeightScale;
vec4 projectWorld(vec3 world){
  if(uMode < .5){
    vec2 p = (world.xy - uCenter) * uZoom;
    return vec4(p.x * 2.0 / uViewport.x, -p.y * 2.0 / uViewport.y, min(world.z, 1.0) * .001, 1.0);
  }
  return uViewProj * vec4(world.xy, world.z * uHeightScale, 1.0);
}`;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aUnit;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aColorHeight;
layout(location=3) in vec4 aAtlas;
layout(location=4) in vec4 aMeta;
${PROJECT}
out vec4 vColor;
out vec3 vUnit;
out vec2 vAtlas;
out vec3 vSize;
out float vDepth;
flat out int vFace;
flat out ivec2 vKind;
flat out vec2 vLit;
void main(){
  int kind = int(aMeta.x + .5);
  float height = kind == 0 && uMode < 1.5 ? max(1.0, aColorHeight.a) : aColorHeight.a;
  vec3 world = vec3(aRect.xy + aUnit.xy * aRect.zw, aUnit.z * height);
  vColor = vec4(aColorHeight.rgb, 1.0);
  vUnit = aUnit;
  vAtlas = aAtlas.xy + aUnit.xy * aAtlas.zw;
  vFace = gl_VertexID / 6;
  vKind = ivec2(kind, int(aMeta.w + .5));
  vSize = vec3(aRect.zw, height);
  vLit = aMeta.yz;
  gl_Position = projectWorld(world);
  vDepth = gl_Position.w;
}`;

// Two variants from one source: the landscape build compiles none of the city's fog, window
// and beacon code, which otherwise tripled fragment cost in software renderers.
const fragmentShader = city => `#version 300 es
precision highp float;
${city ? '#define CITY 1' : ''}
in vec4 vColor;
in vec3 vUnit;
in vec2 vAtlas;
flat in int vFace;
flat in ivec2 vKind;
uniform float uMode;
uniform float uAlpha;
uniform sampler2D uCode;
uniform float uCodeOn;
out vec4 outColor;
#ifdef CITY
in vec3 vSize;
in float vDepth;
flat in vec2 vLit;
uniform float uFogDensity;
uniform vec3 uFogColor;
float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
vec3 fog(vec3 color){ return mix(color, uFogColor, 1.0 - exp(-pow(vDepth * uFogDensity, 2.0))); }
#else
vec3 fog(vec3 color){ return color; }
#endif
void main(){
#ifdef CITY
  if(vKind.x == 3){
    // Search beacon: a light column fading upward, open at the top.
    if(vFace == 0 || vFace == 5) discard;
    outColor = vec4(vColor.rgb * pow(1.0 - vUnit.z, 1.6) * .55, 0.0);
    return;
  }
  // The floor is painted without depth testing, so only its top faces may draw (sides and bottoms would
  // paint over them).
  if((vKind.x == 1 || vKind.x == 2) && vFace != 0) discard;
  if(vKind.x == 2){ outColor = vec4(fog(vec3(.035, .032, .028)), uAlpha); return; } // asphalt
  if(vKind.x == 4){
    // City wall: concrete courses and panel joints in metres, lit coping along the top.
    vec2 faceUv = vFace == 0 || vFace == 5 ? vUnit.xy : vFace < 3 ? vUnit.xz : vUnit.yz;
    float along = (vFace < 3 ? vUnit.x * vSize.x : vUnit.y * vSize.y), up = vUnit.z * vSize.z;
    float joints = max(step(.97, fract(along / 6.0)), step(.95, fract(up / 2.8)));
    vec3 concrete = vec3(.12, .13, .16) * (.65 + .35 * vUnit.z) * (1.0 - joints * .35);
    if(vFace == 0) concrete = vec3(.2, .21, .26);
    float edgeWall = min(min(faceUv.x, 1.0 - faceUv.x), min(faceUv.y, 1.0 - faceUv.y));
    float rim = 1.0 - smoothstep(0.0, fwidth(edgeWall) * 1.5 + .002, edgeWall);
    outColor = vec4(fog(mix(concrete, vec3(.78, .95, .21) * .8, rim * step(.9, vUnit.z + (vFace == 0 ? 1.0 : 0.0)))), uAlpha);
    return;
  }
#endif
  if(uMode < .5 && vFace > 0) discard;
  vec2 face = vFace == 0 || vFace == 5 ? vUnit.xy : vFace < 3 ? vUnit.xz : vUnit.yz;
  float edge = min(min(face.x, 1.0-face.x), min(face.y, 1.0-face.y));
  float border = smoothstep(0.0, fwidth(edge)*1.35 + .009, edge);
  // Tile tops match TILE_TOP in app.js so source drawn over a roof blends in; 2D gets a faint layer tint.
  vec3 top = vec3(.086, .078, .059);
  vec3 base = uMode < .5 ? mix(top, vColor.rgb, .07) : top;
#ifdef CITY
  vec3 stroke = mix(vColor.rgb, vec3(1.0), .3) * 1.2; // neon edges at night
#else
  vec3 stroke = mix(vColor.rgb, vec3(1.0), .12);
#endif
  if(vKind.x == 1){
    // Blocks are raised pavements tinted by their dominant layer.
    base = mix(vec3(.075, .085, .11), vColor.rgb, .07);
    stroke = mix(vColor.rgb, base, .55);
  } else if(vFace > 0 && vFace < 5){
    // Walls: a fixed key light per side and a darker foot make buildings read as solids.
    float light = vFace == 1 ? .34 : vFace == 2 ? .2 : vFace == 3 ? .26 : .42;
    base = mix(top, vColor.rgb, light) * (.55 + .45 * vUnit.z);
#ifdef CITY
    stroke = mix(stroke, base, .25);
    // Windows: a grid in metres; the lit share follows the file's definition count.
    float wide = vFace < 3 ? vSize.x : vSize.y;
    vec2 metres = vec2((vFace < 3 ? vUnit.x : vUnit.y) * wide, vUnit.z * vSize.z);
    vec2 cell = floor(metres / vec2(3.2, 3.5)), local = fract(metres / vec2(3.2, 3.5));
    float pane = step(.22, local.x) * step(local.x, .78) * step(.3, local.y) * step(local.y, .78);
    pane *= step(1.0, cell.y) * step(metres.y, vSize.z - 2.0) * step(1.6, metres.x) * step(metres.x, wide - 1.6);
    bool lit = hash(vec3(cell, vLit.y + float(vFace) * 17.0)) < vLit.x;
    vec3 glass = lit ? mix(vec3(1.0, .82, .52), vColor.rgb, .35) * (.8 + .4 * hash(vec3(cell.yx, vLit.y))) : base * .55;
    base = mix(base, glass, pane);
#else
    stroke = mix(stroke, base, .45);
#endif
  } else if(vFace == 0 && uCodeOn > .5){
    // Roofs sample the code overview canvas at this file's rectangle.
    vec4 code = texture(uCode, vAtlas);
    base = mix(base, code.rgb / max(code.a, .001), code.a * .92);
  }
  if(vKind.y == 1) stroke = vec3(1.0, .94, .54); // selected
  outColor = vec4(fog(mix(stroke, base, border)), uAlpha);
}`;

const GRID_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPoint;
${PROJECT}
void main(){ gl_Position = projectWorld(vec3(aPoint, 0.0)); }`;

const GRID_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main(){ outColor = vec4(.95, .92, .86, .08); }`;

// Textured quads for city signs and facades: centre, half-width axis, half-height axis, atlas rect.
const SIGN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenter;
layout(location=2) in vec3 aAxisU;
layout(location=3) in vec3 aAxisV;
layout(location=4) in vec4 aUv;
uniform mat4 uViewProj;
uniform vec3 uEye;
out vec2 vUv;
out float vDepth;
flat out int vMirrored;
void main(){
  // Text reads correctly only when (u x v) faces away from the viewer; back-to-back blade faces rely on this.
  vMirrored = dot(cross(aAxisU, aAxisV), uEye - aCenter) >= 0.0 ? 1 : 0;
  vec3 world = aCenter + aAxisU * (aCorner.x * 2.0 - 1.0) + aAxisV * (aCorner.y * 2.0 - 1.0);
  vUv = aUv.xy + vec2(aCorner.x, 1.0 - aCorner.y) * aUv.zw;
  gl_Position = uViewProj * vec4(world, 1.0);
  vDepth = gl_Position.w;
}`;
const SIGN_FLOATS = 13;

// Import trails: screen-space ribbons along arcs, with dashes flowing from importer to imported.
const TRAIL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aOther;
layout(location=2) in vec3 aSideTKind;
uniform mat4 uViewProj;
uniform vec2 uViewport;
out float vT;
flat out int vKind;
void main(){
  vec4 a = uViewProj * vec4(aPos, 1.0), b = uViewProj * vec4(aOther, 1.0);
  vT = aSideTKind.y; vKind = int(aSideTKind.z + .5);
  if(a.w < .2 || b.w < .2){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // behind the camera
  vec2 dir = normalize((b.xy / b.w - a.xy / a.w) * uViewport + 1e-6);
  vec2 offset = vec2(-dir.y, dir.x) * aSideTKind.x * 2.5 / uViewport;
  gl_Position = a + vec4(offset * a.w, 0.0, 0.0);
}`;

const TRAIL_FS = `#version 300 es
precision highp float;
in float vT;
flat in int vKind;
uniform float uTime;
out vec4 outColor;
void main(){
  vec3 color = vKind == 0 ? vec3(.21, .83, .76) : vec3(.97, .74, .3);
  float dash = fract(vT * 14.0 - uTime * .9);
  float glow = .35 + .65 * smoothstep(.0, .25, dash) * (1.0 - smoothstep(.55, .8, dash));
  if(vKind == 1 && dash > .6) discard; // inferred links are dashed
  outColor = vec4(color * glow, 0.0);
}`;
const TRAIL_FLOATS = 9;

// Street routes: flat ribbons on the road with chevrons flowing toward the destination.
const ROUTE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aAcrossAlongKind;
uniform mat4 uViewProj;
out vec2 vAcrossAlong;
out float vDepth;
flat out int vKind;
void main(){
  vAcrossAlong = aAcrossAlongKind.xy; vKind = int(aAcrossAlongKind.z + .5);
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vDepth = gl_Position.w;
}`;

const ROUTE_FS = `#version 300 es
precision highp float;
in vec2 vAcrossAlong;
in float vDepth;
flat in int vKind;
uniform float uTime;
uniform float uFogDensity;
out vec4 outColor;
void main(){
  float across = abs(vAcrossAlong.x), fog = exp(-pow(vDepth * uFogDensity, 2.0));
  if(vKind == 2){
    // Dependents: magenta dashes marching toward the selected file, with a pulse travelling along them.
    float dash = fract(vAcrossAlong.y * .16 - uTime * 1.1);
    float onDash = smoothstep(0.0, .05, dash) * (1.0 - smoothstep(.5, .56, dash));
    float pulse = .55 + .45 * sin(uTime * 5.0 - vAcrossAlong.y * .35);
    float edge = 1.0 - smoothstep(.55, .95, across);
    outColor = vec4(vec3(1.0, .22, .72) * edge * (.06 + onDash * (.3 + .45 * pulse)) * fog, 0.0);
    return;
  }
  vec3 color = vKind == 0 ? vec3(.21, .83, .76) : vec3(.97, .74, .3);
  // Chevron tips lead: the phase grows toward the centre line, and time moves it forward.
  float phase = fract(vAcrossAlong.y * .22 + across * .35 - uTime * 1.4);
  float chevron = smoothstep(0.0, .06, phase) * (1.0 - smoothstep(.22, .32, phase));
  float body = 1.0 - smoothstep(.7, 1.0, across);
  float glow = body * (.16 + .95 * chevron) * fog;
  outColor = vec4(color * glow, 0.0);
}`;
const ROUTE_FLOATS = 6;

// Fire and smoke over buildings with security alerts. Particles are stateless: each one's age is
// derived from time and its seed in the vertex shader, so the CPU only uploads emitters once.
const FIRE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aEmitter;   // roof centre x, y, z and footprint radius
layout(location=2) in vec3 aSeedKind;  // seed, kind (0 smoke, 1 flame), emitter scale
uniform mat4 uViewProj;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uTime;
out vec2 vCorner;
out float vAge;
flat out int vKind;
out float vDepth;
float hash(float n){ return fract(sin(n * 91.3458) * 47453.5453); }
void main(){
  float seed = aSeedKind.x, radius = aEmitter.w, scale = aSeedKind.z;
  vKind = int(aSeedKind.y + .5);
  float rate = vKind == 1 ? .9 + hash(seed) * .5 : .09 + hash(seed) * .05;
  float age = fract(uTime * rate + hash(seed + 1.7));
  vAge = age;
  float angle = hash(seed + 3.1) * 6.2832, spread = sqrt(hash(seed + 5.3)) * radius * (vKind == 1 ? .75 : .45);
  vec3 base = aEmitter.xyz + vec3(cos(angle) * spread, sin(angle) * spread, 0.0);
  vec3 rise = vKind == 1
    ? vec3(0.0, 0.0, age * (3.0 + radius * .45))
    : vec3(vec2(1.0, .55) * age * age * (18.0 + radius), age * (28.0 + radius * 2.5)) + vec3(sin(age * 7.0 + seed) * 1.5, cos(age * 5.0 + seed) * 1.5, 0.0);
  float size = (vKind == 1 ? mix(1.6, .4, age) * (.7 + radius * .08) : mix(2.0, 9.0, age) * (.6 + radius * .05)) * scale;
  vCorner = aCorner * 2.0 - 1.0;
  vec3 world = base + rise * scale + (uRight * vCorner.x + uUp * vCorner.y) * size;
  gl_Position = uViewProj * vec4(world, 1.0);
  vDepth = gl_Position.w;
}`;

const FIRE_FS = `#version 300 es
precision highp float;
in vec2 vCorner;
in float vAge;
flat in int vKind;
in float vDepth;
uniform float uFogDensity;
out vec4 outColor;
void main(){
  float r = length(vCorner);
  if(r > 1.0) discard;
  float soft = pow(1.0 - r, 1.5), fog = exp(-pow(vDepth * uFogDensity, 2.0));
  if(vKind == 1){
    vec3 color = mix(vec3(1.0, .92, .55), mix(vec3(1.0, .45, .08), vec3(.7, .08, .02), smoothstep(.4, 1.0, vAge)), smoothstep(0.0, .45, vAge));
    outColor = vec4(color * soft * (1.0 - vAge) * 1.4 * fog, 0.0); // additive glow
  } else {
    float alpha = soft * .5 * smoothstep(0.0, .12, vAge) * (1.0 - vAge) * fog;
    outColor = vec4(vec3(.16, .15, .15) * alpha, alpha); // premultiplied dark smoke
  }
}`;
const FIRE_FLOATS = 7;

// Residents: camera-facing sprites drawn procedurally as glowing stick figures with a walk cycle.
const WANDERER_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aPosPhaseSeed;
uniform mat4 uViewProj;
uniform vec2 uRight;
uniform float uScale;
out vec2 vLocal;
out float vPhase;
out float vDepth;
flat out float vSeed;
const vec2 SIZE = vec2(.5, 1.35);
void main(){
  vLocal = vec2(aCorner.x * 2.0 - 1.0, aCorner.y) * SIZE;
  vPhase = aPosPhaseSeed.z; vSeed = aPosPhaseSeed.w;
  vec3 world = vec3(aPosPhaseSeed.xy + uRight * vLocal.x * uScale, vLocal.y * uScale);
  gl_Position = uViewProj * vec4(world, 1.0);
  vDepth = gl_Position.w;
}`;

const WANDERER_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vPhase;
in float vDepth;
flat in float vSeed;
uniform float uTime;
uniform float uFogDensity;
uniform float uSelectedSeed;
out vec4 outColor;
float segment(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
void main(){
  vec2 p = vLocal;
  float swing = sin(vPhase), bob = abs(cos(vPhase)) * .03;
  vec2 hip = vec2(0.0, .5 + bob), neck = vec2(0.0, .92 + bob);
  float d = length(p - vec2(0.0, 1.08 + bob)) - .1;                        // head
  d = min(d, segment(p, hip, neck) - .045);                                // body
  d = min(d, segment(p, neck - vec2(0.0, .06), vec2(-.26, .66 + swing * .1 + bob)) - .03); // arms
  d = min(d, segment(p, neck - vec2(0.0, .06), vec2(.26, .66 - swing * .1 + bob)) - .03);
  d = min(d, segment(p, hip, vec2(-.16 * swing - .04, 0.0)) - .035);        // legs
  d = min(d, segment(p, hip, vec2(.16 * swing + .04, 0.0)) - .035);
  float aa = fwidth(d) + .002;
  float body = 1.0 - smoothstep(0.0, aa, d), halo = exp(-max(d, 0.0) * 18.0) * .35;
  float flicker = .85 + .15 * sin(uTime * 7.0 + vSeed * 40.0);
  vec3 green = vec3(.32, 1.0, .38) * flicker;
  float fog = exp(-pow(vDepth * uFogDensity, 2.0));
  if(abs(vSeed - uSelectedSeed) < 1e-7){
    // The selected resident glows pink with a wider halo.
    green = vec3(1.0, .37, .66);
    halo = exp(-max(d, 0.0) * 7.0) * .6;
  }
  if(body + halo < .01) discard;
  outColor = vec4(green * (body + halo) * fog, 0.0);
}`;

const SIGN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vDepth;
flat in int vMirrored;
uniform sampler2D uTexture;
uniform float uFogDensity;
out vec4 outColor;
void main(){
  if(vMirrored == 1) discard;
  vec4 color = texture(uTexture, vUv);
  if(color.a < .02) discard;
  outColor = color * exp(-pow(vDepth * uFogDensity, 2.0)); // premultiplied, so fading toward clear
}`;

function program(gl, vertex, fragment) {
  const value = gl.createProgram();
  gl.attachShader(value, shader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(value, shader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(value);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(value));
  return value;
}

function shader(gl, type, source) {
  const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
  return value;
}

function uniformsOf(gl, prog) {
  const out = {}, count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) { const name = gl.getActiveUniform(prog, i).name; out[name] = gl.getUniformLocation(prog, name); }
  return out;
}

export class LandscapeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.program = program(gl, VS, fragmentShader(false)); this.uniforms = uniformsOf(gl, this.program);
    this.cityProgram = program(gl, VS, fragmentShader(true)); this.cityUniforms = uniformsOf(gl, this.cityProgram);
    this.gridProgram = program(gl, GRID_VS, GRID_FS); this.gridUniforms = uniformsOf(gl, this.gridProgram);
    const grid = [];
    for (let x = -200; x <= 1200; x += 100) grid.push(x, -200, x, 900);
    for (let y = -200; y <= 900; y += 100) grid.push(-200, y, 1200, y);
    this.gridVao = gl.createVertexArray(); gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.gridCount = grid.length / 2;
    this.codeTexture = gl.createTexture(); this.codeOn = false;
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.cube = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.cube); gl.bufferData(gl.ARRAY_BUFFER, VERTICES, gl.STATIC_DRAW);
    this.landscape = this.boxLayer(); this.cityLayer = this.boxLayer(); this.cityFloor = this.boxLayer();
    this.signProgram = program(gl, SIGN_VS, SIGN_FS); this.signUniforms = uniformsOf(gl, this.signProgram);
    this.corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.signLayer = this.quadLayer(); this.facadeLayer = this.quadLayer(); this.posterLayer = this.quadLayer(); this.posterTexture = this.texture();
    this.atlasTexture = this.texture(); this.facadeTexture = this.texture(); this.atlasGeneration = -1;
    this.trailProgram = program(gl, TRAIL_VS, TRAIL_FS); this.trailUniforms = uniformsOf(gl, this.trailProgram);
    this.trailLayer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(this.trailLayer.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.trailLayer.buffer);
    [[0, 0], [1, 12], [2, 24]].forEach(([index, offset]) => { gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, 3, gl.FLOAT, false, TRAIL_FLOATS * 4, offset); });
    this.beaconLayer = this.boxLayer();
    this.routeProgram = program(gl, ROUTE_VS, ROUTE_FS); this.routeUniforms = uniformsOf(gl, this.routeProgram);
    this.fireProgram = program(gl, FIRE_VS, FIRE_FS); this.fireUniforms = uniformsOf(gl, this.fireProgram);
    this.smokeLayer = this.particleLayer(); this.flameLayer = this.particleLayer();
    this.wandererProgram = program(gl, WANDERER_VS, WANDERER_FS); this.wandererUniforms = uniformsOf(gl, this.wandererProgram);
    this.wandererLayer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(this.wandererLayer.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wandererLayer.buffer); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(1, 1);
    this.routeLayer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(this.routeLayer.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.routeLayer.buffer);
    [[0, 0], [1, 12]].forEach(([index, offset]) => { gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, 3, gl.FLOAT, false, ROUTE_FLOATS * 4, offset); });
    this.time = 0;
    this.camera = { x: 500, y: 350, zoom: 1, yaw: -.1, pitch: .78, distance: 3.5 };
    // City camera: 'heli' orbits a ground target; 'walk' and 'fly' look out from an eye position.
    this.city = { view: 'heli', x: 0, y: 0, yaw: -.12, pitch: .8, distance: 500, ex: 0, ey: 0, ez: EYE_HEIGHT, lookYaw: 0, lookPitch: 0 };
    this.mode = '2d';
    this.resize();
  }

  boxLayer() {
    const gl = this.gl, layer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(layer.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i + 1); gl.vertexAttribPointer(i + 1, 4, gl.FLOAT, false, FLOATS_PER_INSTANCE * 4, i * 16); gl.vertexAttribDivisor(i + 1, 1);
    }
    return layer;
  }

  quadLayer() {
    const gl = this.gl, layer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(layer.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    [[1, 3, 0], [2, 3, 12], [3, 3, 24], [4, 4, 36]].forEach(([index, size, offset]) => {
      gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, size, gl.FLOAT, false, SIGN_FLOATS * 4, offset); gl.vertexAttribDivisor(index, 1);
    });
    return layer;
  }

  texture() {
    const gl = this.gl, texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  // quads: [{ c, u, v, uv: {u, v, du, dv} }] from city.js placement helpers.
  static packQuads(quads) {
    const packed = new Float32Array(quads.length * SIGN_FLOATS);
    quads.forEach((q, i) => packed.set([...q.c, ...q.u, ...q.v, q.uv.u, q.uv.v, q.uv.du, q.uv.dv], i * SIGN_FLOATS));
    return packed;
  }

  setSigns(quads, atlas) {
    this.atlas = atlas;
    const gl = this.gl, packed = LandscapeRenderer.packQuads(quads);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.signLayer.buffer); gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
    this.signLayer.count = quads.length;
  }

  // Posters on the city wall: a PosterAtlas and quads with uv rects; uploaded once per city.
  setPosters(atlas, quads) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.posterTexture); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posterLayer.buffer); gl.bufferData(gl.ARRAY_BUFFER, LandscapeRenderer.packQuads(quads), gl.STATIC_DRAW);
    this.posterLayer.count = quads.length;
  }

  // Source code on one wall: a canvas and its quad, or null to hide.
  setFacade(canvas, quad) {
    const gl = this.gl;
    if (!canvas || !quad) { this.facadeLayer.count = 0; return; }
    if (canvas !== this.facadeSource) {
      gl.bindTexture(gl.TEXTURE_2D, this.facadeTexture); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.facadeSource = canvas;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.facadeLayer.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, LandscapeRenderer.packQuads([{ ...quad, uv: { u: 0, v: 0, du: 1, dv: 1 } }]), gl.DYNAMIC_DRAW);
    this.facadeLayer.count = 1;
  }

  // arcs: [{ points: [[x,y,z], ...], kind: 0 known | 1 inferred }] ordered from importer to imported.
  setTrails(arcs) {
    const vertices = [];
    for (const arc of arcs) {
      const n = arc.points.length - 1;
      for (let i = 0; i < n; i++) {
        const a = arc.points[i], b = arc.points[i + 1], ta = i / n, tb = (i + 1) / n;
        // Two triangles per segment; the far end looks back at the near end, so its side flips.
        vertices.push(...a, ...b, 1, ta, arc.kind, ...a, ...b, -1, ta, arc.kind, ...b, ...a, -1, tb, arc.kind);
        vertices.push(...a, ...b, -1, ta, arc.kind, ...b, ...a, 1, tb, arc.kind, ...b, ...a, -1, tb, arc.kind);
      }
    }
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.trailLayer.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    this.trailLayer.count = vertices.length / TRAIL_FLOATS;
  }

  // routes: [{ points: [[x,y], ...], kind }] drawn on the ground from first point to last.
  setRoutes(routes) {
    const vertices = ribbonVertices(routes);
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.routeLayer.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    this.routeLayer.count = vertices.length / ROUTE_FLOATS;
  }


  particleLayer() {
    const gl = this.gl, layer = { vao: gl.createVertexArray(), buffer: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(layer.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FIRE_FLOATS * 4, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, FIRE_FLOATS * 4, 16); gl.vertexAttribDivisor(2, 1);
    return layer;
  }

  // emitters: [{ x, y, z, radius, burning }] — every emitter smokes, burning ones also carry flames.
  setFires(emitters) {
    const smoke = [], flames = [];
    emitters.forEach((e, index) => {
      const radius = Math.max(2, e.radius), smokeCount = Math.round(Math.min(60, 18 + radius * 1.5)), flameCount = Math.round(Math.min(70, 16 + radius * 2));
      for (let i = 0; i < smokeCount; i++) smoke.push(e.x, e.y, e.z, radius, index * 131 + i * 7.13, 0, 1);
      if (e.burning) for (let i = 0; i < flameCount; i++) flames.push(e.x, e.y, e.z, radius, index * 97 + i * 3.71 + .5, 1, 1);
    });
    const gl = this.gl;
    for (const [layer, data] of [[this.smokeLayer, smoke], [this.flameLayer, flames]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      layer.count = data.length / FIRE_FLOATS;
    }
  }

  // Resident positions as packed [x, y, phase, seed] per figure; called every frame while they walk.
  setWanderers(packed) {
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.wandererLayer.buffer); gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
    this.wandererLayer.count = packed.length / 4;
  }

  // beams: [{ x, y, w, h, height, color }] rising from search hits.
  setBeacons(beams) {
    const packed = new Float32Array(beams.length * FLOATS_PER_INSTANCE);
    beams.forEach((b, i) => packed.set([b.x, b.y, b.w, b.h, ...b.color, b.height, 0, 0, 0, 0, KIND.beacon, 0, 0, 0], i * FLOATS_PER_INSTANCE));
    this.upload(this.beaconLayer, packed);
  }

  // Residents are drawn larger from the air so crowds stay visible; picking uses the same scale.
  residentScale() {
    const c = this.city;
    return c.view === 'heli' ? Math.min(6, Math.max(1, c.distance / 250)) : c.view === 'fly' ? Math.min(4, Math.max(1, c.ez / 120)) : 1;
  }

  get animating() { return this.mode === 'city' && (this.trailLayer.count > 0 || this.routeLayer.count > 0 || this.wandererLayer.count > 0 || this.smokeLayer.count > 0); }

  syncAtlas() {
    const gl = this.gl, atlas = this.atlas; if (!atlas) return;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (this.atlasGeneration === -1) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas); this.atlasGeneration = 0; atlas.takeDirty(); this.mipmapAtlas(); return; }
    const dirty = atlas.takeDirty();
    if (dirty) { gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, gl.RGBA, gl.UNSIGNED_BYTE, dirty.image); this.mipmapAtlas(); }
  }

  // Signs are mostly seen small and at grazing angles; without mipmaps the text shimmers.
  mipmapAtlas() {
    const gl = this.gl;
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  drawQuads(layer, texture) {
    if (!layer.count) return;
    const gl = this.gl, u = this.signUniforms;
    gl.useProgram(this.signProgram); gl.bindVertexArray(layer.vao);
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj); gl.uniform1f(u.uFogDensity, this.fogDensity()); gl.uniform3f(u.uEye, ...this.eye);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(u.uTexture, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.count);
  }

  upload(layer, packed) {
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer); gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
    layer.count = packed.length / FLOATS_PER_INSTANCE; layer.packed = packed;
  }

  // Landscape tiles: items carry x,y,w,h (map units), color and height.
  setData(items) {
    this.items = items;
    const packed = new Float32Array(items.length * FLOATS_PER_INSTANCE);
    items.forEach((item, i) => packed.set([item.x, item.y, item.w, item.h, ...item.color, item.height, item.x / 1000, item.y / 680, item.w / 1000, item.h / 680, KIND.building, 0, item.id, 0], i * FLOATS_PER_INSTANCE));
    this.upload(this.landscape, packed);
  }

  // City instances: [{x,y,w,h,height,color,atlas:[u,v,du,dv],kind,id}] in metres.
  // The floor (ground and folder pavements, in nesting order) is its own layer: its surfaces are
  // centimetres apart, far below depth-buffer precision from the air, so it is painted in order
  // without depth testing instead of z-fighting (see render()).
  setCity(instances, bounds) {
    const pack = list => {
      const packed = new Float32Array(list.length * FLOATS_PER_INSTANCE);
      list.forEach((b, i) => packed.set([b.x, b.y, b.w, b.h, ...b.color, b.height, ...(b.atlas || [0, 0, 0, 0]), b.kind, b.lit || 0, b.id || 0, 0], i * FLOATS_PER_INSTANCE));
      return packed;
    };
    const floor = instances.filter(b => b.kind === KIND.ground || b.kind === KIND.block);
    this.cityInstances = instances; this.cityBounds = bounds;
    this.upload(this.cityFloor, pack(floor));
    this.upload(this.cityLayer, pack(instances.filter(b => b.kind !== KIND.ground && b.kind !== KIND.block)));
  }

  // Highlights one landscape tile and one city building by file id (0 clears).
  setSelected(id) {
    for (const layer of [this.landscape, this.cityLayer]) {
      const packed = layer.packed; if (!packed) continue;
      for (let o = 0; o < packed.length; o += FLOATS_PER_INSTANCE) packed[o + 15] = id && packed[o + 12] === KIND.building && packed[o + 14] === id ? 1 : 0;
      const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed);
    }
  }

  resize() {
    // Cache the CSS size once per frame: project() runs tens of thousands of times per frame,
    // and reading clientWidth there forces layout queries that dominated 3D frame time.
    this.width = Math.max(1, this.canvas.clientWidth); this.height = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.max(1, Math.floor(this.width * dpr)), h = Math.max(1, Math.floor(this.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr; this.gl.viewport(0, 0, w, h); this.updateView();
  }

  // Uploads the code overview canvas as the roof texture; call again after it changes.
  setCodeTexture(source) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.codeTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // mipmaps of straight alpha get dark fringes around glyphs
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  setCameraUniforms(u) {
    const gl = this.gl;
    gl.uniform2f(u.uCenter, this.camera.x, this.camera.y);
    gl.uniform2f(u.uViewport, this.width, this.height);
    gl.uniform1f(u.uZoom, this.camera.zoom);
    gl.uniform1f(u.uMode, this.mode === '2d' ? 0 : this.mode === '3d' ? 1 : 2);
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    if (u.uHeightScale) gl.uniform1f(u.uHeightScale, this.heightScale);
  }

  // Eye and look direction of the current city camera.
  cityPose() {
    const c = this.city;
    if (c.view === 'heli') {
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const eye = [c.x + sy * cp * c.distance, c.y + cy * cp * c.distance, sp * c.distance];
      return { eye, forward: [-sy * cp, -cy * cp, -sp] };
    }
    return { eye: [c.ex, c.ey, c.ez], forward: direction(c.lookYaw, c.lookPitch) };
  }

  // Recomputes the 3D view-projection from the active camera; runs on every resize check.
  updateView() {
    const aspect = this.width / this.height;
    if (this.mode === 'city') {
      this.heightScale = 1;
      const { eye, forward } = this.cityPose(), c = this.city;
      const size = Math.max(this.cityBounds?.width || 1000, this.cityBounds?.height || 1000);
      const near = c.view === 'heli' ? Math.max(.5, c.distance * .002) : .1, far = c.view === 'heli' ? c.distance * 3 + size * 2 : size * 2.5 + 2000;
      this.eye = eye; this.forward = forward;
      this.view = lookAt(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], Math.abs(forward[2]) > .999 ? [0, -1, 0] : [0, 0, 1]);
      this.viewProj = multiply(perspective(CITY_FOV, aspect, near, far), this.view);
    } else {
      this.heightScale = LANDSCAPE_HEIGHT_SCALE;
      const pose = orbitPose(this.camera);
      this.eye = pose.eye;
      this.viewProj = multiply(perspective(ORBIT_FOV, aspect, 4, 60000), lookAt(pose.eye, pose.target, pose.up));
    }
    this.inverseViewProj = null;
  }

  // Night fog: thick enough to give depth, thin enough to keep the city legible from the air.
  fogDensity() {
    if (this.mode !== 'city') return 0;
    const c = this.city, size = Math.max(this.cityBounds?.width || 1000, this.cityBounds?.height || 1000);
    if (c.view === 'heli') return 1.1 / (c.distance * 2.4 + size * .8);
    return 1 / (c.view === 'walk' ? 520 : 700 + c.ez * 5);
  }

  render(alpha = 1) {
    const gl = this.gl; this.resize();
    const fogColor = [.05, .045, .038], fog = this.fogDensity();
    if (this.mode === 'city') gl.clearColor(...fogColor, 1); else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.mode === '3d') {
      // Ground grid first without writing depth; buildings then cover it where they stand.
      gl.useProgram(this.gridProgram); gl.bindVertexArray(this.gridVao); this.setCameraUniforms(this.gridUniforms);
      gl.depthMask(false); gl.drawArrays(gl.LINES, 0, this.gridCount); gl.depthMask(true);
    }
    const city = this.mode === 'city', u = city ? this.cityUniforms : this.uniforms, layer = city ? this.cityLayer : this.landscape;
    gl.useProgram(city ? this.cityProgram : this.program); gl.bindVertexArray(layer.vao); this.setCameraUniforms(u);
    gl.uniform1f(u.uAlpha, alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.codeTexture); gl.uniform1i(u.uCode, 0);
    gl.uniform1f(u.uCodeOn, this.codeOn && this.mode !== '2d' ? 1 : 0);
    if (city) {
      gl.uniform1f(u.uFogDensity, fog); gl.uniform3f(u.uFogColor, ...fogColor);
      // Floor first, painter's order, no depth: later (deeper) folders simply cover their parents.
      gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(this.cityFloor.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.cityFloor.count);
      gl.enable(gl.DEPTH_TEST); gl.bindVertexArray(layer.vao);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, layer.count);
    if (this.mode === 'city') {
      // Light effects add colour and never occlude: additive blending without depth writes.
      gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
      if (this.beaconLayer.count) { gl.bindVertexArray(this.beaconLayer.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.beaconLayer.count); }
      if (this.smokeLayer.count) {
        // Camera-facing particles: the view matrix rows are the camera's right and up axes.
        const f = this.fireUniforms, v = this.view, c = this.city;
        gl.useProgram(this.fireProgram);
        gl.uniformMatrix4fv(f.uViewProj, false, this.viewProj); gl.uniform3f(f.uRight, v[0], v[4], v[8]); gl.uniform3f(f.uUp, v[1], v[5], v[9]);
        gl.uniform1f(f.uTime, performance.now() / 1000); gl.uniform1f(f.uFogDensity, fog * .6);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.bindVertexArray(this.smokeLayer.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.smokeLayer.count);
        gl.blendFunc(gl.ONE, gl.ONE); if (this.flameLayer.count) { gl.bindVertexArray(this.flameLayer.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.flameLayer.count); }
      }
      if (this.wandererLayer.count) {
        const w = this.wandererUniforms, f = this.forward, len = Math.hypot(f[0], f[1]) || 1, c = this.city;
        gl.useProgram(this.wandererProgram); gl.bindVertexArray(this.wandererLayer.vao);
        gl.uniformMatrix4fv(w.uViewProj, false, this.viewProj); gl.uniform2f(w.uRight, -f[1] / len, f[0] / len);
        // From the air they'd be sub-pixel; grow them so crowds read as drifting green specks.
        gl.uniform1f(w.uScale, this.residentScale()); gl.uniform1f(w.uSelectedSeed, this.selectedResidentSeed ?? -1);
        gl.uniform1f(w.uTime, performance.now() / 1000); gl.uniform1f(w.uFogDensity, fog);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.wandererLayer.count);
      }
      if (this.routeLayer.count) {
        const r = this.routeUniforms;
        gl.useProgram(this.routeProgram); gl.bindVertexArray(this.routeLayer.vao);
        gl.uniformMatrix4fv(r.uViewProj, false, this.viewProj); gl.uniform1f(r.uTime, performance.now() / 1000); gl.uniform1f(r.uFogDensity, fog);
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4);
        gl.drawArrays(gl.TRIANGLES, 0, this.routeLayer.count);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      if (this.trailLayer.count) {
        const t = this.trailUniforms;
        gl.useProgram(this.trailProgram); gl.bindVertexArray(this.trailLayer.vao);
        gl.uniformMatrix4fv(t.uViewProj, false, this.viewProj); gl.uniform2f(t.uViewport, this.width, this.height); gl.uniform1f(t.uTime, performance.now() / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, this.trailLayer.count);
      }
      gl.depthMask(true); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // Signs sit on or just off surfaces: test depth, don't write it, and pull them forward a touch.
      this.syncAtlas();
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -8);
      this.drawQuads(this.posterLayer, this.posterTexture);
      this.drawQuads(this.facadeLayer, this.facadeTexture);
      this.drawQuads(this.signLayer, this.atlasTexture);
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  // Geometry of an item in the active world: map units for 2D/3D, metres in the city.
  geom(item) { return this.mode === 'city' ? item.city || item : item; }

  screenRect(item) {
    const g = this.geom(item);
    if (this.mode === '2d') return { x: (g.x - this.camera.x) * this.camera.zoom + this.width / 2, y: (g.y - this.camera.y) * this.camera.zoom + this.height / 2, w: g.w * this.camera.zoom, h: g.h * this.camera.zoom };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of [[g.x, g.y], [g.x + g.w, g.y], [g.x, g.y + g.h], [g.x + g.w, g.y + g.h]]) {
      const p = this.project([x, y, g.height]);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Screen position of a world point; depth is the view distance, and points behind the camera are NaN.
  project([x, y, z = 0]) {
    const [cx, cy, , cw] = transform(this.viewProj, x, y, z * this.heightScale);
    if (cw <= 1e-3) return { x: NaN, y: NaN, depth: Infinity };
    return { x: (cx / cw + 1) / 2 * this.width, y: (1 - cy / cw) / 2 * this.height, depth: cw };
  }

  // World-space ray through a screen point (3D modes), with z in the active height units.
  ray(screenX, screenY) {
    this.inverseViewProj ||= invert(this.viewProj);
    const m = this.inverseViewProj, nx = screenX / this.width * 2 - 1, ny = 1 - screenY / this.height * 2;
    const point = z => { const [x, y, w, q] = transform(m, nx, ny, z); return [x / q, y / q, w / q]; };
    const a = point(-1), b = point(1), len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return { origin: a, dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len] };
  }

  worldAt(clientX, clientY) {
    return { x: this.camera.x + (clientX - this.width / 2) / this.camera.zoom, y: this.camera.y + (clientY - this.height / 2) / this.camera.zoom };
  }
}
