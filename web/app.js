import { LandscapeRenderer, KIND } from './renderer.js';
import { layoutCity, squarifiedLayout, spatialIndex, pickRay, stepCamera, collide, blockAt, groundHit, flatQuad, wallSigns, folderBlades, folderLabel, facadeQuad, heading, tourStops, encodePlace, decodePlace, joystick, buildNavGrid, routesFrom, spawnWanderers, stepWanderers, alertsByPath, burns, tapeQuads, cityWalls, posterQuads, seededRandom, WALL, ROUTE_KIND, enterBuilding, MOVE } from './city.js';
import { LabelAtlas, PosterAtlas } from './labels.js';
import { apiFetch, progressEvents } from './api.mjs';

const configuredBackend=window.CODENAVIGATOR_CONFIG?.backendUrl?.trim()||'';
const API_BASE=configuredBackend.replace(/\/+$/,'');
const apiUrl=path=>`${API_BASE}${path}`;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
document.addEventListener('pointerdown',()=>{document.documentElement.dataset.inputMethod='pointer';},true);
document.addEventListener('keydown',()=>{document.documentElement.dataset.inputMethod='keyboard';},true);
const glCanvas = $('#glCanvas');
const overlay = $('#overlayCanvas');
const overlayCtx = overlay.getContext('2d');
const viewport = $('#viewport');
const MAX_2D_ZOOM=260;
const MIN_3D_DISTANCE=.52;
let renderer;
try { renderer = new LandscapeRenderer(glCanvas); }
catch (error) { $('#emptyState').hidden=false; $('#emptyState strong').textContent='WebGL2 is unavailable'; $('#emptyState span').textContent=error.message; throw error; }

const palettes = [
  { application:'#1fbf8c', library:'#28aa8b', test:'#c7a62e', generated:'#cc7741', vendor:'#4e83bc', platform:'#d05492', docs:'#8d9561', unknown:'#65706a' },
  { application:'#48a9e6', library:'#7874db', test:'#e6a04b', generated:'#d6627c', vendor:'#45b39d', platform:'#b781d4', docs:'#9ca35c', unknown:'#697277' },
  { application:'#87b95d', library:'#39a5a0', test:'#e2bf52', generated:'#e37d52', vendor:'#527ac2', platform:'#c76699', docs:'#a4a4a4', unknown:'#6b706d' },
];
let paletteIndex=0;
let files=[];
let edges=[];
let layoutItems=[];
let directoryRects=[];
let fileById=new Map();
let layoutById=new Map();
let referenceDegree=new Map();
let edgesByFile=new Map();
let sceneStats={definitions:0,totalLines:0,known:0,inferred:0,layers:new Map()};
let spatialGrid=new Map();
let visibleScreenItems=[];
let overviewCanvas=null,overviewContext=null,overviewIndex=0,overviewUploaded=-1,overviewUploadedAt=0;
let codeTextureBytes=0;
const codeTextureLru=new Map(),codeTextureBudget=192*1024*1024,overviewScale=3;
let selected=null;
let history=[];
let searchHits=[];
let expandedCoverageLayer=null;
let coverageActiveIndex=-1;
let cameraAnimation=null;
let cityModel=null,cityEntries=[],cityIndex=null,collisionIndex=null,cityWallBoxes=[],cityFitted=false,cityDistricts=[],cityFolders=[],navGrid=null,cityRoutes=[],wanderers=[],showResidents=true;
let currentSnapshot=null;
let currentName='';
let currentMetric='lines';
let showCode=true;
let showLegend=false;
let dirty=true;
let pointer={down:false,x:0,y:0,startX:0,startY:0,action:'orbit',id:null};
let lastFrame=performance.now(), frameSamples=[];

const layerLabels = { application:'Application',library:'Libraries',test:'Tests',generated:'Generated',vendor:'Vendor',platform:'Platform',docs:'Documentation',unknown:'Other' };

function toRgb(hex){const value=parseInt(hex.slice(1),16);return[((value>>16)&255)/255,((value>>8)&255)/255,(value&255)/255];}
function fileWeight(file){
  if(currentMetric==='references'){
    const degree=referenceDegree.get(file.id)||0;
    return Math.max(1,degree*55+(file.symbolCount??file.symbols?.length??0)*7);
  }
  return Math.max(1,file.lines);
}

function makeTree(list){
  // Repositories frequently keep source files at their root. Root participates
  // in the same layout contract as every child directory.
  const root={name:currentName,path:'',children:new Map(),files:[],weight:0,depth:0};
  for(const file of list){
    const parts=file.path.split('/'), filename=parts.pop(); let node=root;
    for(const part of parts){
      if(!node.children.has(part)) node.children.set(part,{name:part,path:node.path?`${node.path}/${part}`:part,children:new Map(),files:[],weight:0,depth:node.depth+1});
      node=node.children.get(part);
    }
    node.files.push({name:filename,file,weight:fileWeight(file)});
  }
  function weigh(node){
    let weight=0;const layers=new Map();
    for(const item of node.files||[]){weight+=item.weight;const layer=item.file.layer in layerLabels?item.file.layer:'unknown';layers.set(layer,(layers.get(layer)||0)+item.weight);}
    for(const child of node.children.values()){const childWeight=weigh(child);weight+=childWeight;layers.set(child.layer,(layers.get(child.layer)||0)+childWeight);}
    node.weight=weight;node.layer=[...layers.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'unknown';return weight;
  }
  weigh(root); return root;
}

function computeLayout(){
  const root=makeTree(files); layoutItems=[];directoryRects=[];
  function visit(node,x,y,w,h,depth){
    directoryRects.push({node,x,y,w,h,depth});
    const pad=Math.min(3.2,1.2+depth*.35,w*.07,h*.07),header=Math.min(8,Math.max(0,h*.05)),ix=x+pad,iy=y+pad+header,iw=Math.max(.01,w-pad*2),ih=Math.max(.01,h-pad*2-header);
    const values=[...node.children.values(),...(node.files||[])],total=values.reduce((sum,value)=>sum+value.weight,0);
    // A file should be compared with its siblings, not visually erased by the
    // aggregate weight of a huge neighboring subtree. The local floor keeps
    // every entry readable while leaving at least 87.5% of each region fully
    // proportional to the selected metric.
    const floor=total/Math.max(1,values.length*8);
    const entries=values.map(value=>({value,weight:Math.max(value.weight,floor)})).sort((a,b)=>b.weight-a.weight);
    squarifiedLayout(entries,ix,iy,iw,ih,depth,(wrapped,rx,ry,rw,rh)=>{
      const entry=wrapped.value;
      if(entry.file){
        const inset=Math.min(1,Math.min(rw,rh)*.08),layer=entry.file.layer in palettes[paletteIndex]?entry.file.layer:'unknown';
        layoutItems.push({...entry.file,x:rx+inset,y:ry+inset,w:Math.max(.1,rw-inset*2),h:Math.max(.1,rh-inset*2),color:toRgb(palettes[paletteIndex][layer]),height:4+Math.log2(entry.file.lines+entry.file.complexity*5)*5});
      }else visit(entry,rx,ry,rw,rh,depth+1);
    });
  }
  visit(root,0,0,1000,680,0);
  layoutById=new Map(layoutItems.map(item=>[item.id,item]));buildSpatialGrid();resetCodeCaches();
  renderer.setData(layoutItems);computeCity();renderer.setSelected(selected?.id||0);dirty=true;
}

// The city shares files, colours and the code overview atlas with the landscape but has its own
// street layout in metres. Each layout item keeps its building as item.city.
function computeCity(){
  cityModel=layoutCity(files,currentName);
  const instances=[{x:-80,y:-80,w:cityModel.width+160,h:cityModel.height+160,height:.02,color:[0,0,0],kind:KIND.ground}];
  for(const block of cityModel.blocks)if(block.depth>0)instances.push({x:block.x,y:block.y,w:block.w,h:block.h,height:.1+.06*Math.min(block.depth,4),color:[.95,.9,.78],kind:KIND.block});
  cityEntries=[];
  for(const item of layoutItems){
    const building=cityModel.buildings.get(item.id);if(!building)continue;
    item.city={...building,file:item};cityEntries.push(item.city);
    // More definitions light more windows.
    const symbols=item.symbolCount??item.symbols?.length??0;
    instances.push({...building,color:item.color,atlas:[item.x/1000,item.y/680,item.w/1000,item.h/680],kind:KIND.building,id:item.id,lit:Math.min(.85,.06+Math.sqrt(symbols)/9)});
  }
  cityIndex=spatialIndex(cityEntries);
  // The wall keeps walkers, residents and routes inside; it's in the collision index but not the pick index.
  cityWallBoxes=cityWalls(cityModel);
  collisionIndex=spatialIndex([...cityEntries,...cityWallBoxes]);
  navGrid=buildNavGrid([...cityEntries,...cityWallBoxes],cityModel.blocks,cityModel);
  updateFires();
  spawnResidents();
  // Each folder's own buildings (not its subfolders'), for street-corner signs.
  const byDirectory=new Map();
  for(const b of cityEntries){const list=byDirectory.get(b.file.directory||'');if(list)list.push(b);else byDirectory.set(b.file.directory||'',[b]);}
  cityFolders=cityModel.blocks.map(block=>({block,buildings:byDirectory.get(block.node.path)||[],label:folderLabel(block.node.path,currentName)})).filter(folder=>folder.buildings.length);
  const tally=node=>{let files=node.files.length,lines=node.files.reduce((n,f)=>n+(f.lines||0),0);for(const child of node.children.values()){const t=tally(child);files+=t.files;lines+=t.lines;}return{files,lines};};
  cityDistricts=cityModel.blocks.filter(block=>block.depth===1).map(block=>({block,...tally(block.node),top:Math.max(10,...[...cityIndex.near(block.x+block.w/2,block.y+block.h/2,Math.hypot(block.w,block.h)/2)].filter(b=>b.x>=block.x&&b.x+b.w<=block.x+block.w&&b.y>=block.y&&b.y+b.h<=block.y+block.h).map(b=>b.height))}));
  for(const wall of cityWallBoxes)instances.push({...wall,color:[.78,.95,.21],kind:KIND.wall});
  pastePosters();
  renderer.setCity(instances,{width:cityModel.width,height:cityModel.height});
  buildMinimap();updateCityHud();updateTrails();updateRoutes();updateBeacons();signState.key='';facadeState={entry:null,texture:null};renderer.setFacade(null);
}

// ---- City navigation: helicopter, walk and fly cameras, HUD, crosshair and minimap ----
const heldKeys=new Set(),MOVE_KEYS=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','KeyC']);
let minimapBase=null,cityTargetEntry=null,lastAddress='';
const COARSE=matchMedia('(pointer: coarse)').matches;
const CITY_HELP=COARSE?{
  heli:'<b>Drag</b> orbit · <b>Pinch</b> zoom · <b>Double-tap</b> a street to walk',
  walk:'<b>Left thumb</b> move · <b>Right thumb</b> look · <b>Tap</b> a building to inspect',
  fly:'<b>Left thumb</b> fly · <b>Right thumb</b> look · <b>Pinch</b> climb',
}:{
  heli:'<b>Drag</b> orbit · <b>Shift+drag</b> pan · <b>Scroll</b> zoom · <b>Double-click</b> a street to walk',
  walk:'<b>Click</b> to look · <b>WASD</b> move · <b>Shift</b> run · <b>E</b> inspect · <b>Esc</b> release mouse',
  fly:'<b>Click</b> to look · <b>WASD</b> fly · <b>Space</b>/<b>C</b> up/down · <b>Shift</b> fast · <b>E</b> inspect',
};

function setCityView(view,at){
  const c=renderer.city;if(!cityModel||(view===c.view&&!at))return;
  cancelCameraAnimation();
  const {eye,forward}=renderer.cityPose();
  if(view==='heli'){
    // Rise out of the street, keeping the heading.
    Object.assign(c,{view,x:c.ex,y:c.ey,yaw:c.lookYaw,pitch:.62,distance:Math.max(3,c.ez)});
    animateCameraTo({distance:Math.max(180,c.ez*2)},c,1000);
    if(document.pointerLockElement)document.exitPointerLock();
  }else{
    const fromHeli=c.view==='heli';
    c.view=view;
    if(fromHeli||at){
      if(fromHeli)Object.assign(c,{ex:eye[0],ey:eye[1],ez:eye[2],lookYaw:Math.atan2(-forward[0],-forward[1]),lookPitch:Math.asin(Math.max(-1,Math.min(1,forward[2])))});
      // With routes showing, walking starts at the selected building's door facing down the first route.
      // Every route starts (imports) or ends (dependents) at the selected building; walk out from its door.
      const first=cityRoutes[0],route=!at&&view==='walk'&&first?.points.length>2?(first.outgoing?first.points:[...first.points].reverse()).slice(1):null; // skip the point inside the building
      const target=at||route?.[0]||[c.x,c.y],spot=collide(target[0],target[1],MOVE.radius*3,collisionIndex);
      const facing=route?Math.atan2(-(route[1][0]-route[0][0]),-(route[1][1]-route[0][1])):null;
      animateCameraTo({ex:spot.x,ey:spot.y,ez:view==='walk'?MOVE.eyeHeight:Math.min(Math.max(60,c.ez*.5),260),lookYaw:facing??(view==='walk'?openHeading(spot.x,spot.y,c.lookYaw):c.lookYaw),lookPitch:view==='walk'?(route?-.18:0):-.3},c,1100);
    }else if(view==='walk'){
      const spot=collide(c.ex,c.ey,MOVE.radius*3,collisionIndex);
      animateCameraTo({ex:spot.x,ey:spot.y,ez:MOVE.eyeHeight,lookPitch:0},c,800);
    }
  }
  updateCityHud();dirty=true;
}

// Of eight headings, the one with the longest clear view at eye level, preferring the current one.
function openHeading(x,y,current){
  let best=current,clear=-1;
  for(let i=0;i<8;i++){
    const yaw=current+i*Math.PI/4,dir=[-Math.sin(yaw),-Math.cos(yaw),0];
    const distance=Math.min(pickRay([x,y,MOVE.eyeHeight],dir,cityEntries,400)?.distance??400,400);
    if(distance>clear+5){clear=distance;best=yaw;}
  }
  return best;
}

function stepCity(seconds){
  const down=code=>heldKeys.has(code)?1:0;
  stepCamera(renderer.city,{
    forward:Math.max(-1,Math.min(1,down('KeyW')+down('ArrowUp')-down('KeyS')-down('ArrowDown')+touchMove.forward)),
    right:Math.max(-1,Math.min(1,down('KeyD')+down('ArrowRight')-down('KeyA')-down('ArrowLeft')+touchMove.right)),
    up:down('Space')-down('KeyC'),
    run:heldKeys.has('ShiftLeft')||heldKeys.has('ShiftRight'),
  },seconds,collisionIndex,{width:cityModel.width,height:cityModel.height,edge:WALL.margin-MOVE.radius});
  dirty=true;
}

function lookCity(dx,dy){
  const c=renderer.city;
  c.lookYaw-=dx*.0022;c.lookPitch=Math.max(-1.45,Math.min(1.45,c.lookPitch-dy*.0022));dirty=true;
}

function handleCityKey(event){
  const c=renderer.city;
  if(event.code==='KeyT'){event.preventDefault();tour?endTour():startTour();return true;}
  if(tour)endTour();
  if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))return false;
  const views={Digit1:'heli',Digit2:'walk',Digit3:'fly'};
  if(views[event.code]){event.preventDefault();setCityView(views[event.code]);return true;}
  if(event.code==='KeyE'){event.preventDefault();inspectCityTarget(true);return true;}
  if(c.view!=='heli'&&MOVE_KEYS.has(event.code)){event.preventDefault();cancelCameraAnimation();heldKeys.add(event.code);dirty=true;return true;}
  return false;
}
document.addEventListener('keyup',event=>heldKeys.delete(event.code));
window.addEventListener('blur',()=>heldKeys.clear());
document.addEventListener('mousemove',event=>{if(document.pointerLockElement===glCanvas&&renderer.mode==='city')lookCity(event.movementX,event.movementY);});
document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement)heldKeys.clear();updateCityHud();});

