'use strict';
// XGO Hand Pilot V4: 2D control is primary; WebXR only after successful motor test.
const $=s=>document.querySelector(s);
const getClient=()=>{let c='';try{c=sessionStorage.getItem('xgo_client_v4')||''}catch(_){}if(!/^[a-zA-Z0-9_-]{8,100}$/.test(c)){c=(crypto.randomUUID?.()||'quest'+Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9_-]/g,'');try{sessionStorage.setItem('xgo_client_v4',c)}catch(_){}}return c};
const CLIENT=getClient();
const DIRECT=location.hostname.endsWith('.trycloudflare.com')||location.hostname==='127.0.0.1';
let base=DIRECT?location.origin:'',session='',connected=false,paired=false,estop=false;
let lastDirection='STOP',pulseTimer=0,sending=false,desired='STOP', lastLatency=0,robotData=null;
let xr=null,reference=null,gl=null,hud=null,frameLast=0,handSeenAt=0,detected='STOP', xrArm=false,xrArmStart=0;
let configBusy=false,statusBusy=false,sequence=0;
const clean=s=>String(s||'').slice(0,180);
function message(s,bad=false){$('#message').textContent=clean(s);$('#message').className='message '+(bad?'bad':'good');}
function setLink(ok){connected=ok;$('#linkPill').classList.toggle('on',ok);$('#linkLabel').textContent=ok?'ROBOT ONLINE':'ROBOT OFFLINE';$('#connection').textContent=ok?'ONLINE':'OFFLINE';}
function updateDirection(s){lastDirection=s;$('#direction').textContent=s==='STOP'?'NO MOTION':s;$('#motionLabel').textContent=s==='STOP'?'STOPPED':s+' COMMAND';const p=$('.signal');p.classList.toggle('active',s!=='STOP');p.classList.toggle('alert',estop);}
const jsonFetch=async (url,options={},ms=5000)=>{const c=new AbortController(),timer=setTimeout(()=>c.abort(),ms);try{const start=performance.now();const r=await fetch(url,{...options,cache:'no-store',signal:c.signal});const out=await r.json();lastLatency=Math.round(performance.now()-start);if(!r.ok||out.ok===false)throw Error(out.error||out.message||'HTTP '+r.status);return out}finally{clearTimeout(timer)}};
function api(path,data={}){return jsonFetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'X-XGO-Session':session}:{})},body:JSON.stringify({client:CLIENT,...data})},4200)}
async function findRobot(){if(configBusy||DIRECT)return;configBusy=true;try{const c=await jsonFetch('./connection.json?cache='+Date.now(),{},6500);if(c.status!=='online'||!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(c.url))throw Error('Robot not started on Pi');if(base!==c.url){base=c.url;paired=false;session='';$('#disconnectBtn').hidden=true;$('#connectBtn').disabled=false;$('#connectBtn').textContent='CONNECT TO XGO';stopDrive();message('Robot tunnel found. Checking connection…')}}catch(e){$('#connectionHelp').textContent='Start ./start.sh on the Raspberry Pi. This page will retry automatically.'}finally{configBusy=false}}
async function poll(){if(statusBusy)return;statusBusy=true;try{
 if(!base)await findRobot();if(!base)throw Error('Waiting for Pi tunnel');
 const s=await jsonFetch(base+'/api/status',{},5500);robotData=s;setLink(s.connected||s.robot==='SIMULATION');estop=!!s.estop;
 $('#mode').textContent=estop?'E-STOP':'READY';$('#battery').textContent=s.battery==null?'—':s.battery+'%';$('#model').textContent=s.robot||'—';
 $('#motor').textContent=s.command_written?'WRITE OK':'NO WRITE';$('#latency').textContent=lastLatency+' ms';
 $('#connectionHelp').textContent=s.connected?'XGO Mini serial connected. Press CONNECT TO XGO once, then test movement by holding an arrow.':'Robot bridge found, but the XGO serial link is unavailable.';
 $('#motionNote').textContent=estop?'Emergency stop latched. Press RESET STOP only after checking the robot.':s.moving_command?'Serial command accepted. Check the real robot to confirm movement.':'No movement commanded.';
 if(!sending&&desired==='STOP')updateDirection(s.command||'STOP');
 if(s.error)message('Robot: '+s.error,true);
 }catch(e){setLink(false);$('#motor').textContent='—';$('#connectionHelp').textContent='Robot tunnel unavailable. start.sh must be running. Retrying…';if(paired){stopDrive();message('Connection lost. Motors should stop via watchdog.',true)}}finally{statusBusy=false}}
