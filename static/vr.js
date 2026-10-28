// XGO Quest 3 Hand Pilot · No external dependencies · passthrough AR + WebXR Hand Input
// Right finger selects direction; left thumb-index pinch must be held to move.
const $ = (s)=>document.querySelector(s);
const msg = $('#message'), startButton=$('#enterXR');
const token = (globalThis.crypto?.randomUUID?.() || 'vrpilot-'+Math.random().toString(36).slice(2)).replace(/[^\w-]/g,'');
let apiBase='', pin='', paired=false, estop=false, xr=null, refSpace=null, gl=null, hud=null;
let handStatus='Waiting for headset', lastCmd='STOP', lastSend=0, pending=false, armed=false, wasDriving=false;
let bothPalmsSince=0, estopTriggered=false, lastHUDUpdate=0;
let rightStable='STOP', candidate='STOP', candidateFrames=0, driveGeneration=0;
let currentStatus={model:'—',battery:null,estop:false};
const commands={FORWARD:{x:0,y:.64},BACKWARD:{x:0,y:-.55},LEFT:{x:-.65,y:0},RIGHT:{x:.65,y:0},STOP:{x:0,y:0}};
const clean = s => String(s||'').replace(/[<>]/g,'');
function tell(text,kind=''){msg.textContent=text;msg.className='message '+kind;}
function endpointURL(raw) {
 const val=String(raw||'').trim().replace(/\/+$/, '');
 const u=new URL(val);
 if(u.protocol!=='https:' || u.username || u.password || u.search || u.hash || !['','/'].includes(u.pathname))
   throw Error('Use the HTTPS tunnel origin only, without a path or query');
 return u.origin;
}
const AUTO_CONFIGS = [
 'https://raw.githubusercontent.com/radyly/xgo/main/connection.json',
 'https://raw.githubusercontent.com/radyly/xgo/master/connection.json',
 new URL('./connection.json',location.href).href
];
let lookupBusy=false, lastLookup=0;
async function automaticConnect(){
 if(lookupBusy)return;
 lookupBusy=true;
 try {
  // Raw GitHub updates independently of slower GitHub Pages deployments.
  let config=null;
  for(const cfgUrl of AUTO_CONFIGS){
    try{
      const r=await fetch(cfgUrl+'?t='+Date.now(),{cache:'no-store'});
      if(!r.ok)continue;
      const candidate=await r.json();
      if(candidate.status==='online'&&candidate.url){config=candidate;break;}
    }catch(_){}
  }
  if(!config)throw Error('Waiting for the Pi to publish its connection');
  if(config.status!=='online'||!config.url)throw Error('Robot not started');
  const next=endpointURL(config.url);
  if(next!==apiBase){
    apiBase=next; pin='';paired=false;startButton.disabled=true;setConnected(false);
    $('#autoStatus').textContent='Robot found. Pairing automatically…';
  }
  if(!paired){
    await getStatus();
    const result=await request('claim');
    pin=result.key;paired=true;startButton.disabled=false;
    $('#autoStatus').textContent='XGO CONNECTED ✓  ·  Ready for Quest 3';
    tell('Connected automatically! Tap Enter Passthrough Pilot on Quest 3.','good');
  }
 }catch(e){
  $('#autoStatus').textContent='Waiting for robot…';
  setConnected(false);
  if(!paired)tell('Start ./start.sh on the Raspberry Pi. This page reconnects automatically.','');
 }finally{lookupBusy=false;lastLookup=Date.now();}
}
function setConnected(good){$('#linkChip').classList.toggle('online',good);$('#linkText').textContent=good?'PI CONNECTED':'OFFLINE';}
async function request(path, data={}, overridePin=pin){
  if(!apiBase)throw Error('Connect secure tunnel URL first');
  const r=await fetch(apiBase+'/api/vr/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-XGO-VR-PIN':overridePin},body:JSON.stringify({client:token,...data}),cache:'no-store'});
  let out={};try{out=await r.json();}catch(_){/* network errors elsewhere */}
  if(!r.ok || out.ok===false)throw Error(out.error || out.reason || 'HTTP '+r.status);
  return out;
}
async function getStatus(){
 try{
  if(!apiBase){setConnected(false);return;}
  const r=await fetch(apiBase+'/api/status',{cache:'no-store'});if(!r.ok)throw Error('offline');
  const s=await r.json();currentStatus=s;
  setConnected(true);$('#robotName').textContent=s.model||'XGO MINI';
  $('#batteryLabel').textContent=s.battery==null?'Unavailable':s.battery+'%';
  estop=!!s.estop;$('#safetyLabel').textContent=estop?'E-STOP LATCHED':s.vr_pilot?'PILOT ACTIVE':'READY';
  $('#safetyLabel').style.color=estop?'#f37d8d':'#83e7c9';
 }catch(e){setConnected(false);$('#safetyLabel').textContent='OFFLINE';}
}
$('#stopBtn').addEventListener('click',async()=>{if(!paired){tell('Pair before using emergency stop.','warn');return;}
 try{await request('estop'); estop=true;tell('Emergency stop latched. Resume only when the floor is clear.','warn');await getStatus();}
 catch(e){tell('Could not reach the Pi: '+e.message,'warn');}
});
$('#resumeBtn').addEventListener('click',async()=>{if(!paired)return tell('Pair first.','warn');
 try{await request('resume');estop=false;tell('Resumed. Movement still needs a fresh left pinch.','good');await getStatus();}
 catch(e){tell('Resume error: '+e.message,'warn');}
});
// Desktop preview: never actuate motors without operator opt-in. Held pointer required.
let previewTimer=null, previewPointer=null, previewCmd='STOP';
function doPreview(which){previewCmd=which.toUpperCase();$('#previewState').textContent='PREVIEW: '+previewCmd;
  document.querySelectorAll('[data-drive]').forEach(b=>b.classList.toggle('pressed',b.dataset.drive.toUpperCase()===previewCmd));
  if($('#testLive').checked && paired && !estop)sendDrive(previewCmd);
}
function stopPreview(){clearInterval(previewTimer);previewTimer=null;previewCmd='STOP';$('#previewState').textContent='PREVIEW IDLE';
 document.querySelectorAll('[data-drive]').forEach(b=>b.classList.remove('pressed'));
 if($('#testLive').checked && paired)sendRelease();}