function inspectCityTarget(openPanel){
  if(!cityTargetEntry)return;
  selectFile(cityTargetEntry.file);
  if(openPanel){switchTab('inspector');if(document.pointerLockElement)document.exitPointerLock();}
}

function updateCityHud(){
  const inCity=renderer.mode==='city'&&!!cityModel,view=renderer.city.view;
  $('#cityHud').hidden=!inCity;$('#minimap').hidden=!inCity;$('#cityAddress').hidden=!inCity;
  $('#crosshair').hidden=!inCity||view==='heli';
  if(!inCity||view==='heli'){$('#cityTarget').hidden=true;cityTargetEntry=null;}
  $$('[data-city-view]').forEach(button=>button.classList.toggle('active',button.dataset.cityView===view));
  $('#cityHelp').innerHTML=CITY_HELP[view];
  if(!inCity&&document.pointerLockElement)document.exitPointerLock();
}
$$('[data-city-view]').forEach(button=>button.addEventListener('click',()=>{button.blur();endTour();setCityView(button.dataset.cityView);}));

// ---- Touch: left-thumb joystick while walking or flying, drag to look, pinch to zoom ----
const touches=new Map();let joy=null,pinch=null,touchMove={forward:0,right:0};
function startTouch(event){
  touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(touches.size===2){
    pointer.down=false;endJoystick();
    const [a,b]=[...touches.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y)};
    viewport.setPointerCapture(event.pointerId);event.preventDefault();return true;
  }
  const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
  if(renderer.mode==='city'&&renderer.city.view!=='heli'&&x<rect.width/2){
    joy={id:event.pointerId,x0:event.clientX,y0:event.clientY};
    const stick=$('#joystick');stick.hidden=false;stick.style.left=`${x}px`;stick.style.top=`${y}px`;stick.firstElementChild.style.transform='';
    viewport.setPointerCapture(event.pointerId);event.preventDefault();return true;
  }
  return false;
}
function moveTouch(event){
  if(!touches.has(event.pointerId))return false;
  touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(pinch&&touches.size>=2){
    const [a,b]=[...touches.values()],distance=Math.hypot(a.x-b.x,a.y-b.y),ratio=distance/Math.max(1,pinch.distance);pinch.distance=distance;
    const amount=-Math.log(ratio||1),c=renderer.city;
    if(renderer.mode==='city'){if(c.view==='heli')dollyCity(amount);else if(c.view==='fly')c.ez=Math.max(MOVE.eyeHeight,Math.min(3000,c.ez-amount*120));}
    else if(renderer.mode==='3d')dolly3d(amount);
    else renderer.camera.zoom=Math.max(.25,Math.min(MAX_2D_ZOOM,renderer.camera.zoom*ratio));
    dirty=true;return true;
  }
  if(joy&&event.pointerId===joy.id){
    const dx=event.clientX-joy.x0,dy=event.clientY-joy.y0,length=Math.min(56,Math.hypot(dx,dy)),angle=Math.atan2(dy,dx);
    touchMove=joystick(dx,dy);
    $('#joystick').firstElementChild.style.transform=`translate(${Math.cos(angle)*length}px,${Math.sin(angle)*length}px)`;
    dirty=true;return true;
  }
  return false;
}
function endTouch(event){
  touches.delete(event.pointerId);
  if(joy?.id===event.pointerId)endJoystick();
  if(touches.size<2)pinch=null;
}
function endJoystick(){joy=null;touchMove={forward:0,right:0};$('#joystick').hidden=true;}
viewport.addEventListener('pointercancel',event=>{if(event.pointerType==='touch')endTouch(event);});

// ---- Guided tour: a helicopter flight over the largest districts ----
let tour=null;
function startTour(){
  if(!cityModel||renderer.mode!=='city')return;
  const stops=tourStops(cityDistricts);if(!stops.length)return;
  if(renderer.city.view!=='heli')setCityView('heli');
  tour={stops,index:-1,dwellUntil:0};$('#tourButton').classList.add('active');nextTourStop();
}
function nextTourStop(){
  tour.index++;
  const caption=$('#tourCaption');
  if(tour.index>=tour.stops.length){
    const size=Math.max(cityModel.width,cityModel.height);
    animateCameraTo({x:cityModel.width/2,y:cityModel.height/2,distance:size*1.05,pitch:.72,yaw:renderer.city.yaw+.6},renderer.city,3000);
    endTour();return;
  }
  const {district,pose}=tour.stops[tour.index];
  animateCameraTo({...pose,yaw:renderer.city.yaw+((pose.yaw-renderer.city.yaw)%(Math.PI*2))},renderer.city,2600);
  tour.dwellUntil=performance.now()+2600+3400;
  caption.hidden=false;
  caption.innerHTML=`<small>${tour.index+1} / ${tour.stops.length}</small><strong>${escapeHtml(district.block.node.name)}</strong><span>${format(district.files)} files · ${format(district.lines)} lines</span>`;
}
function advanceTour(now,seconds){
  if(!cameraAnimation&&now<tour.dwellUntil){renderer.city.yaw+=seconds*.1;dirty=true;}
  else if(now>=tour.dwellUntil)nextTourStop();
}
function endTour(){if(!tour)return;tour=null;$('#tourCaption').hidden=true;$('#tourButton').classList.remove('active');}
$('#tourButton').addEventListener('click',event=>{event.currentTarget.blur();tour?endTour():startTour();});

// ---- Shareable places: repository, view, camera and file in the URL fragment ----
let currentRepoUrl='';
$('#shareButton').addEventListener('click',async event=>{
  const button=event.currentTarget,labelElement=button.querySelector('.label'),label=labelElement.textContent;button.blur();
  const flash=text=>{labelElement.textContent=text;button.classList.add('done');setTimeout(()=>{labelElement.textContent=label;button.classList.remove('done');},1800);};
  if(!currentRepoUrl){flash('Needs a GitHub repo');return;}
  const hash=encodePlace({repo:currentRepoUrl,view:renderer.mode,camera:renderer.city,file:selected?.path});
  window.history.replaceState(null,'',hash);
  try{await navigator.clipboard.writeText(location.href);flash('Link copied');}catch{flash('Link in address bar');}
});
// ---- Opening shared links: #repo=…&view=…&cam=…&file=… ----
const repoName=url=>url.replace(/^https:\/\/github\.com\//,'');
function pendingPlace(){try{return JSON.parse(sessionStorage.getItem('codenav.pendingPlace')||'null');}catch{return null;}}
function clearPendingPlace(){try{sessionStorage.removeItem('codenav.pendingPlace');}catch{}}
const sameRepo=(a,b)=>!!a&&!!b&&a.replace(/\/+$/,'').replace(/\.git$/,'').toLowerCase()===b.replace(/\/+$/,'').replace(/\.git$/,'').toLowerCase();
function openPlaceFromHash(){
  const place=decodePlace(location.hash);if(!place)return;
  // Already open in this tab: just go there.
  if(sameRepo(place.repo,currentRepoUrl)&&files.length){goToPlace(place);return;}
  try{sessionStorage.setItem('codenav.pendingPlace',JSON.stringify(place));}catch{}
  if(dialog.open)dialog.close();
  $('#githubInput').value=place.repo;
  const where=place.file?place.file.split('/').pop():'the shared spot';
  pullGithub(place.repo,'Opening a shared link',`${repoName(place.repo)} isn't loaded here yet, so it's being pulled from GitHub. You'll be taken to ${where} as soon as it's built.`);
}
window.addEventListener('hashchange',openPlaceFromHash);

function applyPendingPlace(){
  const place=pendingPlace();
  if(!place||!sameRepo(place.repo,currentRepoUrl))return;
  clearPendingPlace();
  goToPlace(place);
}

// Switch view, select the file and fly the camera to the linked position.
function goToPlace(place){
  $(`[data-view="${place.view}"]`)?.click();
  const file=place.file&&files.find(candidate=>candidate.path===place.file);
  if(file)selectFile(file);
  const target=place.view==='city'&&place.camera;
  if(!target){if(file)focusFile(file);dirty=true;return;}
  const c=renderer.city,{view,...pose}=target;
  cancelCameraAnimation();endTour();
  if(view!=='heli'){
    // Start ground views from where the helicopter is looking, so the flight has somewhere to come from.
    const {eye,forward}=renderer.cityPose();
    Object.assign(c,{ex:eye[0],ey:eye[1],ez:eye[2],lookYaw:Math.atan2(-forward[0],-forward[1]),lookPitch:Math.asin(Math.max(-1,Math.min(1,forward[2])))});
  }
  c.view=view;updateCityHud();
  animateCameraTo(pose,c,1800);
}

// A shared link to a repository this visitor can't clone: most likely private, with GitHub access
// that has expired or was never granted on this device. The pending place is kept, so signing in
// carries straight on to the shared spot.
function showPrivateLinkWarning(place,authRequired){
  showError('',authRequired);
  $('#progressTitle').textContent='Private repository';
  $('#progressMessage').textContent=authRequired==='install'
    ?`This link points to ${repoName(place.repo)}, a private repository your GitHub account can't open here. Grant access to it, then open the link again.`
    :`This link points to ${repoName(place.repo)}, a private repository, and your GitHub access has expired (or you haven't signed in on this device). Sign in with GitHub to carry on to the shared spot.`;
  $('#progressFill').style.background='var(--yellow)';
  $('#progressCount').textContent='';
}

// Crosshair target, street address and minimap, refreshed with each city frame.
function updateCityReadouts(){
  const c=renderer.city,{eye,forward}=renderer.cityPose();
  if(c.view!=='heli'){
    const hit=pickRay(eye,forward,cityEntries,90),entry=hit?.entry||null;
    if(entry!==cityTargetEntry){
      cityTargetEntry=entry;const target=$('#cityTarget');target.hidden=!entry;
      if(entry)target.innerHTML=`${escapeHtml(entry.file.name)}<kbd>E</kbd><small>${escapeHtml(entry.file.path)} · ${format(entry.file.lines)} lines</small>`;
    }
  }
  const [px,py]=c.view==='heli'?[c.x,c.y]:[c.ex,c.ey],block=blockAt(cityModel.blocks,px,py);
  const address=[currentName,...(block?.node.path.split('/')||[])].join(' / ');
  if(address!==lastAddress){lastAddress=address;$('#cityAddress').textContent=address;}
  drawMinimap();
}

const MINIMAP={width:220,height:150,pad:8};
function minimapTransform(){
  // Leave room for the city wall around the edge.
  const scale=Math.min((MINIMAP.width-MINIMAP.pad*2)/(cityModel.width+WALL.margin*2),(MINIMAP.height-MINIMAP.pad*2)/(cityModel.height+WALL.margin*2));
  return {scale,ox:(MINIMAP.width-cityModel.width*scale)/2,oy:(MINIMAP.height-cityModel.height*scale)/2};
}
function buildMinimap(){
  const dpr=2,canvas=document.createElement('canvas');canvas.width=MINIMAP.width*dpr;canvas.height=MINIMAP.height*dpr;
  const ctx=canvas.getContext('2d'),{scale,ox,oy}=minimapTransform();ctx.scale(dpr,dpr);
  ctx.strokeStyle='rgba(200,241,53,.7)';ctx.lineWidth=1.5;ctx.strokeRect(ox-WALL.margin*scale,oy-WALL.margin*scale,(cityModel.width+WALL.margin*2)*scale,(cityModel.height+WALL.margin*2)*scale);
  ctx.fillStyle='rgba(243,236,220,.06)';
  for(const block of cityModel.blocks)if(block.depth===1)ctx.fillRect(ox+block.x*scale,oy+block.y*scale,block.w*scale,block.h*scale);
  for(const item of layoutItems){const b=item.city;if(!b||!fileAlerts.has(item.path))continue;ctx.fillStyle='#ff4d3d';ctx.beginPath();ctx.arc(ox+(b.x+b.w/2)*scale,oy+(b.y+b.h/2)*scale,2.6,0,Math.PI*2);ctx.fill();}
  for(const item of layoutItems){const b=item.city;if(!b)continue;ctx.fillStyle=`rgba(${item.color.map(v=>Math.round(v*255)).join(',')},.85)`;ctx.fillRect(ox+b.x*scale,oy+b.y*scale,Math.max(.6,b.w*scale),Math.max(.6,b.h*scale));}
  minimapBase=canvas;
}
function drawMinimap(){
  const canvas=$('#minimap');if(canvas.hidden||!minimapBase)return;
  const dpr=2;if(canvas.width!==MINIMAP.width*dpr){canvas.width=MINIMAP.width*dpr;canvas.height=MINIMAP.height*dpr;}
  const ctx=canvas.getContext('2d'),c=renderer.city,{scale,ox,oy}=minimapTransform();
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(minimapBase,0,0);ctx.setTransform(dpr,0,0,dpr,0,0);
  const heli=c.view==='heli',x=ox+(heli?c.x:c.ex)*scale,y=oy+(heli?c.y:c.ey)*scale,yaw=heli?c.yaw:c.lookYaw;
  if(selected?.id){const b=layoutById.get(selected.id)?.city;if(b){ctx.strokeStyle='#fff08a';ctx.lineWidth=1.5;ctx.strokeRect(ox+b.x*scale-1.5,oy+b.y*scale-1.5,b.w*scale+3,b.h*scale+3);}}
  for(const route of cityRoutes){
    const dependent=route.kind===ROUTE_KIND.dependent;
    ctx.strokeStyle=dependent?'rgba(255,77,199,.95)':route.kind===ROUTE_KIND.knownImport?'rgba(54,211,194,.9)':'rgba(247,189,77,.9)';
    ctx.lineWidth=1.4;ctx.setLineDash(dependent?[3,2]:[]);ctx.lineDashOffset=dependent?-(performance.now()/120)%5:0;ctx.beginPath();
    route.points.forEach(([px,py],i)=>i?ctx.lineTo(ox+px*scale,oy+py*scale):ctx.moveTo(ox+px*scale,oy+py*scale));ctx.stroke();
  }
  ctx.setLineDash([]);
  // Heading arrow: yaw 0 points north (up the map).
  ctx.save();ctx.translate(x,y);ctx.rotate(-yaw);
  ctx.fillStyle='rgba(54,211,194,.18)';ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,26,-Math.PI/2-.5,-Math.PI/2+.5);ctx.closePath();ctx.fill();
  ctx.fillStyle='#fff';ctx.strokeStyle='#07090d';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,-7);ctx.lineTo(5,5);ctx.lineTo(0,2.5);ctx.lineTo(-5,5);ctx.closePath();ctx.stroke();ctx.fill();
  ctx.restore();
}
$('#minimap').addEventListener('pointerdown',event=>{
  event.stopPropagation();if(!cityModel)return;
  const rect=event.currentTarget.getBoundingClientRect(),{scale,ox,oy}=minimapTransform();
  const x=(event.clientX-rect.left-ox)/scale,y=(event.clientY-rect.top-oy)/scale,c=renderer.city;
  if(c.view==='heli')animateCameraTo({x,y},c,700);
  else{const spot=c.view==='walk'?collide(x,y,MOVE.radius*3,collisionIndex):{x,y};animateCameraTo({ex:spot.x,ey:spot.y},c,700);}
});