$('#connectBtn').addEventListener('click',async()=>{if(!connected||!base)return message('Wait for ROBOT ONLINE, then try Connect.',true);if(paired)return message('Already connected. Hold a direction to test.');try{const s=await api('claim');session=s.session;paired=true;$('#connectBtn').textContent='CONNECTED ✓';$('#connectBtn').disabled=true;$('#disconnectBtn').hidden=false;message('Ready. Hold FORWARD briefly; release to stop.');}catch(e){message('Pairing: '+e.message,true)}});
$('#disconnectBtn').addEventListener('click',async()=>{if(!paired)return;stopDrive();try{await api('unpair');message('Control released. Connect using your Quest 3 now.')}catch(e){message('Release failed: '+e.message,true)}finally{session='';paired=false;$('#connectBtn').disabled=false;$('#connectBtn').textContent='CONNECT TO XGO';$('#disconnectBtn').hidden=true}});
async function sendPulse(){if(!paired||!connected||estop||desired==='STOP'||sending)return;const dir=desired;sending=true;try{const v=await api('drive',{direction:dir,seq:++sequence});if(v.command_written){$('#motor').textContent='WRITE OK';$('#motionNote').textContent='Sent '+dir+' to XGO. Verify actual leg movement visually.';}else{$('#motor').textContent='SIMULATION';}updateDirection(v.command||dir)}catch(e){message('Movement failed: '+e.message,true);stopDrive()}finally{sending=false}}
function stopDrive(){clearInterval(pulseTimer);pulseTimer=0;desired='STOP';document.querySelectorAll('.drive').forEach(x=>x.classList.remove('pressed'));updateDirection('STOP');if(session&&base)api('release',{seq:++sequence}).catch(()=>{});}
function beginDrive(button,e){if(xr)return; if(!paired||!connected||estop){message('Connect to the robot and clear E-STOP first.',true);return}if(pulseTimer)stopDrive();desired=button.dataset.direction;button.classList.add('pressed');if(e?.pointerId!=null){try{button.setPointerCapture(e.pointerId)}catch(_){}}updateDirection(desired);sendPulse();pulseTimer=setInterval(sendPulse,175)}
for(const b of document.querySelectorAll('.drive')){
 b.addEventListener('pointerdown',e=>{e.preventDefault();beginDrive(b,e)});
 for(const ev of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(ev,stopDrive);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopDrive()});window.addEventListener('blur',stopDrive);