document.querySelectorAll('[data-drive]').forEach(btn=>{
 btn.addEventListener('pointerdown',e=>{if(previewTimer||xr)return;btn.setPointerCapture(e.pointerId);previewPointer=e.pointerId;doPreview(btn.dataset.drive);previewTimer=setInterval(()=>doPreview(btn.dataset.drive),150);});
 btn.addEventListener('pointerup',stopPreview);btn.addEventListener('pointercancel',stopPreview);btn.addEventListener('lostpointercapture',stopPreview);
});
$('#testLive').addEventListener('change',e=>{if(!e.target.checked)sendRelease();});
async function sendDrive(which){if(!paired||estop||pending)return;
 const v=commands[which]||commands.STOP;const generation=driveGeneration;pending=true;
 try{await request('drive',v);wasDriving=true;}
 catch(e){tell('Robot drive rejected: '+clean(e.message),'warn');}
 finally{pending=false;if(generation!==driveGeneration){sendRelease();}}
}
async function sendRelease(){driveGeneration++;wasDriving=false;lastCmd='STOP';armed=false;
 if(!paired)return;
 try{await request('release');}catch(_){/* watchdog still stops on missing heartbeat */}
}
async function emergencyFromXR(){if(!paired||estop||estopTriggered)return;estopTriggered=true;
 try{await request('estop');estop=true;tell('Both open palms triggered EMERGENCY STOP.','warn');}
 catch(e){tell('E-STOP command failed: '+clean(e.message),'warn');}
}
// --- 3D hand geometry and gesture recognition ---
function xyz(p){return p?.transform?.position || null;}
function dist(a,b){if(!a||!b)return 1e9;return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
function sub(a,b){return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z};}
function norm(p){const d=Math.hypot(p.x,p.y,p.z)||1;return {x:p.x/d,y:p.y/d,z:p.z/d};}
function cross(a,b){return {x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x};}
function rotateInverse(v,q){const inv={x:-q.x,y:-q.y,z:-q.z,w:q.w};let u={x:inv.x,y:inv.y,z:inv.z};let t=cross(u,v);t={x:2*t.x,y:2*t.y,z:2*t.z};let s=cross(u,t);return {x:v.x+inv.w*t.x+s.x,y:v.y+inv.w*t.y+s.y,z:v.z+inv.w*t.z+s.z};}
function getHand(frame, source){
 const h=source.hand; if(!h)return null;
 const joint=(n)=>xyz(frame.getJointPose(h.get(n),refSpace));
 const wrist=joint('wrist'), index=joint('index-finger-tip'), thumb=joint('thumb-tip');
 const base=joint('index-finger-phalanx-proximal'), mid=joint('middle-finger-tip');
 const midBase=joint('middle-finger-phalanx-proximal'), ring=joint('ring-finger-tip');
 const ringBase=joint('ring-finger-phalanx-proximal');
 const pinky=joint('pinky-finger-tip'), pinkyBase=joint('pinky-finger-phalanx-proximal');
 if(!wrist||!index||!thumb||!base||!mid||!midBase||!ring||!ringBase||!pinky||!pinkyBase)return null;
 const palmSpan=Math.max(.045,dist(wrist,base));
 const extended=(tip,root)=>dist(wrist,tip)/Math.max(.03,dist(wrist,root)) > 1.53;
 const indexUp=extended(index,base),middleUp=extended(mid,midBase);
 const ringUp=extended(ring,ringBase),pinkyUp=extended(pinky,pinkyBase);
 const pinchDist=dist(thumb,index);
 const pinch=pinchDist < Math.min(.043,Math.max(.020,palmSpan*.35));
 const open=indexUp&&middleUp&&ringUp&&pinkyUp;
 const point=indexUp&&!middleUp&&!ringUp&&!pinkyUp;
 return {index,base,pinch,open,point,pinchDist};
}
function classifyDirection(hand, q){
 if(!hand||!hand.point)return 'STOP';
 // Convert relative to user's gaze; headset yaw does not invert commands.
 const d=norm(rotateInverse(norm(sub(hand.index,hand.base)),q));
 if(d.y < -.46)return 'BACKWARD';
 if(d.x > .48)return 'RIGHT';
 if(d.x < -.48)return 'LEFT';
 if(d.z < -.18 && Math.abs(d.y)<.55)return 'FORWARD';
 return 'STOP';
}
function recognize(frame,viewerPose,now){
 let left=null,right=null;
 for(const source of xr.inputSources){
  if(!source.hand)continue;
  const hand=getHand(frame,source);if(!hand)continue;
  if(source.handedness==='left')left=hand;
  if(source.handedness==='right')right=hand;
 }
 const visible=(left?1:0)+(right?1:0);
 $('#handStatus').textContent=visible===2?'Two hands visible':visible+' hand(s) tracked';
 // No operation without a left-hand hold. Non-gesture input is never treated as a command.
 if(estop)return {dir:'STOP',armed:false,left,right,visible};
 if(left?.open && right?.open){
  if(!bothPalmsSince)bothPalmsSince=now;
  if(now-bothPalmsSince>=1050)emergencyFromXR();
 }else{bothPalmsSince=0;estopTriggered=false;}
 const enabled=!!(left&&left.pinch&&right&&right.point&&!left.open&&!right.open);
 const dir=enabled?classifyDirection(right,viewerPose.transform.orientation):'STOP';
 if(dir===candidate)candidateFrames++;else{candidate=dir;candidateFrames=1;}
 if(candidateFrames>=4)rightStable=candidate;
 // Release must be immediate (not smoothed).
 return {dir:enabled?rightStable:'STOP',armed:enabled,left,right,visible};
}
// --- Tiny dependency-free WebGL HUD, over real-world Quest passthrough ---
class XRHud{
 constructor(context){
  this.gl=context;
  const vs=`attribute vec2 a; attribute vec2 uv; varying vec2 v; void main(){ v=uv; gl_Position=vec4(a,0.,1.); }`;
  const fs=`precision mediump float; varying vec2 v; uniform sampler2D tex; void main(){ gl_FragColor=texture2D(tex,v); }`;
  function shader(type,src){const o=context.createShader(type);context.shaderSource(o,src);context.compileShader(o);
    if(!context.getShaderParameter(o,context.COMPILE_STATUS))throw Error(context.getShaderInfoLog(o));return o;}
  const program=context.createProgram();context.attachShader(program,shader(context.VERTEX_SHADER,vs));context.attachShader(program,shader(context.FRAGMENT_SHADER,fs));context.linkProgram(program);
  if(!context.getProgramParameter(program,context.LINK_STATUS))throw Error(context.getProgramInfoLog(program));
  this.program=program;this.pos=context.getAttribLocation(program,'a');this.uv=context.getAttribLocation(program,'uv');
  this.buffer=context.createBuffer();context.bindBuffer(context.ARRAY_BUFFER,this.buffer);
  // Quad in upper center: visible in both eyes without obscuring the robot or floor.
  context.bufferData(context.ARRAY_BUFFER,new Float32Array([
   -.67,.26,0,1, .67,.26,1,1, -.67,.91,0,0,
   -.67,.91,0,0, .67,.26,1,1, .67,.91,1,0,
  ]),context.STATIC_DRAW);
  this.texture=context.createTexture();context.bindTexture(context.TEXTURE_2D,this.texture);
  context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MIN_FILTER,context.LINEAR);
  context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MAG_FILTER,context.LINEAR);
  context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_S,context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_T,context.CLAMP_TO_EDGE);
  this.canvas=document.createElement('canvas');this.canvas.width=1024;this.canvas.height=512;this.ctx=this.canvas.getContext('2d');
 }
 paint(command,enabled,seen,latched){
  const c=this.ctx,w=1024,h=512;c.clearRect(0,0,w,h);
  const gradient=c.createLinearGradient(0,0,1024,0);gradient.addColorStop(0,'rgba(10,27,45,0.83)');gradient.addColorStop(1,'rgba(14,42,62,0.83)');
  c.fillStyle=gradient;c.beginPath();c.roundRect(8,8,w-16,h-16,48);c.fill();c.strokeStyle='rgba(118,243,211,.55)';c.lineWidth=4;c.stroke();
  c.fillStyle='#70ecd9';c.font='bold 28px system-ui';c.fillText('✦  AUPP ETL  /  XGO HAND PILOT',52,70);
  c.fillStyle='#ffffff';c.font='bold 70px system-ui';c.fillText(latched?'E-STOP LATCHED':enabled?command:'STOPPED',52,166);
  c.font='bold 27px system-ui';c.fillStyle=latched?'#ff8ba3':enabled?'#7fffd0':'#ffcd8c';c.fillText(latched?'RESET FROM WEB PANEL':enabled?'● LEFT PINCH · ARMED':'○ RELEASED · SAFE',55,219);
  c.fillStyle='rgba(255,255,255,.14)';c.fillRect(50,257,925,2);
  c.fillStyle='#eefaff';c.font='bold 28px system-ui';c.fillText('LEFT  🤏  HOLD PINCH',55,319);c.fillText('RIGHT  ☝  POINT',532,319);
  c.fillStyle='#b1d1e5';c.font='24px system-ui';c.fillText('Forward  ·  Down = Back',55,377);c.fillText('Left / Right = Turn',532,377);
  c.fillStyle='#85c5d7';c.font='21px system-ui';c.fillText('Both open palms 1s = E-STOP',55,452);c.fillText('HANDS '+seen+'/2  ·  '+(currentStatus.model||'XGO'),520,452);
  const gl=this.gl;gl.bindTexture(gl.TEXTURE_2D,this.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.canvas);
 }
 render(){const gl=this.gl;
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(this.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  gl.enableVertexAttribArray(this.pos);gl.vertexAttribPointer(this.pos,2,gl.FLOAT,false,16,0);
  gl.enableVertexAttribArray(this.uv);gl.vertexAttribPointer(this.uv,2,gl.FLOAT,false,16,8);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.uniform1i(gl.getUniformLocation(this.program,'tex'),0);
  gl.drawArrays(gl.TRIANGLES,0,6);
 }
}
function renderXR(t,frame){
 if(!xr)return;
 xr.requestAnimationFrame(renderXR);
 const pose=frame.getViewerPose(refSpace);if(!pose)return;
 const now=performance.now();let g={dir:'STOP',armed:false,visible:0};
 try{g=recognize(frame,pose,now);}catch(err){console.warn('XR hands:',err);}
 armed=g.armed;const newCommand=g.armed?g.dir:'STOP';
 if(!g.armed){
  if(wasDriving){wasDriving=false;sendRelease();}
 }else if(now-lastSend>125 && !pending){
  lastSend=now;sendDrive(newCommand);
 }
 lastCmd=newCommand;
 if(now-lastHUDUpdate>170){lastHUDUpdate=now;hud.paint(newCommand,g.armed,g.visible,estop);}
 const layer=xr.renderState.baseLayer;gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);
 gl.viewport(0,0,layer.framebufferWidth,layer.framebufferHeight);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
 for(const v of pose.views){const vp=layer.getViewport(v);gl.viewport(vp.x,vp.y,vp.width,vp.height);hud.render();}
}
async function onEnd(){xr=null;refSpace=null;hud=null;armed=false;lastCmd='STOP';await sendRelease();
 startButton.disabled=!paired;tell('Passthrough session ended; movement stopped.','good');}