function fitCity(){
  if(!cityModel)return;
  Object.assign(renderer.city,{view:'heli',x:cityModel.width/2,y:cityModel.height/2,yaw:-.35,pitch:.72,distance:Math.max(cityModel.width,cityModel.height)*1.05});
  cityFitted=true;dirty=true;
}

function resetCodeCaches(){
  overviewUploaded=-1;overviewCanvas=document.createElement('canvas');overviewCanvas.width=1000*overviewScale;overviewCanvas.height=680*overviewScale;overviewContext=overviewCanvas.getContext('2d',{alpha:true});overviewIndex=0;codeTextureBytes=0;codeTextureLru.clear();
}

const spatialCell=50;
function buildSpatialGrid(){
  spatialGrid=new Map();
  for(const item of layoutItems){
    const x0=Math.floor(item.x/spatialCell),x1=Math.floor((item.x+item.w)/spatialCell),y0=Math.floor(item.y/spatialCell),y1=Math.floor((item.y+item.h)/spatialCell);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const key=`${x}:${y}`,cell=spatialGrid.get(key);if(cell)cell.push(item);else spatialGrid.set(key,[item]);}
  }
}
function visibleLayout(w,h){
  let candidates=layoutItems;
  if(renderer.mode==='2d'&&renderer.camera.zoom>1){
    const halfW=w/(2*renderer.camera.zoom),halfH=h/(2*renderer.camera.zoom),x0=Math.floor((renderer.camera.x-halfW)/spatialCell),x1=Math.floor((renderer.camera.x+halfW)/spatialCell),y0=Math.floor((renderer.camera.y-halfH)/spatialCell),y1=Math.floor((renderer.camera.y+halfH)/spatialCell),seen=new Set(),near=[];
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)for(const item of spatialGrid.get(`${x}:${y}`)||[])if(!seen.has(item.id)){seen.add(item.id);near.push(item);}
    candidates=near;
  }
  const visible=[];
  for(const item of candidates){const rect=renderer.screenRect(item);if(rect.x>w||rect.y>h||rect.x+rect.w<0||rect.y+rect.h<0)continue;visible.push({item,rect});}
  return visible;
}

function applySnapshot(snapshot){
  sourceQueue.length=0;queuedSources.clear();
  files=snapshot.files||[];for(const file of files)file.symbols||=[];edges=snapshot.edges||[];currentName=snapshot.name||'codebase';currentSnapshot=snapshot.id||null;selected=null;history=[];searchHits=[];expandedCoverageLayer=null;coverageActiveIndex=-1;cameraAnimation=null;
  fileById=new Map(files.map(file=>[file.id,file]));referenceDegree=new Map();edgesByFile=new Map();let known=0,inferred=0;for(const edge of edges){referenceDegree.set(edge.from,(referenceDegree.get(edge.from)||0)+1);referenceDegree.set(edge.to,(referenceDegree.get(edge.to)||0)+1);for(const id of [edge.from,edge.to]){const list=edgesByFile.get(id);if(list)list.push(edge);else edgesByFile.set(id,[edge]);}if(edge.confidence==='known')known++;else inferred++;}
  const layers=new Map();for(const file of files){const layer=file.layer in layerLabels?file.layer:'unknown';layers.set(layer,(layers.get(layer)||0)+1);}sceneStats={definitions:snapshot.definitions??files.reduce((n,file)=>n+(file.symbolCount||0),0),totalLines:snapshot.totalLines??files.reduce((n,file)=>n+file.lines,0),known,inferred,layers};
  computeLayout();fitScene();fitCity();updateStats(snapshot);renderInspector();renderResults([]);renderHistory();
  $('#breadcrumbText').textContent=currentName;$('#emptyState').hidden=files.length>0;$('#welcome').hidden=true;
  currentRepoUrl=snapshot.source==='github'?lastGithubUrl.replace(/\/+$/,'').replace(/\.git$/,''):'';
  endTour();applyPendingPlace();loadAlerts();
}

function fitScene(){
  cameraAnimation=null;
  if(renderer.mode==='city'){fitCity();return;}
  renderer.camera.x=500;renderer.camera.y=340;
  renderer.camera.zoom=Math.min((viewport.clientWidth-24)/1000,(viewport.clientHeight-24)/680);
  renderer.camera.distance=3.5;renderer.camera.yaw=-.12;renderer.camera.pitch=.76;dirty=true;
}

function pan3d(dx,dy){
  const {yaw,distance}=renderer.camera;
  const scale=Math.max(.18,distance*.29);
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  // Keep the grabbed ground point beneath the pointer in screen space.
  renderer.camera.x+=(-dx*cy-dy*sy)*scale;
  renderer.camera.y+=( dx*sy-dy*cy)*scale;
}

function dragCity(dx,dy,action){
  const c=renderer.city;
  if(action==='pan'){const scale=c.distance*.0016,cy=Math.cos(c.yaw),sy=Math.sin(c.yaw);c.x+=(-dx*cy-dy*sy)*scale;c.y+=(dx*sy-dy*cy)*scale;}
  else{c.yaw-=dx*.007;c.pitch=Math.max(.08,Math.min(1.5,c.pitch+dy*.006));}
}
function dollyCity(amount){
  const c=renderer.city,size=Math.max(cityModel?.width||1000,cityModel?.height||1000);
  if(c.view==='heli')c.distance=Math.max(12,Math.min(size*3,c.distance*Math.exp(amount)));
}

function dolly3d(amount){
  renderer.camera.distance=Math.max(MIN_3D_DISTANCE,Math.min(14,renderer.camera.distance*Math.exp(amount)));
}

function updateStats(snapshot={}){
  const definitions=snapshot.definitions??files.reduce((n,file)=>n+file.symbols.length,0);
  const references=snapshot.references??edges.length;
  $('#headlineStats').textContent=`${format(definitions)} definitions · ${format(references)} references`;
  $('#fileStats').textContent=`${format(files.length)} files · ${format(snapshot.totalLines??files.reduce((n,f)=>n+f.lines,0))} lines`;
}

function format(value){return Number(value||0).toLocaleString();}
function escapeHtml(value=''){return String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));}

const syntaxPalette={plain:'#b6bfd0',comment:'#5c667a',string:'#8fd694',number:'#f5a97f',keyword:'#c69cff',type:'#6ec6ff',function:'#7aa7ff',property:'#5fd3c6',operator:'#8f9ab0',constant:'#ff8fa3',tag:'#5fd3c6'};
// Matches the renderer's tile top so code drawn over a 3D roof blends with the WebGL face.
const TILE_TOP='#16140f';
const syntaxKeywords=new Set(`abstract as async await break case catch class const continue crate def default defer delete do else enum export extends extern false final finally fn for from func function get go if impl import in instanceof interface is lambda let loop match mod module mut namespace new nil None null of override package private protected pub public raise readonly require return self set static struct super switch this throw trait true try type typeof undefined union unsafe use using var virtual void where while with yield`.split(' '));
const syntaxConstants=new Set('true false null nil none undefined nan infinity self this super'.split(' '));
const tokenPattern=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[\da-f]+\b|\b0b[01]+\b|#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[A-Za-z_$][\w$-]*|\s+|./gi;

function syntaxKind(file={}){
  const ext=(file.extension||file.name?.split('.').pop()||'').toLowerCase(),language=(file.language||'').toLowerCase();
  if(['html','htm','xml','svg','vue','svelte'].includes(ext))return'markup';
  if(['css','scss','sass','less'].includes(ext))return'css';
  if(['json','jsonc','toml','yaml','yml'].includes(ext))return'data';
  if(['md','mdx','rst','txt'].includes(ext)||language==='docs')return'docs';
  if(['py','pyi','rb','r','pl','sh','bash','zsh','fish'].includes(ext))return'hash-comment';
  if(['sql','lua','hs'].includes(ext))return'dash-comment';
  return language==='other'?'plain':'code';
}

function commentStart(line,kind){
  const markers=kind==='markup'?['<!--']:kind==='css'?['/*']:kind==='hash-comment'?['#']:kind==='dash-comment'?['--']:kind==='data'?['//','#']:kind==='docs'?[]:['//','/*'];
  let quote='',escaped=false;
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"||char==='`'){quote=char;continue;}
    for(const marker of markers)if(line.startsWith(marker,i))return i;
  }
  return -1;
}