window.addEventListener('pagehide',()=>{stopDrive();if(session&&base)fetch(base+'/api/release',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-XGO-Session':session},body:JSON.stringify({client:CLIENT,seq:++sequence})}).catch(()=>{})});
$('#stop').onclick=async()=>{stopDrive();if(!session)return message('Connect first, then emergency stop.',true);try{await api('estop');estop=true;message('EMERGENCY STOP active. Robot stopped.');await poll()}catch(e){message('Stop command failed; ensure physical power switch is reachable: '+e.message,true)}};
$('#reset').onclick=async()=>{stopDrive();if(!session)return message('Connect first.',true);try{await api('reset');estop=false;message('E-STOP reset. Hold a direction to move.');await poll()}catch(e){message('Reset failed: '+e.message,true)}};
// Minimal AR: transparent framebuffer; small head-locked status panel, no opaque full-screen overlay.
const VS=`attribute vec3 aPos; attribute vec2 aUV; uniform mat4 uProjection; varying vec2 vUV; void main(){vUV=aUV; gl_Position=uProjection*vec4(aPos,1.);}`;
const FS=`precision mediump float; varying vec2 vUV; uniform sampler2D uTexture; void main(){gl_FragColor=texture2D(uTexture,vUV);}`;
function shader(gl,type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
function createHUD(gl){const p=gl.createProgram();gl.attachShader(p,shader(gl,gl.VERTEX_SHADER,VS));gl.attachShader(p,shader(gl,gl.FRAGMENT_SHADER,FS));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));
 const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);const y=.24,z=-1.55,w=.98,h=.37;const data=new Float32Array([
 -w/2,y-h/2,z,0,1, w/2,y-h/2,z,1,1, -w/2,y+h/2,z,0,0,
 -w/2,y+h/2,z,0,0, w/2,y-h/2,z,1,1, w/2,y+h/2,z,1,0]);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
 const canvas=document.createElement('canvas');canvas.width=768;canvas.height=290;const ctx=canvas.getContext('2d');
 const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
 const pos=gl.getAttribLocation(p,'aPos'),uv=gl.getAttribLocation(p,'aUV'),proj=gl.getUniformLocation(p,'uProjection'),sam=gl.getUniformLocation(p,'uTexture');
 function paint(state,info){ctx.clearRect(0,0,768,290);ctx.fillStyle='rgba(8,30,44,.77)';ctx.beginPath();ctx.roundRect(5,5,758,275,30);ctx.fill();ctx.strokeStyle='rgba(107,239,214,.85)';ctx.lineWidth=4;ctx.stroke();ctx.fillStyle='#9edacb';ctx.font='bold 26px system-ui';ctx.fillText('XGO MINI   •   HAND PILOT',40,52);ctx.fillStyle=state==='STOP'?'#f4c573':'#65f9ba';ctx.font='bold 61px system-ui';ctx.fillText(state,38,136);ctx.fillStyle='#ecf8ff';ctx.font='27px system-ui';ctx.fillText(info.slice(0,43),40,197);ctx.font='20px system-ui';ctx.fillStyle='#9bbdc6';ctx.fillText('Left fist = ARM    •    Right point = direction',40,252);gl.bindTexture(gl.TEXTURE_2D,tex);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,canvas)}
 function draw(matrix){gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(pos);gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(pos,3,gl.FLOAT,false,20,0);gl.vertexAttribPointer(uv,2,gl.FLOAT,false,20,12);gl.uniformMatrix4fv(proj,false,matrix);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(sam,0);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,6)}
 paint('STOP','WebXR loading…');return {paint,draw};}
function diff(a,b){return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}}
function length(v){return Math.hypot(v.x,v.y,v.z)}
function distance(a,b){return length(diff(a,b))}
function headRelative(v,q){const x=-q.x,y=-q.y,z=-q.z,w=q.w;const tx=2*(y*v.z-z*v.y),ty=2*(z*v.x-x*v.z),tz=2*(x*v.y-y*v.x);return {x:v.x+w*tx+y*tz-z*ty,y:v.y+w*ty+z*tx-x*tz,z:v.z+w*tz+x*ty-y*tx}}
function readHand(frame,src){if(!src.hand)return null;const at=name=>{const j=src.hand.get(name);if(!j)return null;const pose=frame.getJointPose(j,reference);return pose?.transform?.position||null};
 const wrist=at('wrist'),index=at('index-finger-tip'),base=at('index-finger-phalanx-proximal');if(!wrist||!index||!base)return null;
 const roots=['middle-finger-phalanx-proximal','ring-finger-phalanx-proximal','pinky-finger-phalanx-proximal'];const tips=['middle-finger-tip','ring-finger-tip','pinky-finger-tip'];
 let curled=0;for(let i=0;i<3;i++){const root=at(roots[i]),tip=at(tips[i]);if(!root||!tip)return null;if(distance(wrist,tip)<distance(wrist,root)*1.6)curled++}
 const indexExtended=distance(wrist,index)>distance(wrist,base)*1.55;
 return {fist:curled===3&&!indexExtended,point:curled>=2&&indexExtended,index,base};}
function recognize(frame,pose){let l=null,r=null;for(const s of xr.inputSources){if(!s.hand)continue;let h=readHand(frame,s);if(s.handedness==='left')l=h;if(s.handedness==='right')r=h}
 if(!l||!r)return {arm:false,dir:'STOP',msg:'Show both hands'};
 handSeenAt=performance.now();if(!l.fist)return {arm:false,dir:'STOP',msg:'Close LEFT hand into a fist'};
 if(!r.point)return {arm:false,dir:'STOP',msg:'Point with RIGHT index finger'};
 const v=headRelative(diff(r.index,r.base),pose.transform.orientation);const n=length(v)||1;const d={x:v.x/n,y:v.y/n,z:v.z/n};
 let direction='STOP';if(d.y<-.52)direction='BACK';else if(d.x> .5)direction='RIGHT';else if(d.x<-.5)direction='LEFT';else if(d.z<-.38)direction='FORWARD';
 return {arm:true,dir:direction,msg:direction==='STOP'?'Point more clearly':'ARMED · '+direction};}
