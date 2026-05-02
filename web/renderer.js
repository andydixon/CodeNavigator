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

// Shared by the tile and grid programs so both use one camera. The 3D branch returns a real
// clip-space w (the view depth), which keeps textures perspective-correct on roofs while
// producing exactly the same screen positions as project() in JS.
const PROJECT = `
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uZoom;
uniform float uMode;
uniform vec2 uOrbit;
uniform float uDistance;
vec4 projectWorld(vec3 world){
  if(uMode < .5){
    vec2 p = (world.xy - uCenter) * uZoom;
    return vec4(p.x * 2.0 / uViewport.x, -p.y * 2.0 / uViewport.y, min(world.z, 1.0) * .001, 1.0);
  }
  vec3 p = vec3((world.xy - uCenter) / 420.0, world.z / 170.0);
  float cy=cos(uOrbit.x), sy=sin(uOrbit.x), cp=cos(uOrbit.y), sp=sin(uOrbit.y);
  p = vec3(cy*p.x-sy*p.y, sy*p.x+cy*p.y, p.z);
  // Positive pitch places the camera above the ground plane.
  p = vec3(p.x, cp*p.y+sp*p.z, -sp*p.y+cp*p.z);
  float depth = max(.5, uDistance - p.y);
  float aspect = uViewport.x / uViewport.y;
  return vec4(p.x/aspect*2.7, (p.z-.35)*2.7, (depth-1.0)/10.0*depth, depth);
}`;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aUnit;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aColorHeight;
${PROJECT}
out vec4 vColor;
out vec3 vUnit;
out vec2 vWorld;
flat out int vFace;
void main(){
  float height = max(1.0, aColorHeight.a);
  vec3 world = vec3(aRect.xy + aUnit.xy * aRect.zw, aUnit.z * height);
  vColor = vec4(aColorHeight.rgb, 1.0);
  vUnit = aUnit;
  vWorld = world.xy;
  vFace = gl_VertexID / 6;
  gl_Position = projectWorld(world);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec3 vUnit;
in vec2 vWorld;
flat in int vFace;
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
  if(vFace > 0 && vFace < 5){
    // Walls: a fixed key light per side and a darker foot make buildings read as solids.
    float light = vFace == 1 ? .34 : vFace == 2 ? .2 : vFace == 3 ? .26 : .42;
    base = mix(top, vColor.rgb, light) * (.55 + .45 * vUnit.z);
    stroke = mix(stroke, base, .45);
  } else if(vFace == 0 && uCodeOn > .5){
    // Roofs sample the code overview, which is laid out exactly like the 1000x680 world.
    vec4 code = texture(uCode, vWorld / vec2(1000.0, 680.0));
    base = mix(base, code.rgb / max(code.a, .001), code.a * .92);
  }
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

export class LandscapeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.program = program(gl, VS, FS);
    this.gridProgram = program(gl, GRID_VS, GRID_FS);
    const grid = [];
    for (let x = -200; x <= 1200; x += 100) grid.push(x, -200, x, 900);
    for (let y = -200; y <= 900; y += 100) grid.push(-200, y, 1200, y);
    this.gridVao = gl.createVertexArray(); gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.gridCount = grid.length / 2;
    this.codeTexture = gl.createTexture(); this.codeOn = false;
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const vertices = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer();
    this.camera = { x: 500, y: 350, zoom: 1, yaw: -.1, pitch: .78, distance: 3.5 };
    this.mode = '2d'; this.count = 0;
    this.resize();
  }

  setData(items) {
    this.items = items;
    const packed = new Float32Array(items.length * 8);
    for (let i=0;i<items.length;i++) {
      const item=items[i], o=i*8;
      packed.set([item.x,item.y,item.w,item.h,item.color[0],item.color[1],item.color[2],item.height],o);
    }
    const gl=this.gl; gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.instances); gl.bufferData(gl.ARRAY_BUFFER,packed,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.FLOAT,false,32,0); gl.vertexAttribDivisor(1,1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,4,gl.FLOAT,false,32,16); gl.vertexAttribDivisor(2,1);
    this.count=items.length;
  }

  resize() {
    // Cache the CSS size once per frame: project() runs tens of thousands of times per frame,
    // and reading clientWidth there forces layout queries that dominated 3D frame time.
    this.width=Math.max(1,this.canvas.clientWidth); this.height=Math.max(1,this.canvas.clientHeight);
    const dpr=Math.min(devicePixelRatio||1,2), w=Math.max(1,Math.floor(this.width*dpr)), h=Math.max(1,Math.floor(this.height*dpr));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    this.dpr=dpr; this.gl.viewport(0,0,w,h);
  }

  // Uploads the code overview canvas as the roof texture; call again after it changes.
  setCodeTexture(source) {
    const gl=this.gl; gl.bindTexture(gl.TEXTURE_2D,this.codeTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true); // mipmaps of straight alpha get dark fringes around glyphs
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    if(this.anisotropy)gl.texParameterf(gl.TEXTURE_2D,this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  setCameraUniforms(u) {
    const gl=this.gl;
    gl.uniform2f(u.uCenter,this.camera.x,this.camera.y);
    gl.uniform2f(u.uViewport,this.width,this.height);
    gl.uniform1f(u.uZoom,this.camera.zoom);
    gl.uniform1f(u.uMode,this.mode==='3d'?1:0);
    gl.uniform2f(u.uOrbit,this.camera.yaw,this.camera.pitch);
    gl.uniform1f(u.uDistance,this.camera.distance);
  }

  render(alpha=1) {
    const gl=this.gl; this.resize();
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    const names=['uCenter','uViewport','uZoom','uMode','uOrbit','uDistance','uAlpha','uCode','uCodeOn'];
    this.uniforms||=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(this.program,n)]));
    this.gridUniforms||=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(this.gridProgram,n)]));
    if(this.mode==='3d'){
      // Ground grid first without writing depth; buildings then cover it where they stand.
      gl.useProgram(this.gridProgram); gl.bindVertexArray(this.gridVao); this.setCameraUniforms(this.gridUniforms);
      gl.depthMask(false); gl.drawArrays(gl.LINES,0,this.gridCount); gl.depthMask(true);
    }
    const u=this.uniforms;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); this.setCameraUniforms(u);
    gl.uniform1f(u.uAlpha,alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.codeTexture); gl.uniform1i(u.uCode,0);
    gl.uniform1f(u.uCodeOn,this.codeOn&&this.mode==='3d'?1:0);
    gl.drawArraysInstanced(gl.TRIANGLES,0,36,this.count);
  }

  // Per-frame trigonometry for project(); camera values only change between frames.
  basis() {
    const c=this.camera,b=this._basis||(this._basis={});
    if(b.yaw!==c.yaw||b.pitch!==c.pitch){b.yaw=c.yaw;b.pitch=c.pitch;b.cy=Math.cos(c.yaw);b.sy=Math.sin(c.yaw);b.cp=Math.cos(c.pitch);b.sp=Math.sin(c.pitch);}
    return b;
  }

  screenRect(item) {
    if(this.mode==='2d') return { x:(item.x-this.camera.x)*this.camera.zoom+this.width/2, y:(item.y-this.camera.y)*this.camera.zoom+this.height/2, w:item.w*this.camera.zoom, h:item.h*this.camera.zoom };
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const [x,y] of [[item.x,item.y],[item.x+item.w,item.y],[item.x,item.y+item.h],[item.x+item.w,item.y+item.h]]){
      const p=this.project([x,y,item.height]);
      if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y;
    }
    return {x:x0,y:y0,w:x1-x0,h:y1-y0};
  }

  project([x,y,z=0]) {
    const {cy,sy,cp,sp}=this.basis(),dx=(x-this.camera.x)/420,dy=(y-this.camera.y)/420,dz=z/170;
    const rx=cy*dx-sy*dy,ry=sy*dx+cy*dy,py=cp*ry+sp*dz,pz=-sp*ry+cp*dz;
    const depth=Math.max(.5,this.camera.distance-py),w=this.width,h=this.height;
    return {x:w/2+(rx/(depth*w/h)*2.7)*w/2,y:h/2-((pz-.35)/depth*2.7)*h/2,depth};
  }

  worldAt(clientX,clientY) {
    return {x:this.camera.x+(clientX-this.width/2)/this.camera.zoom,y:this.camera.y+(clientY-this.height/2)/this.camera.zoom};
  }
}