function syntaxTokens(line,file){
  const kind=syntaxKind(file);
  if(kind==='docs'&&/^\s{0,3}#{1,6}\s/.test(line))return[{text:line,type:'keyword'}];
  const commentAt=commentStart(line,kind),code=commentAt<0?line:line.slice(0,commentAt),tokens=[];
  tokenPattern.lastIndex=0;let match;
  while((match=tokenPattern.exec(code))){
    const text=match[0],lower=text.toLowerCase(),rest=code.slice(tokenPattern.lastIndex),before=code.slice(0,match.index),quoted=/^["'`]/.test(text);
    let type='plain';
    if(quoted)type='string';
    else if(/^(?:0x[\da-f]+|0b[01]+|#[\da-f]{3,8}|\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(text))type='number';
    else if(syntaxConstants.has(lower))type='constant';
    else if(syntaxKeywords.has(text))type='keyword';
    else if(/^[A-Za-z_$]/.test(text)){
      if(kind==='markup'&&(/<\/?\s*$/.test(before)||/^\s*>/.test(rest)))type='tag';
      else if((kind==='data'||kind==='css')&&/^\s*[:=]/.test(rest))type='property';
      else if(/^\s*\(/.test(rest))type='function';
      else if(/^[A-Z]/.test(text))type='type';
      else if(/\.\s*$/.test(before))type='property';
    }else if(!/^\s+$/.test(text))type='operator';
    tokens.push({text,type});
  }
  if(commentAt>=0)tokens.push({text:line.slice(commentAt),type:'comment'});
  return tokens;
}

function highlightSource(source,file){
  if(!source)return'<span class="tok-comment">No preview available.</span>';
  return source.split('\n').map(line=>syntaxTokens(line,file).map(token=>`<span class="tok-${token.type}">${escapeHtml(token.text)}</span>`).join('')).join('\n');
}

async function loadFileDetails(file){
  if(!file||!currentSnapshot||file.detailsLoaded||file.sourceLoading)return;
  const snapshotId=currentSnapshot;file.sourceLoading=true;
  try{
    const response=await apiFetch(apiUrl(`/api/snapshots/${snapshotId}/entities/${file.id}`));
    if(!response.ok)throw new Error('Could not load complete file');
    const payload=await response.json();if(currentSnapshot!==snapshotId)return;
    for(const record of [fileById.get(file.id),layoutById.get(file.id)])if(record){record.symbols=payload.symbols||record.symbols||[];record.symbolCount=payload.symbols?.length??record.symbolCount??0;record.detailsLoaded=true;}
  }catch(error){file.sourceError=error.message;file.source=file.preview??'';}
  finally{file.sourceLoading=false;if(selected?.id===file.id)renderInspector();dirty=true;}
}

async function loadSourceChunk(file,start,limit=600){
  if(!currentSnapshot)return[];file._sourceChunks||=new Map();file._sourceRequests||=new Map();
  if(file._sourceChunks.has(start))return file._sourceChunks.get(start);
  if(file._sourceRequests.has(start))return file._sourceRequests.get(start);
  const snapshotId=currentSnapshot,promise=apiFetch(apiUrl(`/api/snapshots/${snapshotId}/entities/${file.id}/source?start=${start}&limit=${limit}`)).then(response=>{if(!response.ok)throw new Error('Could not load source lines');return response.json();}).then(payload=>{if(currentSnapshot!==snapshotId)return[];file._sourceChunks.set(start,payload.lines||[]);return payload.lines||[];}).catch(()=>[]).finally(()=>file._sourceRequests.delete(start));
  file._sourceRequests.set(start,promise);return promise;
}

const sourceQueue=[],queuedSources=new Set();let activeSourceLoads=0;
function queueFullSource(file){
  if(!file||!currentSnapshot||Object.hasOwn(file,'source')||file.sourceLoading||queuedSources.has(file.id))return;
  queuedSources.add(file.id);sourceQueue.push(file);pumpSourceQueue();
}
function pumpSourceQueue(){
  while(activeSourceLoads<4&&sourceQueue.length){
    const file=sourceQueue.shift();queuedSources.delete(file.id);activeSourceLoads++;
    loadSourceChunk(file,0,4096).then(lines=>{const source=lines.join('\n');for(const record of [fileById.get(file.id),layoutById.get(file.id)])if(record){record.source=source;record._tileSource='';record._tileLines=null;}dirty=true;}).finally(()=>{activeSourceLoads--;pumpSourceQueue();});
  }
}

function mountSourceViewer(file){
  const viewer=$('#sourceViewer'),windowElement=$('#sourceWindow'),spacer=$('#sourceSpacer');if(!viewer||!windowElement||!spacer)return;
  const lineHeight=16,total=Math.max(1,file.lines);file._sourceChunks||=new Map();
  spacer.style.height=`${Math.max(lineHeight,total*lineHeight)}px`;spacer.style.width='8000px';
  let frame=0,drawVersion=0;
  const draw=async()=>{
    frame=0;const version=++drawVersion,start=Math.max(0,Math.floor(viewer.scrollTop/lineHeight)-12),count=Math.ceil(viewer.clientHeight/lineHeight)+24,chunkStart=Math.floor(start/600)*600;
    const lines=await loadSourceChunk(file,chunkStart,600);if(version!==drawVersion||!viewer.isConnected)return;
    const offset=start-chunkStart,end=Math.min(lines.length,offset+count);windowElement.style.transform=`translateY(${start*lineHeight}px)`;
    windowElement.innerHTML=lines.slice(offset,end).map((line,index)=>`<span class="source-line" data-line="${start+index+1}">${line?highlightSource(line,file):'&nbsp;'}</span>`).join('');
  };
  viewer.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(draw);},{passive:true});draw();
}

function selectFile(file,addHistory=true){
  selected=file||null;
  if(!file)coverageActiveIndex=-1;
  if(file&&addHistory){history=history.filter(item=>item.id!==file.id);history.unshift(file);history=history.slice(0,30);renderHistory();}
  $('#breadcrumbText').textContent=file?`${currentName}  ›  ${file.path}`:currentName;
  renderer.setSelected(file?.id||0);updateTrails();updateRoutes();renderInspector();if(file)loadFileDetails(file);dirty=true;
}

function renderInspector(){
  const hint=$('#inspectHint'),content=$('#inspectContent');
  if(!files.length){hint.hidden=false;hint.textContent='Open a codebase to get going.';content.innerHTML='';return;}
  if(!selected){
    hint.hidden=false;hint.textContent=expandedCoverageLayer?'Click a file or use ↑ and ↓ to move around the map':'Click anything on the map. Go on.';
    const coverageRows=Object.entries(layerLabels).map(([key,label])=>`<button class="coverage-row${expandedCoverageLayer===key?' active':''}" type="button" data-coverage-layer="${key}" aria-expanded="${expandedCoverageLayer===key}"><i style="background:${palettes[paletteIndex][key]}"></i><span>${label}</span><small>${format(sceneStats.layers.get(key)||0)}</small><b aria-hidden="true">${expandedCoverageLayer===key?'−':'+'}</b></button>`).join('');
    const expandedLabel=layerLabels[expandedCoverageLayer];
    content.innerHTML=`<div class="entity-title"><small>Coverage · ${escapeHtml(currentName)}</small><h2>${format(files.length)} indexed files</h2></div><div class="meta-grid"><span>known links</span><b>${format(sceneStats.known)}</b><span>inferred links</span><b>${format(sceneStats.inferred)}</b><span>definitions</span><b>${format(sceneStats.definitions)}</b><span>source lines</span><b>${format(sceneStats.totalLines)}</b><span>security alerts</span><b>${alertSummary()}</b></div><div class="section-title coverage-title"><span>Semantic coverage</span><small>Click a section</small></div><div class="coverage-menu">${coverageRows}</div>${expandedCoverageLayer?`<div class="coverage-list-head"><span>${escapeHtml(expandedLabel)}</span><small>Click or ↑ ↓ to navigate</small></div><div class="coverage-file-list" id="coverageFileList" tabindex="0" role="listbox" aria-label="${escapeHtml(expandedLabel)} files"><div class="coverage-list-spacer" id="coverageListSpacer"></div><div class="coverage-list-window" id="coverageListWindow"></div></div>`:''}`;
    content.querySelectorAll('[data-coverage-layer]').forEach(row=>row.addEventListener('click',()=>toggleCoverageLayer(row.dataset.coverageLayer)));
    if(expandedCoverageLayer)mountCoverageList(expandedCoverageLayer);
    return;
  }
  hint.hidden=true;
  const connections=(edgesByFile.get(selected.id)||[]).map(edge=>({edge,file:fileById.get(edge.from===selected.id?edge.to:edge.from)})).filter(item=>item.file);
  const related=connections.slice(0,30);
  const sourceStatus=selected.sourceLoading?'Loading complete file…':selected.sourceError?'Preview only':`${format(selected.lines)} lines`;
  content.innerHTML=`<div class="entity-title"><small>${escapeHtml(selected.path)}</small><h2>${escapeHtml(selected.name)}</h2></div><div class="meta-grid"><span>language</span><b>${escapeHtml(selected.language)}</b><span>semantic layer</span><b>${escapeHtml(layerLabels[selected.layer]||'Other')}</b><span>source lines</span><b>${format(selected.lines)}</b><span>definitions</span><b>${format(selected.symbols.length)}</b><span>complexity</span><b>${format(selected.complexity)}</b><span>connections</span><b>${format(connections.length)}</b></div>${alertSection(selected)}${related.length?`<div class="section-title">Relationships · ${related.length}</div>${related.map(({edge,file})=>`<div class="relation" data-id="${file.id}"><i></i><span>${escapeHtml(file.path)}</span><small>${edge.confidence}</small></div>`).join('')}`:'<p class="panel-hint">No indexed file connections. External dependencies and unresolved references are not shown.</p>'}<div class="section-title source-title"><span>Source</span><small>${sourceStatus}</small></div><div class="code-preview" id="sourceViewer" tabindex="0" aria-label="Scrollable source for ${escapeHtml(selected.name)}"><div class="source-spacer" id="sourceSpacer"></div><pre class="source-window" id="sourceWindow"></pre></div>`;
  content.querySelectorAll('.relation[data-id]').forEach(row=>row.addEventListener('click',()=>selectFile(fileById.get(Number(row.dataset.id)))));
  mountSourceViewer(selected);
}

function normalizedLayer(file){return file.layer in layerLabels?file.layer:'unknown';}

function toggleCoverageLayer(layer){
  cancelCameraAnimation();expandedCoverageLayer=expandedCoverageLayer===layer?null:layer;coverageActiveIndex=-1;renderInspector();dirty=true;
  if(expandedCoverageLayer)requestAnimationFrame(()=>$('#coverageFileList')?.focus({preventScroll:true}));
}

function mountCoverageList(layer){
  const list=$('#coverageFileList'),spacer=$('#coverageListSpacer'),windowElement=$('#coverageListWindow');if(!list||!spacer||!windowElement)return;
  const layerFiles=files.filter(file=>normalizedLayer(file)===layer).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'}));
  const rowHeight=43;spacer.style.height=`${layerFiles.length*rowHeight}px`;
  let frame=0;
  const renderWindow=()=>{
    frame=0;const start=Math.max(0,Math.floor(list.scrollTop/rowHeight)-4),count=Math.ceil(list.clientHeight/rowHeight)+8,end=Math.min(layerFiles.length,start+count);
    windowElement.style.transform=`translateY(${start*rowHeight}px)`;
    windowElement.innerHTML=layerFiles.slice(start,end).map((file,offset)=>{const index=start+offset;return`<button type="button" class="coverage-file${coverageActiveIndex===index?' active':''}" id="coverage-file-${file.id}" data-coverage-index="${index}" role="option" aria-selected="${coverageActiveIndex===index}"><i style="background:${palettes[paletteIndex][normalizedLayer(file)]}"></i><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span><em>${format(file.lines)}</em></button>`;}).join('')||'<div class="coverage-empty">No files in this section.</div>';
  };
  const preview=index=>{
    if(!layerFiles.length)return;coverageActiveIndex=Math.max(0,Math.min(layerFiles.length-1,index));const file=layerFiles[coverageActiveIndex];list.setAttribute('aria-activedescendant',`coverage-file-${file.id}`);
    const top=coverageActiveIndex*rowHeight,bottom=top+rowHeight;if(top<list.scrollTop)list.scrollTop=top;else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;
    focusFile(file);renderWindow();dirty=true;
  };
  list.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(renderWindow);},{passive:true});
  list.addEventListener('click',event=>{const row=event.target.closest('[data-coverage-index]');if(row)preview(Number(row.dataset.coverageIndex));});
  list.addEventListener('keydown',event=>{
    let next=coverageActiveIndex;
    if(event.key==='ArrowDown')next=next<0?0:next+1;
    else if(event.key==='ArrowUp')next=next<0?layerFiles.length-1:next-1;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=layerFiles.length-1;
    else if(event.key==='Enter')next=next<0?0:next;
    else return;
    event.preventDefault();preview(next);
  });
  renderWindow();
}

function renderResults(hits){
  searchHits=hits;updateBeacons();$('#resultBadge').textContent=hits.length||'';$('#resultSummary').textContent=hits.length?`${hits.length} matching files and definitions`:'Type in the filter to search files and symbols.';
  $('#resultList').innerHTML=hits.map(hit=>`<div class="result-row" data-id="${hit.entityId??hit.id}"><i></i><span><strong>${escapeHtml(hit.name)}</strong><small>${escapeHtml(hit.path)}${hit.line?` · ${hit.line}`:''}</small></span></div>`).join('');
  $('#resultList').querySelectorAll('.result-row').forEach(row=>row.addEventListener('click',()=>{const file=fileById.get(Number(row.dataset.id));if(file){selectFile(file);focusFile(file);} }));dirty=true;
}

function renderHistory(){
  $('#historyList').innerHTML=history.map(file=>`<div class="result-row" data-id="${file.id}"><i style="background:${palettes[paletteIndex][file.layer]||palettes[paletteIndex].unknown}"></i><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span></div>`).join('')||'<div class="result-summary">Selections will appear here.</div>';
  $('#historyList').querySelectorAll('.result-row').forEach(row=>row.addEventListener('click',()=>{const file=fileById.get(Number(row.dataset.id));selectFile(file,false);focusFile(file);}));
}

function focusFile(file){
  const item=layoutById.get(file.id);if(!item)return;
  if(renderer.mode==='city'){const b=item.city;if(b){renderer.city.view='heli';animateCameraTo({x:b.x+b.w/2,y:b.y+b.h/2,distance:Math.max(90,Math.max(b.w,b.h,b.height)*3.2)},renderer.city);}return;}
  const target={x:item.x+item.w/2,y:item.y+item.h/2};
  if(renderer.mode==='2d'){const fit=Math.min(viewport.clientWidth/Math.max(.2,item.w*1.35),viewport.clientHeight/Math.max(.2,item.h*1.35),MAX_2D_ZOOM);target.zoom=Math.min(MAX_2D_ZOOM,Math.max(fit,9/codeWorldFont(item)));}
  else target.distance=2.25;
  animateCameraTo(target);
}

function animateCameraTo(target,camera=activeCamera(),duration=620){
  const from={},to={};for(const [key,value] of Object.entries(target)){from[key]=camera[key];to[key]=value;}
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){Object.assign(camera,to);cameraAnimation=null;dirty=true;return;}
  cameraAnimation={camera,from,to,start:performance.now(),duration};dirty=true;
}

function cancelCameraAnimation(){cameraAnimation=null;}
function activeCamera(){return renderer.mode==='city'?renderer.city:renderer.camera;}