function xrFrame(t,frame){if(!xr)return;xr.requestAnimationFrame(xrFrame);const pose=frame.getViewerPose(reference);if(!pose)return;
 let g={arm:false,dir:'STOP',msg:'Waiting for hand tracking'};try{g=recognize(frame,pose)}catch(e){g.msg='Tracking error: '+e.message}
 if(!g.arm||g.dir==='STOP'||estop){if(xrArm){xrArm=false;stopDrive()}}else if(!xrArm){xrArm=true;xrArmStart=t;desired='STOP'}else if(t-xrArmStart>300)desired=g.dir;
 if(xrArm&&desired!=='STOP'&&t-frameLast>170){frameLast=t;sendPulse()}
 if(t-frameLast>6000&&!handSeenAt){/* we keep display active; Quest system button can exit */}
 const text=g.arm?(g.dir==='STOP'?'READY · AIM YOUR FINGER':g.dir):'STOP';if(hud&&text!==detected){detected=text;hud.paint(text,g.msg+(connected?' · XGO ONLINE':' · LINK LOST'))}
 const layer=xr.renderState.baseLayer;gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);gl.clearColor(0,0,0,0);for(const view of pose.views){const v=layer.getViewport(view);gl.viewport(v.x,v.y,v.width,v.height);gl.clear(gl.COLOR_BUFFER_BIT);hud.draw(view.projectionMatrix)}
}
async function stopXR(){stopDrive();xr=null;reference=null;hud=null;gl=null;$('#enterXR').disabled=false;$('#enterXR').textContent='ENTER QUEST PASSTHROUGH';message('Quest mode ended. Movement stopped.')}
async function enterXR(){if(!paired||!connected)return message('Connect and test the robot in normal browser mode first.',true);if(estop)return message('Reset E-STOP first.',true);if(!navigator.xr)return message('WebXR not supported; use the on-screen control pad.',true);$('#enterXR').disabled=true;try{
 const canvas=$('#xrCanvas');const context=canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});if(!context)throw Error('WebGL unavailable');
 const sessionPromise=navigator.xr.requestSession('immersive-ar',{requiredFeatures:['local'],optionalFeatures:['hand-tracking']});
 if(context.makeXRCompatible)await context.makeXRCompatible();
 const sessionXR=await sessionPromise;xr=sessionXR;gl=context;xr.addEventListener('end',stopXR,{once:true});xr.addEventListener('visibilitychange',()=>{if(xr.visibilityState!=='visible')stopDrive()});
 xr.updateRenderState({baseLayer:new XRWebGLLayer(xr,gl,{alpha:true,depth:false,antialias:false})});reference=await xr.requestReferenceSpace('local');hud=createHUD(gl);handSeenAt=0;xrArm=false;xr.requestAnimationFrame(xrFrame);$('#enterXR').textContent='IN PASSTHROUGH';
 }catch(e){if(xr)try{await xr.end()}catch(_){}xr=null;$('#enterXR').disabled=false;message('Passthrough unavailable: '+e.message+'. You can still drive from this page.',true)}}
$('#enterXR').addEventListener('click',enterXR);
async function xrSupport(){if(!navigator.xr){$('#xrBadge').textContent='NO WEBXR';$('#xrHelp').textContent='Use the manual controller above. On Quest 3, open Meta Quest Browser.';return}try{let ok=await navigator.xr.isSessionSupported('immersive-ar');$('#xrBadge').textContent=ok?'PASSTHROUGH AVAILABLE':'UNAVAILABLE';$('#enterXR').disabled=!ok;$('#xrHelp').textContent=ok?'Only enter after you have confirmed the dog moves with the manual controls. Use the Meta button to leave XR.':'Passthrough not supported in this browser. Manual controls remain available.'}catch(e){$('#xrHelp').textContent='Could not check passthrough: '+e.message}}
(async()=>{await xrSupport();await findRobot();await poll();setInterval(async()=>{await findRobot();await poll()},3500)})();