async function enterXR(){
 if(!paired)return tell('Pair the robot first.','warn');
 if(estop)return tell('Emergency stop is latched. Resume only after clearing the floor.','warn');
 if(!window.isSecureContext)return tell('WebXR requires a trusted HTTPS origin. See the README certificate instructions.','warn');
 if(!navigator.xr)return tell('Open this link on Meta Quest Browser; WebXR is unavailable in this browser.','warn');
 startButton.disabled=true;
 try{
  const supported=await navigator.xr.isSessionSupported('immersive-ar');
  if(!supported)throw Error('Quest Browser immersive-ar passthrough is unavailable');
  const canvas=$('#xrCanvas'); gl=canvas.getContext('webgl',{alpha:true,antialias:true,xrCompatible:true,premultipliedAlpha:false});
  if(!gl)throw Error('WebGL not available');
  if(gl.makeXRCompatible)await gl.makeXRCompatible();
  xr=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['local','hand-tracking']});
  xr.addEventListener('end',onEnd,{once:true});
  xr.addEventListener('visibilitychange',()=>{if(xr&&xr.visibilityState!=='visible')sendRelease();});
  xr.updateRenderState({baseLayer:new XRWebGLLayer(xr,gl,{alpha:true,depth:false,stencil:false})});
  refSpace=await xr.requestReferenceSpace('local');
  hud=new XRHud(gl);hud.paint('STOP',false,0,estop);
  wasDriving=false;rightStable=candidate='STOP';candidateFrames=0;lastSend=0;lastHUDUpdate=0;
  tell('Mixed reality pilot started. Stay beside the robot and ensure a clear floor.','good');
  xr.requestAnimationFrame(renderXR);
 }catch(e){console.error(e);if(xr){try{await xr.end();}catch(_){}}xr=null;startButton.disabled=false;
  tell('Could not enter passthrough: '+clean(e.message)+'. Ensure Quest Browser hand tracking and trusted HTTPS.','warn');}
}
startButton.addEventListener('click',enterXR);
async function initialize(){
 const secure=window.isSecureContext;
 if(!secure)tell('HTTPS is required for Quest hand tracking.','warn');
 else if(navigator.xr){
  const supported=await navigator.xr.isSessionSupported('immersive-ar').catch(()=>false);
  $('#handStatus').textContent=supported?'Quest passthrough available':'WebXR passthrough unavailable here';
 } else {$('#handStatus').textContent='Desktop preview';}
 automaticConnect();
 setInterval(()=>{if(!paired||!apiBase)automaticConnect(); else getStatus();},4500);
 // When a temporary tunnel changes, discover the new one without any input.
 setInterval(automaticConnect,30000);
}
window.addEventListener('pagehide',()=>{if(paired&&apiBase)fetch(apiBase+'/api/vr/release',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-XGO-VR-PIN':pin},body:JSON.stringify({client:token})}).catch(()=>{});});
initialize();