function switchTab(name){$$('.tab').forEach(tab=>{const active=tab.dataset.tab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});$$('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===`panel-${name}`));}
$$('.tab').forEach(tab=>tab.addEventListener('click',()=>switchTab(tab.dataset.tab)));

function resizeOverlay(){const dpr=Math.min(devicePixelRatio||1,2),w=Math.floor(overlay.clientWidth*dpr),h=Math.floor(overlay.clientHeight*dpr);if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}overlayCtx.setTransform(dpr,0,0,dpr,0,0);}
function drawChip(ctx,text,x,y,maxWidth,accent,occupied,force=false,align='left'){
  if(maxWidth<24)return false;
  ctx.font='600 11px "Space Mono", ui-monospace, monospace';
  let label=text;
  if(ctx.measureText(label).width>maxWidth-10){let low=1,high=label.length;while(low<high){const mid=Math.ceil((low+high)/2);if(ctx.measureText(`${label.slice(0,mid)}…`).width<=maxWidth-10)low=mid;else high=mid-1;}label=`${label.slice(0,low)}…`;}
  const width=Math.min(maxWidth,ctx.measureText(label).width+10);
  if(align==='center')x-=width/2;
  const box={x:x-3,y:y-2,w:width+6,h:21};
  if(!force&&occupied?.some(other=>box.x<other.x+other.w&&box.x+box.w>other.x&&box.y<other.y+other.h&&box.y+box.h>other.y))return false;
  occupied?.push(box);
  ctx.fillStyle='rgba(21,19,15,.92)';ctx.fillRect(x,y,width,17);
  if(accent){ctx.fillStyle=accent;ctx.fillRect(x,y,2,17);}
  ctx.fillStyle='rgba(237,241,238,.94)';ctx.fillText(label,x+5,y+2);
  return true;
}
function drawFileChip(ctx,item,rect,accent,occupied,force=false){
  if(renderer.mode==='2d')return drawChip(ctx,item.name,rect.x+2,rect.y+2,Math.max(28,rect.w-4),accent,occupied,force);
  const anchor=renderer.project([item.x+item.w/2,item.y+item.h/2,item.height+2]);
  const maxWidth=Math.max(46,Math.min(160,rect.w*.9));
  return drawChip(ctx,item.name,anchor.x,anchor.y-8,maxWidth,accent,occupied,force,'center');
}
function drawOverlay(){
  resizeOverlay();const ctx=overlayCtx,w=overlay.clientWidth,h=overlay.clientHeight;ctx.clearRect(0,0,w,h);ctx.save();ctx.font='600 11px "Space Mono", ui-monospace, monospace';ctx.textBaseline='top';
  codeTexturesPending=false;
  codeTextureDeadline=performance.now()+5;
  if(renderer.mode==='city'){visibleScreenItems=[];drawCityOverlay();ctx.restore();return;}
  const hitIds=new Set(searchHits.map(hit=>hit.entityId??hit.id)),occupied=[],visible=visibleLayout(w,h);visibleScreenItems=visible;
  let labelCount=0;
  if(showCode&&renderer.mode==='2d'){
    if(renderer.camera.zoom<=2.75)drawCodeOverview(ctx);
    else for(const {item,rect} of visible)drawCodeTexture(ctx,item,rect);
  }
  if(showCode&&renderer.mode==='3d'){fillCodeOverview();uploadCodeOverview();draw3dCode(ctx,visible);}
  if(renderer.mode==='2d'){
    const labelDepth=renderer.camera.zoom<1.15?1:renderer.camera.zoom<1.8?2:renderer.camera.zoom<3?3:4;
    for(const dir of directoryRects){
      if(dir.depth<1||dir.depth>4)continue;const rect=renderer.screenRect(dir);if(rect.w<42||rect.h<22||rect.x>w||rect.y>h||rect.x+rect.w<0||rect.y+rect.h<0)continue;
      const color=palettes[paletteIndex][dir.node.layer]||palettes[paletteIndex].unknown;
      ctx.strokeStyle=color;ctx.globalAlpha=dir.depth===1?.88:dir.depth===2?.58:.32;ctx.lineWidth=dir.depth===1?1.6:1;ctx.strokeRect(rect.x+.5,rect.y+.5,rect.w-1,rect.h-1);ctx.globalAlpha=1;
      if(dir.depth<=labelDepth&&rect.w>82&&rect.h>30&&labelCount<72&&drawChip(ctx,`${dir.node.name}/`,rect.x+3,rect.y+3,rect.w-6,color,occupied))labelCount++;
    }
  }else{
    const labelDepth=renderer.camera.distance>4.1?1:2;
    for(const dir of directoryRects){if(dir.depth<1||dir.depth>labelDepth)continue;const point=renderer.project([dir.x+dir.w/2,dir.y+dir.h/2,1]),rect=renderer.screenRect(dir);if(point.x<0||point.x>w||point.y<0||point.y>h)continue;if(labelCount<48&&drawChip(ctx,`${dir.node.name}/`,point.x,point.y-8,Math.min(150,Math.max(60,rect.w*.65)),palettes[paletteIndex][dir.node.layer],occupied,false,'center'))labelCount++;}
  }
  const showFileLabels=renderer.mode==='2d'?renderer.camera.zoom>1.05:renderer.camera.distance<4.1;
  if(showFileLabels)for(const {item,rect} of visible){
    if(rect.w>46&&rect.h>18&&codeScreenFont(item)<5.2&&labelCount<110&&drawFileChip(ctx,item,rect,null,occupied))labelCount++;
  }
  if(hitIds.size){
    ctx.fillStyle='rgba(5,6,10,.55)';ctx.fillRect(0,0,w,h);
    for(const {item,rect} of visible){if(!hitIds.has(item.id))continue;ctx.strokeStyle='#e8c74b';ctx.lineWidth=2;ctx.strokeRect(rect.x-.5,rect.y-.5,rect.w+1,rect.h+1);drawFileChip(ctx,item,rect,'#e8c74b',null,true);}
  }
  drawSelectedConnections(ctx);
  if(selected){const item=layoutById.get(selected.id);if(item){const rect=renderer.screenRect(item);ctx.strokeStyle='#fff08a';ctx.lineWidth=2.5;if(renderer.mode==='3d'){ctx.beginPath();tileCorners(item).forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();}else ctx.strokeRect(rect.x-1,rect.y-1,rect.w+2,rect.h+2);drawFileChip(ctx,item,rect,'#fff08a',null,true);}}
  ctx.restore();
}

function drawCityOverlay(){
  if(cityModel){updateCityReadouts();updateCitySigns();if(showCode)updateFacade();else renderer.setFacade(null);}
  // The facade gets this frame's text budget before the background roof atlas.
  if(showCode){fillCodeOverview();uploadCodeOverview();}
}

// Glowing arcs from the selected building to every file it imports or is imported by.
function updateTrails(){
  const origin=selected?.id?layoutById.get(selected.id)?.city:null;
  if(!origin||!cityModel){renderer.setTrails([]);return;}
  const top=b=>[b.x+b.w/2,b.y+b.h/2,b.height],arcs=[],seen=new Set();
  for(const edge of edgesByFile.get(selected.id)||[]){
    const key=`${edge.from}>${edge.to}`;if(seen.has(key))continue;seen.add(key);
    const from=layoutById.get(edge.from)?.city,to=layoutById.get(edge.to)?.city;if(!from||!to||from===to)continue;
    const a=top(from),b=top(to),lift=12+Math.hypot(b[0]-a[0],b[1]-a[1])*.35,points=[];
    for(let i=0;i<=28;i++){const t=i/28;points.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t+Math.sin(Math.PI*t)*lift]);}
    arcs.push({points,kind:edge.confidence==='known'?0:1});
  }
  renderer.setTrails(arcs);dirty=true;
}

// Walkable routes along the streets between the selected file and the files it imports (flowing
// out, cyan/amber chevrons) and the files that import it (flowing in, magenta dashes).
// ponytail: one Dijkstra on the main thread (tens of ms on ~1,700 files); move to a worker if large repos stutter.
const MAX_ROUTES=40;
function updateRoutes(){
  const source=selected?.id?layoutById.get(selected.id)?.city:null;
  cityRoutes=[];
  if(source&&navGrid){
    const targets=[],meta=[],seen=new Set(),imports={count:0},dependents={count:0};
    for(const edge of edgesByFile.get(selected.id)||[]){
      const outgoing=edge.from===selected.id,other=outgoing?edge.to:edge.from,counter=outgoing?imports:dependents,key=`${outgoing}:${other}`;
      if(seen.has(key)||counter.count>=MAX_ROUTES)continue;seen.add(key);
      const target=layoutById.get(other)?.city;if(!target||target===source)continue;
      targets.push(target);counter.count++;
      meta.push({outgoing,kind:outgoing?(edge.confidence==='known'?ROUTE_KIND.knownImport:ROUTE_KIND.inferredImport):ROUTE_KIND.dependent});
    }
    // Paths cost the same both ways, so one search from the selected building serves both directions.
    if(targets.length)routesFrom(navGrid,source,targets).forEach((street,i)=>{
      if(!street)return;
      // Run from inside the selected building, along the streets, and into the other file's building.
      const points=[enterBuilding(street[0],source),...street,enterBuilding(street.at(-1),targets[i])];
      cityRoutes.push({points:meta[i].outgoing?points:points.reverse(),kind:meta[i].kind,outgoing:meta[i].outgoing,target:targets[i]});
    });
  }
  renderer.setRoutes(cityRoutes);dirty=true;
}

// Posters on the city wall: civic slogans plus facts about this codebase, placed from a seed of
// the repository name so the same city always has the same wall.
function pastePosters(){
  const byComplexity=[...files].sort((a,b)=>(b.complexity||0)-(a.complexity||0))[0];
  const biggest=[...cityDistricts].sort((a,b)=>b.lines-a.lines)[0];
  const connected=[...referenceDegree.entries()].sort((a,b)=>b[1]-a[1])[0];
  const designs=[
    {title:`Welcome to ${currentName}`,body:`${format(files.length)} files · ${format(sceneStats.totalLines)} lines of code`},
    {title:'Refactor mercilessly',body:'Leave every file better than you found it.'},
    {title:'Tests are love letters',body:'to whoever touches this code next.'},
    {title:'YAGNI',body:"You aren't gonna need it. Probably."},
    {title:'Delete dead code',body:'The best line is the one you remove.'},
    {title:'Beware circular imports',body:'Report suspicious dependencies at the nearest minimap.'},
    {title:'Read the docs',body:'Then write the docs you wished you had read.'},
    {title:'Ship small',body:'Big-bang releases are loud for a reason.'},
    {title:'Name things well',body:'There are only two hard problems.'},
    {title:'Keep it boring',body:'Clever code is a 3 a.m. page waiting to happen.'},
    {title:'Fires are not a vibe',body:'Security alerts are everyone’s job.'},
    ...(byComplexity?[{title:'Tallest tower',body:`${byComplexity.name}, complexity ${format(byComplexity.complexity)}`}]:[]),
    ...(biggest?[{title:`Visit ${biggest.block.node.name}`,body:`The largest district: ${format(biggest.files)} files`}]:[]),
    ...(connected?[{title:'Most connected',body:`${fileById.get(connected[0])?.name||'?'} · ${format(connected[1])} links`}]:[]),
  ];
  let seed=0;for(const char of currentName)seed=(seed*31+char.charCodeAt(0))|0;
  const atlas=new PosterAtlas(designs);
  renderer.setPosters(atlas,posterQuads(cityWallBoxes,designs.length,seededRandom(seed)).map(quad=>({...quad,uv:atlas.uvs[quad.poster]})));
}

// Residents: roughly one per 2,500 m² of city, capped so large repos stay cheap to simulate.
function spawnResidents(){
  wanderers=showResidents&&navGrid?spawnWanderers(navGrid,Math.max(40,Math.min(600,Math.round(cityModel.width*cityModel.height/2500))),Math.random,cityModel):[];
  if(!wanderers.length)renderer.setWanderers(new Float32Array(0));
}
let residentBuffer=new Float32Array(0);
function updateResidents(seconds){
  stepWanderers(wanderers,navGrid,seconds);
  if(residentBuffer.length!==wanderers.length*4)residentBuffer=new Float32Array(wanderers.length*4);
  wanderers.forEach((w,i)=>residentBuffer.set([w.x,w.y,w.phase,w.seed],i*4));
  renderer.setWanderers(residentBuffer);
}

// ---- Security alerts from GitHub: burning buildings, hazard tape and inspector details ----
let fileAlerts=new Map(),alertState={loading:false,reason:'',statuses:null};
async function loadAlerts(){
  fileAlerts=new Map();alertState={loading:!!currentRepoUrl,reason:currentRepoUrl?'':'not-github',statuses:null};
  updateFires();
  if(!currentRepoUrl||!currentSnapshot)return renderInspector();
  const snapshotId=currentSnapshot;
  try{
    const response=await apiFetch(apiUrl(`/api/snapshots/${snapshotId}/alerts`));
    const payload=await response.json();if(currentSnapshot!==snapshotId)return;
    fileAlerts=alertsByPath(payload);
    alertState={loading:false,reason:payload.reason||'',statuses:payload.available?{codeScanning:payload.codeScanning.status,dependabot:payload.dependabot.status}:null};
  }catch{alertState={loading:false,reason:'unavailable',statuses:null};}
  updateFires();if(cityModel)buildMinimap();signState.key='';renderInspector();dirty=true;
}
function updateFires(){
  if(!cityModel)return;
  const emitters=[];
  for(const b of cityEntries){const alerts=fileAlerts.get(b.file.path);if(alerts)emitters.push({x:b.x+b.w/2,y:b.y+b.h/2,z:b.height,radius:Math.min(b.w,b.h)/2,burning:burns(alerts.worst)});}
  renderer.setFires(emitters);
}
function alertSummary(){
  if(alertState.loading)return 'loading…';
  if(alertState.reason==='signin')return 'sign in to GitHub';
  if(alertState.reason)return '—';
  const count=[...fileAlerts.values()].reduce((n,a)=>n+a.codeScanning.length+a.dependabot.length,0);
  const blocked=Object.entries(alertState.statuses||{}).filter(([,status])=>status!=='ok').map(([kind])=>kind==='dependabot'?'Dependabot':'code scanning');
  return `${format(count)} in ${format(fileAlerts.size)} files${blocked.length?` (no ${blocked.join(' or ')} access)`:''}`;
}
function alertSection(file){
  const alerts=fileAlerts.get(file.path);if(!alerts)return '';
  const rows=[...alerts.codeScanning.map(a=>({...a,kind:'Code scanning'})),...alerts.dependabot.map(a=>({...a,kind:'Dependabot'}))];
  return `<div class="section-title">Security alerts · ${rows.length}</div>${rows.map(a=>`<a class="alert-row" href="${escapeHtml(/^https:\/\/github\.com\//.test(a.url)?a.url:'#')}" target="_blank" rel="noopener noreferrer"><em class="severity-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</em><span><strong>${escapeHtml(a.title)}</strong><small>${a.kind}${a.line?` · line ${a.line}`:''}</small></span></a>`).join('')}`;
}

// Search hits become light columns visible across the city.
function updateBeacons(){
  if(!cityModel){renderer.setBeacons([]);return;}
  const ids=new Set(searchHits.map(hit=>hit.entityId??hit.id)),beams=[];
  for(const id of ids){const b=layoutById.get(id)?.city;if(!b)continue;const w=Math.max(3,Math.min(b.w,b.h)*.5);beams.push({x:b.x+b.w/2-w/2,y:b.y+b.h/2-w/2,w,h:w,height:b.height+Math.max(250,cityModel.width*.4),color:[.95,.8,.3]});}
  renderer.setBeacons(beams);dirty=true;
}

// ---- In-world text: ground names, roof plates, wall signs and the facade of the targeted file ----
const labelAtlas=new LabelAtlas();
let signState={key:'',at:0};
const SIGN_LIMITS={roofs:260,walls:120,roofRadius:260,wallRadius:70};

