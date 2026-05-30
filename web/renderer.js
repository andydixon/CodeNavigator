import { perspective, lookAt, multiply, transform, invert, orbitPose, direction, ORBIT_FOV } from './camera.js';

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
export const KIND = { building: 0, block: 1, ground: 2 };
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
flat out int vFace;
flat out ivec2 vKind;
void main(){
  int kind = int(aMeta.x + .5);
  float height = kind == 0 && uMode < 1.5 ? max(1.0, aColorHeight.a) : aColorHeight.a;
  vec3 world = vec3(aRect.xy + aUnit.xy * aRect.zw, aUnit.z * height);
  vColor = vec4(aColorHeight.rgb, 1.0);
  vUnit = aUnit;
  vAtlas = aAtlas.xy + aUnit.xy * aAtlas.zw;
  vSize = vec3(aRect.zw, height);
  vFace = gl_VertexID / 6;
  vKind = ivec2(kind, int(aMeta.w + .5));
  gl_Position = projectWorld(world);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec3 vUnit;
in vec2 vAtlas;
in vec3 vSize;
flat in int vFace;
flat in ivec2 vKind;
uniform float uMode;
uniform float uAlpha;
uniform sampler2D uCode;
uniform float uCodeOn;
out vec4 outColor;
void main(){
  if(uMode < .5 && vFace > 0) discard;
  vec2 face = vFace == 0 || vFace == 5 ? vUnit.xy : vFace < 3 ? vUnit.xz : vUnit.yz;
  float edge = min(min(face.x, 1.0-face.x), min(face.y, 1.0-face.y));
  float border = smoothstep(0.0, fwidth(edge)*1.35 + .009, edge);
  // Tile tops match TILE_TOP in app.js so source drawn over a roof blends in; 2D gets a faint layer tint.
  vec3 top = vec3(.055, .067, .094);
  vec3 base = uMode < .5 ? mix(top, vColor.rgb, .07) : top;
  vec3 stroke = mix(vColor.rgb, vec3(1.0), .12);
  if(vKind.x == 2){
    outColor = vec4(.03, .036, .052, uAlpha); // asphalt
    return;
  }
  if(vKind.x == 1){
    // Blocks are raised pavements tinted by their dominant layer.
    base = mix(vec3(.075, .085, .11), vColor.rgb, .07);
    stroke = mix(vColor.rgb, base, .55);
  } else if(vFace > 0 && vFace < 5){
    // Walls: a fixed key light per side and a darker foot make buildings read as solids.
    float light = vFace == 1 ? .34 : vFace == 2 ? .2 : vFace == 3 ? .26 : .42;
    base = mix(top, vColor.rgb, light) * (.55 + .45 * vUnit.z);
    stroke = mix(stroke, base, .45);
  } else if(vFace == 0 && uCodeOn > .5){
    // Roofs sample the code overview canvas at this file's rectangle.
    vec4 code = texture(uCode, vAtlas);
    base = mix(base, code.rgb / max(code.a, .001), code.a * .92);
  }
  if(vKind.y == 1) stroke = vec3(1.0, .94, .54); // selected
  outColor = vec4(mix(stroke, base, border), uAlpha);
}`;

const GRID_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPoint;
${PROJECT}
void main(){ gl_Position = projectWorld(vec3(aPoint, 0.0)); }`;

const GRID_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main(){ outColor = vec4(.59, .63, 1.0, .11); }`;

// Textured quads for city signs and facades: centre, half-width axis, half-height axis, atlas rect.
const SIGN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenter;
layout(location=2) in vec3 aAxisU;
layout(location=3) in vec3 aAxisV;
layout(location=4) in vec4 aUv;
uniform mat4 uViewProj;
out vec2 vUv;
void main(){
  vec3 world = aCenter + aAxisU * (aCorner.x * 2.0 - 1.0) + aAxisV * (aCorner.y * 2.0 - 1.0);
  vUv = aUv.xy + vec2(aCorner.x, 1.0 - aCorner.y) * aUv.zw;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const SIGN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main(){
  vec4 color = texture(uTexture, vUv);
  if(color.a < .02) discard;
  outColor = color;
}`;
const SIGN_FLOATS = 13;

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
    this.program = program(gl, VS, FS); this.uniforms = uniformsOf(gl, this.program);
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
    this.landscape = this.boxLayer(); this.cityLayer = this.boxLayer();
    this.signProgram = program(gl, SIGN_VS, SIGN_FS); this.signUniforms = uniformsOf(gl, this.signProgram);
    this.corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.signLayer = this.quadLayer(); this.facadeLayer = this.quadLayer();
    this.atlasTexture = this.texture(); this.facadeTexture = this.texture(); this.atlasGeneration = -1;
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
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
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
  setCity(instances, bounds) {
    const packed = new Float32Array(instances.length * FLOATS_PER_INSTANCE);
    instances.forEach((b, i) => packed.set([b.x, b.y, b.w, b.h, ...b.color, b.height, ...(b.atlas || [0, 0, 0, 0]), b.kind, 0, b.id || 0, 0], i * FLOATS_PER_INSTANCE));
    this.cityInstances = instances; this.cityBounds = bounds;
    this.upload(this.cityLayer, packed);
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
      this.viewProj = multiply(perspective(CITY_FOV, aspect, near, far), lookAt(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], Math.abs(forward[2]) > .999 ? [0, -1, 0] : [0, 0, 1]));
    } else {
      this.heightScale = LANDSCAPE_HEIGHT_SCALE;
      const pose = orbitPose(this.camera);
      this.eye = pose.eye;
      this.viewProj = multiply(perspective(ORBIT_FOV, aspect, 4, 60000), lookAt(pose.eye, pose.target, pose.up));
    }
    this.inverseViewProj = null;
  }

  render(alpha = 1) {
    const gl = this.gl; this.resize();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.mode === '3d') {
      // Ground grid first without writing depth; buildings then cover it where they stand.
      gl.useProgram(this.gridProgram); gl.bindVertexArray(this.gridVao); this.setCameraUniforms(this.gridUniforms);
      gl.depthMask(false); gl.drawArrays(gl.LINES, 0, this.gridCount); gl.depthMask(true);
    }
    const u = this.uniforms, layer = this.mode === 'city' ? this.cityLayer : this.landscape;
    gl.useProgram(this.program); gl.bindVertexArray(layer.vao); this.setCameraUniforms(u);
    gl.uniform1f(u.uAlpha, alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.codeTexture); gl.uniform1i(u.uCode, 0);
    gl.uniform1f(u.uCodeOn, this.codeOn && this.mode !== '2d' ? 1 : 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, layer.count);
    if (this.mode === 'city') {
      // Signs sit on or just off surfaces: test depth, don't write it, and pull them forward a touch.
      this.syncAtlas();
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -8);
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