function updateCitySigns(){
  const c=renderer.city,{eye}=renderer.cityPose(),heli=c.view==='heli';
  const focus=heli?[c.x,c.y]:[c.ex,c.ey],radius=heli?Math.max(SIGN_LIMITS.roofRadius,c.distance*1.3):SIGN_LIMITS.roofRadius;
  // Rebuild when the focus moves a few metres, the view or selection changes, or the atlas was reset.
  const yaw=heli?c.yaw:c.lookYaw;
  const key=[Math.round(focus[0]/6),Math.round(focus[1]/6),Math.round(radius/40),c.view,selected?.id||0,labelAtlas.generation,Math.round(eye[2]/20),Math.round(yaw*10)].join();
  if(key===signState.key)return;
  signState.key=key;
  const signs={quads:[],full:false};
  buildSignQuads(signs,focus,radius,eye,heli,yaw);
  if(signs.full){
    // Start a fresh atlas holding only what is needed here; anything that still does not fit is skipped.
    labelAtlas.clear();signs.quads=[];signs.full=false;buildSignQuads(signs,focus,radius,eye,heli,yaw);
    signState.key=[...key.split(',').slice(0,5),labelAtlas.generation,...key.split(',').slice(6)].join();
  }
  renderer.setSigns(signs.quads,labelAtlas);
}

// Nearest labels first, so if the atlas fills up only the most distant ones are lost.
function buildSignQuads(signs,focus,radius,eye,heli,yaw){
  const label=(text,style)=>{if(signs.full)return null;const entry=labelAtlas.get(text,style);if(!entry)signs.full=true;return entry;};
  const add=(quad,uv)=>signs.quads.push({...quad,uv}),right=heading(yaw).right;
  // District names float above their tallest tower, turned toward the camera like skyline signs.
  // District names are for orientation from a distance; close in they would fill the view.
  for(const district of heli&&renderer.city.distance<350?[]:cityDistricts){
    const entry=label(district.block.node.name,'plate');if(!entry)continue;
    const b=district.block,width=Math.min(Math.max(b.w,b.h)*.5,Math.max(40,district.top*1.2)),height=width/entry.aspect;
    add({c:[b.x+b.w/2,b.y+b.h/2,district.top+height/2+8],u:[right[0]*width/2,right[1]*width/2,0],v:[0,0,height/2]},entry);
  }
  const near=[...cityIndex.near(focus[0],focus[1],radius)].map(b=>({b,d:Math.hypot(b.x+b.w/2-focus[0],b.y+b.h/2-focus[1])})).filter(n=>n.d<=radius).sort((a,b)=>a.d-b.d);
  const selectedCity=selected?.id?layoutById.get(selected.id)?.city:null;
  if(selectedCity&&!near.some(n=>n.b===selectedCity))near.unshift({b:selectedCity,d:0});
  let roofs=0,walls=0;
  for(const {b,d} of near){
    const isSelected=b===selectedCity;
    if(roofs>=SIGN_LIMITS.roofs&&!isSelected&&(heli||d>=SIGN_LIMITS.wallRadius))break;
    const entry=label(b.file.name,isSelected?'selected':'plate');if(!entry)break;
    const height=Math.max(1.2,Math.min(Math.min(b.w,b.h)*.22,heli?12:5)),width=Math.min(b.w*.92,height*entry.aspect);
    add(flatQuad(b.x+b.w/2,b.y+b.h/2,b.height+.08,width,width/entry.aspect),entry);roofs++;
    if(!heli&&d<SIGN_LIMITS.wallRadius&&walls<SIGN_LIMITS.walls){
      for(const quad of wallSigns(b,eye,entry.aspect))add(quad,entry);
      walls++;
    }
  }
  // Hazard tape on every building with security alerts, wherever it is in the city.
  for(const b of cityEntries){
    const alerts=fileAlerts.get(b.file.path);if(!alerts)continue;
    for(const [kind,text,style,direction] of [['dependabot','DEPENDABOT ALERT','tapeDependabot',1],['codeScanning','CODE SCANNING ALERT','tapeCodeScanning',-1]]){
      if(!alerts[kind].length)continue;
      const entry=label(text,style);if(!entry)continue;
      for(const quad of tapeQuads(b,entry.aspect,direction))add(quad,{...entry,du:entry.du*quad.fraction});
    }
  }
  // Folder names on blades at the street corners of nearby blocks, one per side of each intersection.
  if(!heli)for(const {block,buildings,label:text} of cityFolders){
    if(Math.max(Math.abs(block.x+block.w/2-focus[0])-block.w/2,Math.abs(block.y+block.h/2-focus[1])-block.h/2)>SIGN_LIMITS.wallRadius)continue;
    const entry=label(text,'street');if(!entry)break;
    for(const quad of folderBlades(block,buildings,eye,entry.aspect,bladeClearance))add(quad,entry);
  }
  // Street names on the northern kerb of nearby blocks.
  for(const block of cityModel.blocks){
    if(block.depth<2||block.depth>3||Math.hypot(block.x+block.w/2-focus[0],block.y+block.h/2-focus[1])>radius)continue;
    const entry=label(block.node.name,'ground');if(!entry)break;
    const height=Math.min(block.depth===2?2.2:1.4,block.h*.12),width=Math.min(block.w*.7,height*entry.aspect);
    add(flatQuad(block.x+block.w/2,block.y+height*.8,.4,width,width/entry.aspect),entry);
  }
}

// Free distance from a wall point outward at sign height, so blades stop short of neighbours.
function bladeClearance(x,y,[nx,ny]){
  const origin=[x+nx*.05,y+ny*.05,4],hit=pickRay(origin,[nx,ny,0],[...cityIndex.near(x,y,5)],5);
  return hit?hit.distance:5;
}

// Source code on the wall of the building in the crosshair, once you are close enough to read it.
let facadeState={entry:null,texture:null};
function updateFacade(){
  const c=renderer.city,entry=c.view!=='heli'?cityTargetEntry:null;
  const eye=[c.ex,c.ey,c.ez],close=entry&&Math.hypot(entry.x+entry.w/2-eye[0],entry.y+entry.h/2-eye[1])<Math.max(45,Math.max(entry.w,entry.h));
  if(!close){if(facadeState.entry){facadeState={entry:null,texture:null};renderer.setFacade(null);}return;}
  const item=entry.file,texture=buildCodeTexture(item,{x:0,y:0,w:1024,h:1024*item.h/Math.max(.001,item.w)});
  if(!texture)return;
  const quad=facadeQuad(entry,eye,texture.width/texture.height);
  if(entry!==facadeState.entry||texture!==facadeState.texture||facadeState.quadKey!==JSON.stringify(quad?.c)){
    facadeState={entry,texture,quadKey:JSON.stringify(quad?.c)};renderer.setFacade(texture,quad);
  }
}

function tileCorners(item){return [[item.x,item.y],[item.x+item.w,item.y],[item.x+item.w,item.y+item.h],[item.x,item.y+item.h]].map(([x,y])=>renderer.project([x,y,item.height||0]));}
function drawSelectedConnections(ctx){
  if(!selected)return;
  const origin=layoutById.get(selected.id);if(!origin)return;
  const center=item=>{if(renderer.mode==='3d')return renderer.project([item.x+item.w/2,item.y+item.h/2,item.height||0]);const rect=renderer.screenRect(item);return{x:rect.x+rect.w/2,y:rect.y+rect.h/2};};
  const a=center(origin);if(!Number.isFinite(a.x)||!Number.isFinite(a.y))return;
  const seen=new Set();ctx.save();ctx.beginPath();
  for(const edge of edgesByFile.get(selected.id)||[]){
    const id=edge.from===selected.id?edge.to:edge.from;
    if(id===selected.id||seen.has(id))continue;seen.add(id);
    const target=layoutById.get(id);if(!target)continue;
    const b=center(target);if(!Number.isFinite(b.x)||!Number.isFinite(b.y))continue;
    ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
  }
  // Batch every connection into two strokes: a dark outline keeps them legible over source text.
  ctx.lineCap='round';ctx.strokeStyle='rgba(12,12,12,.85)';ctx.lineWidth=3.5;ctx.stroke();
  ctx.strokeStyle='rgba(255,229,142,.9)';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();
}

function codeWorldFont(item){
  // Code has a stable physical scale inside each file tile. Width establishes
  // an 80-column page; height determines how many real source lines fit.
  return Math.max(.004,Math.min(item.w/80,item.h/1.34));
}
function codeScreenFont(item){return codeWorldFont(item)*renderer.camera.zoom;}
function tileSourceLines(item){
  const source=item.source??item.preview??'';
  if(item._tileSource!==source||!item._tileLines){item._tileSource=source;item._tileLines=source.split('\n');item._tileTokens=[];}
  return item._tileLines;
}
function drawSyntaxLine(ctx,line,file,x,y,maxX,alpha,tokens=syntaxTokens(line,file)){
  let screenX=x;
  for(const token of tokens){if(screenX>maxX)break;ctx.fillStyle=syntaxPalette[token.type]||syntaxPalette.plain;ctx.globalAlpha=alpha;ctx.fillText(token.text,screenX,y);screenX+=ctx.measureText(token.text).width;}
  ctx.globalAlpha=1;
}
let codeTextureDeadline=0,codeTexturesPending=false;
function paintCodeSurface(ctx,item,width,height){
  const source=tileSourceLines(item),scale=width/Math.max(.001,item.w),fontSize=Math.max(.1,codeWorldFont(item)*scale),lineHeight=fontSize*1.34,pad=Math.max(.1,fontSize*.72);
  const count=Math.min(source.length,Math.max(1,Math.floor((height-pad*2)/lineHeight)));
  ctx.textBaseline='top';ctx.font=`${fontSize}px SFMono-Regular, Consolas, monospace`;
  for(let index=0;index<count;index++){
    const tokens=item._tileTokens[index]||(item._tileTokens[index]=syntaxTokens(source[index]||'',item));
    drawSyntaxLine(ctx,source[index]||'',item,pad,pad+index*lineHeight,width-pad,.92,tokens);
  }
}
// Paints files into the overview canvas within the frame budget. The same canvas is the 2D
// zoomed-out code layer and, uploaded to the GPU, the texture on every 3D roof.
function fillCodeOverview(){
  if(!overviewCanvas)resetCodeCaches();
  while(overviewIndex<layoutItems.length&&performance.now()<codeTextureDeadline){
    const item=layoutItems[overviewIndex++],x=Math.round(item.x*overviewScale),y=Math.round(item.y*overviewScale),width=Math.max(1,Math.round(item.w*overviewScale)),height=Math.max(1,Math.round(item.h*overviewScale));
    overviewContext.save();overviewContext.translate(x,y);overviewContext.beginPath();overviewContext.rect(0,0,width,height);overviewContext.clip();paintCodeSurface(overviewContext,item,width,height);overviewContext.restore();
  }
  if(overviewIndex<layoutItems.length)codeTexturesPending=true;
}
function uploadCodeOverview(){
  // Re-uploading 3000x2040 pixels is costly, so partial progress is sent at most twice a second.
  if(overviewUploaded===overviewIndex)return;
  const now=performance.now();
  if(overviewIndex<layoutItems.length&&now-overviewUploadedAt<500){codeTexturesPending=true;return;}
  renderer.setCodeTexture(overviewCanvas);overviewUploaded=overviewIndex;overviewUploadedAt=now;
}
function drawCodeOverview(ctx){
  fillCodeOverview();
  const zoom=renderer.camera.zoom;
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.globalAlpha=.96;ctx.drawImage(overviewCanvas,viewport.clientWidth/2-renderer.camera.x*zoom,viewport.clientHeight/2-renderer.camera.y*zoom,1000*zoom,680*zoom);ctx.restore();
}
function rememberCodeTexture(item,texture){
  if(item._codeTexture)codeTextureBytes-=item._codeTexture.width*item._codeTexture.height*4;
  item._codeTexture=texture;codeTextureBytes+=texture.width*texture.height*4;codeTextureLru.delete(item.id);codeTextureLru.set(item.id,item);
  while(codeTextureBytes>codeTextureBudget&&codeTextureLru.size>1){const oldest=codeTextureLru.entries().next().value;if(!oldest)break;const [id,victim]=oldest;codeTextureLru.delete(id);if(victim!==item&&victim._codeTexture){codeTextureBytes-=victim._codeTexture.width*victim._codeTexture.height*4;victim._codeTexture=null;}}
}
function buildCodeTexture(item,rect){
  const source=tileSourceLines(item),sourceKey=item._tileSource;if(!source.length)return null;
  const worldFont=codeWorldFont(item),lineCapacity=Math.max(1,Math.floor((item.h-worldFont*1.44)/(worldFont*1.34)));
  if(item.lines>source.length&&lineCapacity>source.length)queueFullSource(item);
  const dpr=Math.min(devicePixelRatio||1,2),screenWidth=Math.max(1,rect.w*dpr);
  const target=Math.max(32,Math.min(2048,2**Math.ceil(Math.log2(screenWidth))));
  const cached=item._codeTexture;
  if(cached&&item._codeSource===sourceKey&&item._codeResolution>=target/1.6&&item._codeResolution<=target*2.6){codeTextureLru.delete(item.id);codeTextureLru.set(item.id,item);return cached;}
  if(performance.now()>codeTextureDeadline&&cached){codeTexturesPending=true;return cached;}
  if(performance.now()>codeTextureDeadline){codeTexturesPending=true;return null;}
  const scale=Math.max(.01,Math.min(target/Math.max(.001,item.w),2048/Math.max(.001,item.h)));
  const width=Math.max(1,Math.round(item.w*scale)),height=Math.max(1,Math.round(item.h*scale));
  const texture=document.createElement('canvas');texture.width=width;texture.height=height;
  paintCodeSurface(texture.getContext('2d',{alpha:true}),item,width,height);
  rememberCodeTexture(item,texture);item._codeSource=sourceKey;item._codeResolution=target;return texture;
}
function draw3dCode(ctx,visible){
  // Roofs already show the GPU code overview. Only roofs close enough for its resolution to blur
  // get a sharp per-file texture here, far faces first so nearer roofs cover them.
  const faces=[];
  for(const entry of visible){
    const {item,rect}=entry;if(rect.w/Math.max(.001,item.w)<overviewScale*1.25)continue; // texture not yet magnified
    faces.push({...entry,depth:renderer.project([item.x+item.w/2,item.y+item.h/2,item.height]).depth});
  }
  faces.sort((a,b)=>b.depth-a.depth);
  for(const {item,rect} of faces){
    const corners=tileCorners(item);if(corners.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))continue;
    ctx.save();ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();
    ctx.fillStyle=TILE_TOP;ctx.fillRect(rect.x-1,rect.y-1,rect.w+2,rect.h+2);
    const texture=buildCodeTexture(item,rect);
    if(texture){
      // Match the two triangles used by the WebGL top face exactly.
      const [a,b,c,d]=corners,w=texture.width,h=texture.height;
      for(const second of [false,true]){
        ctx.save();ctx.beginPath();const triangle=second?[a,c,d]:[a,b,c];triangle.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();
        const x=second?{x:c.x-d.x,y:c.y-d.y}:{x:b.x-a.x,y:b.y-a.y};
        const y=second?{x:d.x-a.x,y:d.y-a.y}:{x:c.x-b.x,y:c.y-b.y};
        ctx.transform(x.x/w,x.y/w,y.x/h,y.y/h,a.x,a.y);ctx.drawImage(texture,0,0);ctx.restore();
      }
    }
    ctx.restore();
    ctx.save();ctx.strokeStyle=palettes[paletteIndex][item.layer]||palettes[paletteIndex].unknown;ctx.lineWidth=1;ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();ctx.restore();
  }
}

function drawCodeTexture(ctx,item,rect){
  const texture=buildCodeTexture(item,rect);if(!texture)return;
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.globalAlpha=.96;ctx.drawImage(texture,rect.x,rect.y,rect.w,rect.h);ctx.restore();
}

function animate(now){
  const frameSeconds=Math.min(.1,(now-lastFrame)/1000);
  if(renderer.mode==='city'&&renderer.city.view!=='heli'&&!cameraAnimation&&(heldKeys.size||touchMove.forward||touchMove.right))stepCity(frameSeconds);
  if(tour)advanceTour(now,frameSeconds);
  if(renderer.mode==='city'&&wanderers.length)updateResidents(frameSeconds);
  if(cameraAnimation){
    const progress=Math.min(1,(now-cameraAnimation.start)/cameraAnimation.duration),eased=1-(1-progress)**4;
    for(const key of Object.keys(cameraAnimation.to))cameraAnimation.camera[key]=cameraAnimation.from[key]+(cameraAnimation.to[key]-cameraAnimation.from[key])*eased;
    if(progress>=1)cameraAnimation=null;dirty=true;
  }
  if(renderer.animating)dirty=true;
  if(dirty){
    // The overlay fills the code overview, so draw it before the GPU pass that samples it.
    renderer.resize();drawOverlay();renderer.codeOn=showCode;renderer.render();dirty=codeTexturesPending;
  }
  const delta=now-lastFrame;lastFrame=now;if(delta<100){frameSamples.push(delta);if(frameSamples.length>45)frameSamples.shift();if(frameSamples.length&&Math.floor(now/500)!==Math.floor((now-delta)/500)){const average=frameSamples.reduce((a,b)=>a+b,0)/frameSamples.length;$('#fps').textContent=`${Math.round(1000/average)} fps · ${(average).toFixed(1)} ms`;}}
  requestAnimationFrame(animate);
}

function pickAt(x,y){
  if(renderer.mode==='2d'){const world=renderer.worldAt(x,y),cell=spatialGrid.get(`${Math.floor(world.x/spatialCell)}:${Math.floor(world.y/spatialCell)}`)||[];let match=null,area=Infinity;for(const item of cell){if(world.x>=item.x&&world.x<=item.x+item.w&&world.y>=item.y&&world.y<=item.y+item.h){const next=item.w*item.h;if(next<area){match=item;area=next;}}}return match;}
  if(renderer.mode==='city'){const {origin,dir}=renderer.ray(x,y);return pickRay(origin,dir,cityEntries)?.entry.file||null;}
  let best=null,depth=Infinity;
  for(const {item,rect} of visibleScreenItems){
    if(x<rect.x||x>rect.x+rect.w||y<rect.y||y>rect.y+rect.h)continue;
    const points=tileCorners(item);let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++){
      const a=points[i],b=points[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }
    const d=renderer.project([item.x+item.w/2,item.y+item.h/2,item.height||0]).depth;
    if(inside&&d<depth){depth=d;best=item;}
  }
  return best;
}

viewport.addEventListener('pointerdown',event=>{
  // Only drags that start on the map; pointer capture would otherwise swallow clicks on floating controls.
  if(event.button>2||event.target!==glCanvas)return;
  if(renderer.mode==='city'&&renderer.city.view!=='heli'&&event.pointerType==='mouse'&&event.button===0&&glCanvas.requestPointerLock){
    // Mouse-look: the first click captures the pointer, later clicks select the building in the crosshair.
    event.preventDefault();
    if(document.pointerLockElement===glCanvas)inspectCityTarget(false);else glCanvas.requestPointerLock();
    return;
  }
  if(tour)endTour();
  if(event.pointerType==='touch'&&startTouch(event))return;
  const pan=renderer.mode!=='2d'&&(event.button===1||event.button===2||event.shiftKey||event.altKey||event.metaKey||event.ctrlKey);
  if(renderer.mode==='2d'&&event.button!==0)return;
  event.preventDefault();
  cancelCameraAnimation();
  pointer={down:true,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,action:pan?'pan':'orbit',id:event.pointerId};
  viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging',pan?'panning':'orbiting');
});
viewport.addEventListener('pointermove',event=>{
  if(document.pointerLockElement)return;
  if(event.pointerType==='touch'&&moveTouch(event))return;
  const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
  if(pointer.down&&event.pointerId===pointer.id){
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;pointer.x=event.clientX;pointer.y=event.clientY;
    if(renderer.mode==='2d'){renderer.camera.x-=dx/renderer.camera.zoom;renderer.camera.y-=dy/renderer.camera.zoom;}
    else if(renderer.mode==='city'){if(renderer.city.view==='heli')dragCity(dx,dy,pointer.action);else lookCity(dx,dy);}
    else if(pointer.action==='pan')pan3d(dx,dy);
    else{renderer.camera.yaw-=dx*.007;renderer.camera.pitch=Math.max(.045,Math.min(1.525,renderer.camera.pitch+dy*.006));}
    dirty=true;$('#tooltip').hidden=true;return;
  }
  const item=pickAt(x,y),tip=$('#tooltip');if(item){tip.hidden=false;tip.style.left=`${Math.min(viewport.clientWidth-320,x+13)}px`;tip.style.top=`${Math.min(viewport.clientHeight-70,y+13)}px`;tip.innerHTML=`${escapeHtml(item.name)}<small>${escapeHtml(item.path)} · ${format(item.lines)} lines</small>`;}else tip.hidden=true;
});
function finishPointer(event){
  if(event.pointerType==='touch')endTouch(event);
  if(!pointer.down||event.pointerId!==pointer.id)return;
  viewport.classList.remove('dragging','panning','orbiting');
  if(event.type==='pointerup'&&event.button===0&&Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)<4){const rect=viewport.getBoundingClientRect();selectFile(pickAt(event.clientX-rect.left,event.clientY-rect.top));}
  pointer.down=false;pointer.id=null;
}
viewport.addEventListener('pointerup',finishPointer);
viewport.addEventListener('pointercancel',finishPointer);
viewport.addEventListener('pointerleave',()=>{$('#tooltip').hidden=true;});
viewport.addEventListener('contextmenu',event=>{if(renderer.mode!=='2d')event.preventDefault();});
viewport.addEventListener('wheel',event=>{event.preventDefault();cancelCameraAnimation();if(tour)endTour();if(renderer.mode==='city'){dollyCity(event.deltaY*.00115);dirty=true;return;}if(renderer.mode==='3d'){dolly3d(event.deltaY*.00115);dirty=true;return;}const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,before=renderer.worldAt(x,y),factor=Math.exp(-event.deltaY*.0012);renderer.camera.zoom=Math.max(.25,Math.min(MAX_2D_ZOOM,renderer.camera.zoom*factor));const after=renderer.worldAt(x,y);renderer.camera.x+=before.x-after.x;renderer.camera.y+=before.y-after.y;dirty=true;},{passive:false});
viewport.addEventListener('dblclick',event=>{
  const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,file=pickAt(x,y);
  if(renderer.mode==='city'&&renderer.city.view!=='heli')return;
  if(file){selectFile(file);focusFile(file);return;}
  // Double-clicking a street from the helicopter drops you there at eye level.
  if(renderer.mode==='city'){const {origin,dir}=renderer.ray(x,y),hit=groundHit(origin,dir);if(hit)setCityView('walk',hit);}
});

$$('[data-view]').forEach(button=>button.addEventListener('click',()=>{cancelCameraAnimation();$$('[data-view]').forEach(v=>v.classList.toggle('active',v===button));renderer.mode=button.dataset.view;if(renderer.mode==='3d')renderer.camera.zoom=1;if(renderer.mode==='city'&&!cityFitted)fitCity();$('#cameraHelp').hidden=renderer.mode!=='3d';updateCityHud();dirty=true;}));
$$('[data-metric]').forEach(button=>button.addEventListener('click',()=>{$$('[data-metric]').forEach(v=>v.classList.toggle('active',v===button));currentMetric=button.dataset.metric;computeLayout();}));
$('#codeButton').classList.toggle('active',showCode);$('#codeButton').addEventListener('click',event=>{showCode=!showCode;event.currentTarget.classList.toggle('active',showCode);dirty=true;});
$('#homeButton').addEventListener('click',()=>{selectFile(null);fitScene();});
$('#mapButton').addEventListener('click',fitScene);
$('#layersButton').addEventListener('click',()=>{showLegend=!showLegend;$('#legend').classList.toggle('open',showLegend);$('#layersButton').classList.toggle('active',showLegend);});
$('#paletteButton').addEventListener('click',()=>{paletteIndex=(paletteIndex+1)%palettes.length;computeLayout();buildLegend();renderInspector();renderHistory();});
const settingsDialog=$('#settingsDialog');
$('#settingsButton').addEventListener('click',()=>{
  $('#settingsContent').innerHTML=`<div class="settings-status"><span><i></i>Workspace preferences</span><small>${renderer.mode.toUpperCase()} VIEW</small></div>`;
  $('#paletteSelect').value=String(paletteIndex);$('#sourceToggle').checked=showCode;$('#fpsToggle').checked=!$('#fps').hidden;$('#residentsToggle').checked=showResidents;
  if(!settingsDialog.open)settingsDialog.showModal();
});
settingsDialog.addEventListener('click',event=>{if(event.target===settingsDialog)settingsDialog.close();});

function buildLegend(){const legend=$('#legend');legend.innerHTML=Object.entries(layerLabels).map(([key,label])=>`<button type="button" data-legend-layer="${key}"><span><i style="background:${palettes[paletteIndex][key]}"></i>${label}</span><b>${format(sceneStats.layers.get(key)||0)}</b></button>`).join('');legend.querySelectorAll('[data-legend-layer]').forEach(row=>row.addEventListener('click',()=>{selectFile(null);expandedCoverageLayer=row.dataset.legendLayer;coverageActiveIndex=-1;showLegend=false;legend.classList.remove('open');$('#layersButton').classList.remove('active');switchTab('inspector');renderInspector();requestAnimationFrame(()=>$('#coverageFileList')?.focus({preventScroll:true}));}));}

let searchTimer;
$('#searchInput').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,140);});
async function runSearch(){
  const query=$('#searchInput').value.trim();if(query.length<2){renderResults([]);return;}
  let hits=[];
  if(currentSnapshot){try{const response=await apiFetch(apiUrl(`/api/snapshots/${currentSnapshot}/search?q=${encodeURIComponent(query)}&limit=180`));hits=await response.json();}catch{} }
  else{const q=query.toLowerCase();for(const file of files){if(hits.length>=180)break;if(file.path.toLowerCase().includes(q))hits.push({entityId:file.id,path:file.path,name:file.name,line:1,kind:'file'});for(const symbol of file.symbols){if(hits.length>=180)break;if(symbol.name.toLowerCase().includes(q))hits.push({entityId:file.id,path:file.path,name:symbol.name,line:symbol.line,kind:'definition'});}}}
  renderResults(hits);switchTab('results');
}
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented)return;
  if(document.querySelector('dialog[open]'))return;
  const editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
  if(editing&&event.key!=='Escape')return;
  if(event.key.toLowerCase()==='f'&&!event.metaKey&&!event.ctrlKey){event.preventDefault();fitScene();return;}
  if(event.key==='/'&&document.activeElement!==$('#searchInput')){event.preventDefault();$('#searchInput').focus();}
  if(event.key==='Escape'){$('#searchInput').blur();$('#tooltip').hidden=true;}
  if((event.metaKey||event.ctrlKey)&&event.key==='o'){event.preventDefault();$('#loadDialog').showModal();}
  if(renderer.mode==='city'&&handleCityKey(event))return;
  if(renderer.mode!=='3d'||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))return;
  cancelCameraAnimation();
  const key=event.key.toLowerCase(),orbitStep=.065,panStep=22/Math.max(.8,renderer.camera.distance);
  if(key==='arrowleft')renderer.camera.yaw+=orbitStep;
  else if(key==='arrowright')renderer.camera.yaw-=orbitStep;
  else if(key==='arrowup')renderer.camera.pitch=Math.max(.045,renderer.camera.pitch-orbitStep);
  else if(key==='arrowdown')renderer.camera.pitch=Math.min(1.525,renderer.camera.pitch+orbitStep);
  else if(key==='a')pan3d(panStep,0);
  else if(key==='d')pan3d(-panStep,0);
  else if(key==='w')pan3d(0,panStep);
  else if(key==='s')pan3d(0,-panStep);
  else if(key==='+'||key==='=')dolly3d(-.12);
  else if(key==='-'||key==='_')dolly3d(.12);
  else if(key==='f')fitScene();
  else return;
  event.preventDefault();dirty=true;
});
window.addEventListener('resize',()=>{dirty=true;});

const dialog=$('#loadDialog');$('#loadButton').addEventListener('click',()=>dialog.showModal());$('#welcomeOpen').addEventListener('click',()=>dialog.showModal());
$('#localFolderButton').addEventListener('click',async()=>{
  if(!localFoldersEnabled)return;
  dialog.close();
  if('showDirectoryPicker' in window){try{const handle=await window.showDirectoryPicker();const chosen=[];await collectHandles(handle,'',chosen);await uploadLocal(handle.name,chosen);}catch(error){if(error.name!=='AbortError')showError(error.message);}}
  else $('#folderFallback').click();
});
$('#folderFallback').addEventListener('change',async event=>{const chosen=[...event.target.files].map(file=>({file,path:file.webkitRelativePath||file.name}));const name=chosen[0]?.path.split('/')[0]||'Local folder';await uploadLocal(name,chosen);event.target.value='';});

async function collectHandles(directory,prefix,output){for await(const [name,handle] of directory.entries()){if(name==='.git'||name==='node_modules'||name==='target')continue;const path=prefix?`${prefix}/${name}`:name;if(handle.kind==='directory')await collectHandles(handle,path,output);else{const file=await handle.getFile();output.push({file,path});}}}
async function uploadLocal(name,chosen){
  if(!chosen.length)return;showProgress('Preparing local codebase',`Sending ${format(chosen.length)} files…`,0,chosen.length);
  try{
    const response=await apiFetch(apiUrl('/api/jobs'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'local',name})});const {jobId,error}=await response.json();if(error)throw new Error(error);
    let completed=0,cursor=0;const workers=Array.from({length:Math.min(4,chosen.length)},async()=>{while(cursor<chosen.length){const index=cursor++,entry=chosen[index];if(entry.file.size>8*1024*1024){completed++;continue;}const upload=await apiFetch(apiUrl(`/api/jobs/${jobId}/files?path=${encodeURIComponent(entry.path)}`),{method:'POST',body:entry.file});if(!upload.ok)throw new Error(`Could not read ${entry.path}`);completed++;showProgress('Preparing local codebase',entry.path,completed,chosen.length);}});await Promise.all(workers);await apiFetch(apiUrl(`/api/jobs/${jobId}/commit`),{method:'POST'});watchJob(jobId);
  }catch(error){showError(error.message);}
}

$('#githubButton').addEventListener('click',startGithub);$('#githubInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();startGithub();}});
async function startGithub(){const url=$('#githubInput').value.trim();$('#githubError').textContent='';$('#githubNotice').hidden=true;if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?(?:\.git)?$/.test(url)){ $('#githubError').textContent='Enter a GitHub owner/repository URL.';return;}if(!sameRepo(pendingPlace()?.repo,url))clearPendingPlace();dialog.close();pullGithub(url,'Cloning repository','Connecting to GitHub…');}
async function pullGithub(url,title,message){
  lastGithubUrl=url;showProgress(title,message,0,0);
  try{const response=await apiFetch(apiUrl('/api/jobs'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'github',url,name:url.split('/').filter(Boolean).pop()?.replace(/\.git$/,'')})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Could not start indexing');watchJob(payload.jobId);}catch(error){showError(error.message);}
}

let activeJobStream=null;
async function watchJob(jobId){
  activeJobStream?.abort();
  const controller=new AbortController();activeJobStream=controller;
  try{
    const response=await apiFetch(apiUrl(`/api/jobs/${jobId}/events`),{signal:controller.signal});
    for await(const job of progressEvents(response)){
      if(controller.signal.aborted)return;
      const place=pendingPlace();
      showProgress(job.phase==='ready'?'Landscape ready':place?'Opening a shared link':'Indexing codebase',place&&!job.total?`Pulling ${repoName(place.repo)} from GitHub. You'll be taken to ${place.file?place.file.split('/').pop():'the shared spot'} once it's built.`:job.message,job.completed,job.total);
      if(job.error){if(place&&job.authRequired)showPrivateLinkWarning(place,job.authRequired);else{clearPendingPlace();showError(job.error,job.authRequired);}return;}
      if(job.snapshotId){
        const scene=await apiFetch(apiUrl(`/api/snapshots/${job.snapshotId}/scene`),{signal:controller.signal});
        if(!scene.ok)throw new Error('Could not load the landscape.');
        const snapshot=await scene.json();if(controller.signal.aborted)return;
        applySnapshot(snapshot);buildLegend();setTimeout(()=>{if(activeJobStream===null)$('#progressCard').hidden=true;},350);return;
      }
    }
    throw new Error('The indexer connection closed before the landscape was ready.');
  }catch(error){if(!controller.signal.aborted)showError(error.message);}
  finally{if(activeJobStream===controller)activeJobStream=null;controller.abort();}
}
function showProgress(title,message,completed,total){$('#progressCard').hidden=false;$('#progressAction').hidden=true;$('#progressTitle').textContent=title;$('#progressMessage').textContent=message||'';const percent=total?Math.max(3,Math.round(completed/total*100)):12;$('#progressFill').style.width=`${percent}%`;$('#progressFill').style.background='';$('#progressCount').textContent=total?`${format(completed)} / ${format(total)} · ${percent}%`:'Working…';}
function showError(message,authRequired){$('#progressCard').hidden=false;showAuthAction(authRequired);$('#progressTitle').textContent='Could not build landscape';$('#progressMessage').textContent=message;$('#progressFill').style.width='100%';$('#progressFill').style.background='var(--danger)';$('#progressCount').textContent='Check the repository or folder and try again.';}

// Private repositories: sign in (or grant the GitHub App access), then resume the same repository on return.
let lastGithubUrl='',githubStatus={};
function showAuthAction(authRequired){
  const action=$('#progressAction'),href=authRequired==='signin'?apiUrl('/api/github/login'):authRequired==='install'?githubStatus.installUrl:'';
  action.hidden=!href;if(!href)return;
  action.href=href;action.textContent=authRequired==='signin'?'Sign in with GitHub':'Grant repository access';
}
$('#progressAction').addEventListener('click',()=>{try{sessionStorage.setItem('codenav.pendingRepo',lastGithubUrl);}catch{}});
$('#githubAccount').addEventListener('click',event=>{if(event.target.closest('a'))try{sessionStorage.setItem('codenav.pendingRepo',$('#githubInput').value.trim());}catch{}});
async function loadGithubStatus(){
  try{const response=await apiFetch(apiUrl('/api/github/status'));if(response.ok)githubStatus=await response.json();}catch{}
  const account=$('#githubAccount');account.hidden=!githubStatus.configured;account.replaceChildren();if(account.hidden)return;
  if(githubStatus.connected){
    const signOut=Object.assign(document.createElement('button'),{type:'button',textContent:'Sign out'});
    signOut.addEventListener('click',async()=>{await apiFetch(apiUrl('/api/github/logout'),{method:'POST'}).catch(()=>{});loadGithubStatus();});
    account.append(`Signed in to GitHub as ${githubStatus.login} · `,signOut);
    if(githubStatus.installUrl)account.append(' · ',Object.assign(document.createElement('a'),{href:githubStatus.installUrl,textContent:'Choose repositories'}));
  }else account.append('Private repository? ',Object.assign(document.createElement('a'),{href:apiUrl('/api/github/login'),textContent:'Sign in with GitHub'}));
}
// Back from GitHub (sign-in, cancel or app installation): open the Open codebase dialog with the
// outcome at the top and any repository the visitor was trying to open ready to go.
async function resumeAfterGithub(){
  const params=new URLSearchParams(location.search),outcome=params.get('github')||(params.get('setup_action')?'installed':'');
  if(!outcome)return;
  window.history.replaceState(null,'',location.pathname+location.hash);
  let pending='';try{pending=sessionStorage.getItem('codenav.pendingRepo')||'';sessionStorage.removeItem('codenav.pendingRepo');}catch{}
  const notices={
    connected:['ok',githubStatus.login?`Signed in to GitHub as ${githubStatus.login}. Private repos unlocked.`:'Signed in to GitHub.'],
    installed:['ok','GitHub access updated. Try that repo again.'],
    denied:['warn','GitHub sign-in was cancelled. Public repos still work.'],
    error:['error','GitHub sign-in failed. Give it another go.'],
  };
  const [tone,message]=notices[outcome]||notices.error;
  const place=pendingPlace();
  if(place&&tone==='ok'){
    try{sessionStorage.removeItem('codenav.pendingRepo');}catch{}
    pullGithub(place.repo,'Opening a shared link',`${message} Pulling ${repoName(place.repo)} and taking you to the shared spot…`);
    return;
  }
  const notice=$('#githubNotice');notice.hidden=false;notice.dataset.tone=tone;notice.textContent=message;
  if(pending)$('#githubInput').value=pending;
  if(!dialog.open)dialog.showModal();
  requestAnimationFrame(()=>(pending&&tone==='ok'?$('#githubButton'):$('#githubInput')).focus());
}

let localFoldersEnabled=false;
$$('.local-only').forEach(element=>{element.hidden=true;});
async function checkBackend(){
  const indicator=$('.live-dot');
  try{
    const response=await apiFetch(apiUrl('/api/health'));
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const health=await response.json();
    indicator.classList.add('connected');indicator.title='Indexer connected';indicator.setAttribute('aria-label','Indexer connected');
    // Local folder uploads only exist when the server was started with SHOW_LOCAL=true.
    localFoldersEnabled=health.localFolders===true;$$('.local-only').forEach(element=>{element.hidden=!localFoldersEnabled;});
  }catch{
    indicator.classList.remove('connected');indicator.title='Indexer unavailable';indicator.setAttribute('aria-label','Indexer unavailable');
  }
}

// Preferences stay on this device and never contain repository or server details.
function savePreferences(){try{localStorage.setItem('codenavigator.preferences',JSON.stringify({palette:paletteIndex,source:showCode,fps:!$('#fps').hidden,residents:showResidents}));}catch{}}
try{const saved=JSON.parse(localStorage.getItem('codenavigator.preferences')||'{}');if(Number.isInteger(saved.palette)&&saved.palette>=0&&saved.palette<palettes.length)paletteIndex=saved.palette;if(typeof saved.source==='boolean')showCode=saved.source;if(typeof saved.residents==='boolean')showResidents=saved.residents;$('#fps').hidden=saved.fps!==true;}catch{$('#fps').hidden=true;}
$('#codeButton').classList.toggle('active',showCode);
$('#paletteSelect').addEventListener('change',event=>{paletteIndex=Number(event.target.value);computeLayout();buildLegend();renderInspector();renderHistory();savePreferences();});
$('#sourceToggle').addEventListener('change',event=>{showCode=event.target.checked;$('#codeButton').classList.toggle('active',showCode);dirty=true;savePreferences();});
$('#fpsToggle').addEventListener('change',event=>{$('#fps').hidden=!event.target.checked;savePreferences();});
$('#residentsToggle').addEventListener('change',event=>{showResidents=event.target.checked;if(cityModel)spawnResidents();dirty=true;savePreferences();});
$('#paletteButton').addEventListener('click',savePreferences);$('#codeButton').addEventListener('click',savePreferences);
$('#dismissProgress').addEventListener('click',()=>{$('#progressCard').hidden=true;});
$('#fitButton').addEventListener('click',fitScene);
function zoomStep(direction){cancelCameraAnimation();if(renderer.mode==='city')dollyCity(-direction*.22);else if(renderer.mode==='3d')dolly3d(-direction*.22);else renderer.camera.zoom=Math.max(.25,Math.min(MAX_2D_ZOOM,renderer.camera.zoom*Math.exp(direction*.3)));dirty=true;}
$('#zoomInButton').addEventListener('click',()=>zoomStep(1));$('#zoomOutButton').addEventListener('click',()=>zoomStep(-1));
$$('.canvas-controls, .breadcrumb, .progress-card, .legend, .camera-help, .city-hud, .minimap').forEach(control=>{['pointerdown','dblclick','wheel'].forEach(type=>control.addEventListener(type,event=>event.stopPropagation()));});
$$('[data-camera-preset]').forEach(button=>button.addEventListener('click',()=>{
  const poses={isometric:{yaw:-.35,pitch:.78},top:{yaw:0,pitch:.045},front:{yaw:0,pitch:1.35}};
  const from={...renderer.camera},to={...from,...poses[button.dataset.cameraPreset]};
  cancelCameraAnimation();
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)Object.assign(renderer.camera,to);
  else cameraAnimation={camera:renderer.camera,from,to,start:performance.now(),duration:450};
  dirty=true;
}));
dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
$$('.tab').forEach((tab,index)=>{tab.id=`tab-${tab.dataset.tab}`;tab.setAttribute('aria-controls',`panel-${tab.dataset.tab}`);$(`#panel-${tab.dataset.tab}`).setAttribute('aria-labelledby',tab.id);tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=$$('.tab'),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;switchTab(tabs[next].dataset.tab);tabs[next].focus();});});
switchTab('inspector');
new ResizeObserver(()=>{dirty=true;}).observe(viewport);
// Sidebar folds away with the tab on its left edge (or [ ); remembered on this device.
function setInspectorHidden(hidden){
  $('.workspace').classList.toggle('inspector-hidden',hidden);
  const toggle=$('#inspectorToggle');toggle.setAttribute('aria-expanded',String(!hidden));toggle.title=hidden?'Show the sidebar ([)':'Hide the sidebar ([)';
  try{localStorage.setItem('codenav.inspectorHidden',hidden?'1':'');}catch{}
  dirty=true;
}
$('#inspectorToggle').addEventListener('click',event=>{event.currentTarget.blur();setInspectorHidden(!$('.workspace').classList.contains('inspector-hidden'));});
document.addEventListener('keydown',event=>{if(event.key==='['&&!event.metaKey&&!event.ctrlKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)&&!document.querySelector('dialog[open]')){event.preventDefault();$('#inspectorToggle').click();}});
try{if(localStorage.getItem('codenav.inspectorHidden'))setInspectorHidden(true);}catch{}
// Canvas text (signs, posters, labels) needs the web fonts loaded before it rasterises them.
Promise.all(['400 30px "Archivo Black"','400 13px "Atkinson Hyperlegible"','700 13px "Atkinson Hyperlegible"','700 11px "Space Mono"'].map(font=>document.fonts.load(font))).then(()=>{
  labelAtlas.clear();if(cityModel)pastePosters();signState.key='';resetCodeCaches();dirty=true;
}).catch(()=>{});
renderer.setData([]);fitScene();renderInspector();renderHistory();requestAnimationFrame(animate);checkBackend();loadGithubStatus().then(()=>/[?&](github|setup_action)=/.test(location.search)?resumeAfterGithub():openPlaceFromHash());
