// src/components/ThreeScene.jsx
// PS §6.1 — WebGL 3D globe: 50+ sats + 10k+ debris at 60 FPS
// PS §6.2 — fuel-color markers, 90-min trails, atmosphere, terminator shadow
import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

const RE=6378.137, SC=1/RE;
function llv(lat,lon,altKm=0){
  const r=(RE+altKm)*SC, phi=(90-lat)*Math.PI/180, th=(lon+180)*Math.PI/180;
  return new THREE.Vector3(-r*Math.sin(phi)*Math.cos(th), r*Math.cos(phi), r*Math.sin(phi)*Math.sin(th));
}
function fuelCol(kg,max=50){ const p=kg/max; return p>0.6?0x10b981:p>0.3?0xf59e0b:p>0.1?0xf97316:0xef4444; }

const GS=[[13.03,77.52],[78.23,15.41],[35.43,-116.89],[-53.15,-70.92],[28.55,77.19],[-77.85,166.67]];

export default function ThreeScene({satellites=[],debris=[],selectedSat=null,onSatelliteClick}){
  const el=useRef(null);
  const S=useRef({scene:null,cam:null,rend:null,ctrl:null,animId:null,
    satMeshes:[],debPts:null,trails:{},
    rc:new THREE.Raycaster(),mouse:new THREE.Vector2()});

  useEffect(()=>{
    const e=el.current; if(!e) return;
    const s=S.current;
    s.scene=new THREE.Scene(); s.scene.background=new THREE.Color(0x020810);
    // Stars
    const sb=new Float32Array(9000); for(let i=0;i<9000;i++) sb[i]=(Math.random()-.5)*400;
    const sg=new THREE.BufferGeometry(); sg.setAttribute('position',new THREE.BufferAttribute(sb,3));
    s.scene.add(new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:0.11,sizeAttenuation:true})));
    // Camera
    s.cam=new THREE.PerspectiveCamera(45,e.clientWidth/e.clientHeight,0.01,500);
    s.cam.position.set(0,0,3.8);
    // Renderer
    s.rend=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    s.rend.setSize(e.clientWidth,e.clientHeight);
    s.rend.setPixelRatio(Math.min(window.devicePixelRatio,2));
    s.rend.outputColorSpace=THREE.SRGBColorSpace;
    s.rend.toneMapping=THREE.ACESFilmicToneMapping;
    s.rend.toneMappingExposure=1.1;
    e.appendChild(s.rend.domElement);
    // Controls
    s.ctrl=new OrbitControls(s.cam,s.rend.domElement);
    s.ctrl.enableDamping=true; s.ctrl.dampingFactor=0.04;
    s.ctrl.autoRotate=true; s.ctrl.autoRotateSpeed=0.25;
    s.ctrl.minDistance=1.2; s.ctrl.maxDistance=12;
    // Lights
    s.scene.add(new THREE.AmbientLight(0x223366,0.7));
    const sun=new THREE.DirectionalLight(0xfff8e0,2.2); sun.position.set(5,2,4); s.scene.add(sun);
    const rim=new THREE.DirectionalLight(0x4488ff,0.3); rim.position.set(-5,-1,-3); s.scene.add(rim);

    // Earth procedural texture
    const ec=document.createElement('canvas'); ec.width=2048; ec.height=1024;
    const et=ec.getContext('2d');
    const og=et.createLinearGradient(0,0,0,1024);
    og.addColorStop(0,'#07122a'); og.addColorStop(.5,'#0b1f40'); og.addColorStop(1,'#07122a');
    et.fillStyle=og; et.fillRect(0,0,2048,1024);
    et.strokeStyle='rgba(18,65,125,0.22)'; et.lineWidth=0.7;
    for(let la=-80;la<=80;la+=15){const y=((90-la)/180)*1024; et.beginPath(); et.moveTo(0,y); et.lineTo(2048,y); et.stroke();}
    for(let lo=-180;lo<=180;lo+=15){const x=((lo+180)/360)*2048; et.beginPath(); et.moveTo(x,0); et.lineTo(x,1024); et.stroke();}
    et.strokeStyle='rgba(35,110,210,0.45)'; et.lineWidth=1.4;
    et.beginPath(); et.moveTo(0,512); et.lineTo(2048,512); et.stroke();
    et.fillStyle='#102410';
    [[380,300,105,75],[285,330,68,125],[830,265,155,88],[1220,230,255,95],
     [1640,260,295,100],[1835,300,88,60],[1080,490,90,145],[415,610,62,58]
    ].forEach(([cx,cy,rx,ry])=>{et.beginPath(); et.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); et.fill();});
    et.strokeStyle='rgba(28,120,55,0.32)'; et.lineWidth=2.2;
    [[382,302,108,78],[287,332,71,128],[833,267,158,91],[1222,232,258,98],
     [1642,262,298,103],[1837,302,91,63],[1082,492,93,148],[417,612,65,61]
    ].forEach(([cx,cy,rx,ry])=>{et.beginPath(); et.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); et.stroke();});
    s.scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1,72,72),
      new THREE.MeshPhongMaterial({map:new THREE.CanvasTexture(ec),shininess:10,specular:new THREE.Color(0x1a3a66)})
    ));
    // Atmosphere
    s.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.055,64,64),new THREE.ShaderMaterial({
      vertexShader:`varying float vi; void main(){vec3 vn=normalize(normalMatrix*normal);vi=pow(.72-dot(vn,vec3(0,0,1)),2.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`varying float vi; void main(){float i=.45*vi;gl_FragColor=vec4(.12,.45,1.,i*.65);}`,
      side:THREE.FrontSide,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false
    })));
    // Terminator night shadow
    const sunDir=new THREE.Vector3(.8,.3,.5).normalize();
    s.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.005,64,64),new THREE.ShaderMaterial({
      uniforms:{sd:{value:sunDir}},
      vertexShader:`varying vec3 vp; void main(){vp=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`uniform vec3 sd; varying vec3 vp; void main(){float d=dot(vp,sd);float s=smoothstep(-.08,.08,-d);gl_FragColor=vec4(0.,.01,.06,s*.82);}`,
      transparent:true,depthWrite:false,side:THREE.FrontSide,blending:THREE.NormalBlending
    })));
    // Terminator line
    const tv=new THREE.Vector3().crossVectors(sunDir,new THREE.Vector3(0,1,0)).normalize();
    const tw=new THREE.Vector3().crossVectors(sunDir,tv).normalize();
    const tPts=[];
    for(let i=0;i<=128;i++){const a=(i/128)*Math.PI*2; tPts.push(new THREE.Vector3(tv.x*Math.cos(a)+tw.x*Math.sin(a),tv.y*Math.cos(a)+tw.y*Math.sin(a),tv.z*Math.cos(a)+tw.z*Math.sin(a)).normalize().multiplyScalar(1.004));}
    s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tPts),new THREE.LineBasicMaterial({color:0xffaa33,opacity:.55,transparent:true})));
    // Equator
    const eqPts=[]; for(let i=0;i<=128;i++){const a=(i/128)*Math.PI*2; eqPts.push(new THREE.Vector3(Math.cos(a),0,Math.sin(a)).multiplyScalar(1.002));}
    s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(eqPts),new THREE.LineBasicMaterial({color:0x1a5a99,opacity:.3,transparent:true})));
    // Ground stations
    GS.forEach(([lat,lon])=>{
      const p=llv(lat,lon,8);
      const gsm=new THREE.Mesh(new THREE.SphereGeometry(.008,8,8),new THREE.MeshBasicMaterial({color:0x00e5ff})); gsm.position.copy(p); s.scene.add(gsm);
      const rp=[]; for(let i=0;i<=48;i++){const a=(i/48)*Math.PI*2; rp.push(llv(lat+7*Math.cos(a),lon+7*Math.sin(a),8));}
      s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp),new THREE.LineBasicMaterial({color:0x00e5ff,opacity:.1,transparent:true})));
    });
    // Animate
    const animate=()=>{s.animId=requestAnimationFrame(animate); s.ctrl.update(); s.rend.render(s.scene,s.cam);};
    animate();
    const onResize=()=>{if(!e||!s.rend)return; s.cam.aspect=e.clientWidth/e.clientHeight; s.cam.updateProjectionMatrix(); s.rend.setSize(e.clientWidth,e.clientHeight);};
    window.addEventListener('resize',onResize);
    return ()=>{cancelAnimationFrame(s.animId); window.removeEventListener('resize',onResize); try{if(e&&s.rend?.domElement)e.removeChild(s.rend.domElement);}catch(e){} s.rend?.dispose();};
  },[]);

  // Satellites + trails
  useEffect(()=>{
    const s=S.current; if(!s.scene) return;
    s.scene.children.filter(c=>c.userData?.at==='sat'||c.userData?.at==='trail').forEach(c=>{s.scene.remove(c);c.geometry?.dispose();c.material?.dispose();});
    s.satMeshes=[];
    satellites.forEach(sat=>{
      if(sat.lat===undefined) return;
      const pos=llv(sat.lat,sat.lon,sat.alt_km??550);
      const isSel=sat.id===selectedSat;
      const col=fuelCol(sat.fuel_kg??50);
      // Glow
      const gm=new THREE.Mesh(new THREE.SphereGeometry(isSel?.032:.018,12,12),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.28}));
      gm.position.copy(pos); gm.userData={at:'sat'}; s.scene.add(gm);
      // Core
      const cm=new THREE.Mesh(new THREE.SphereGeometry(isSel?.018:.011,10,10),new THREE.MeshBasicMaterial({color:col}));
      cm.position.copy(pos); cm.userData={at:'sat',id:sat.id}; s.scene.add(cm); s.satMeshes.push(cm);
      // Selection ring
      if(isSel){const rp=[]; for(let i=0;i<=64;i++){const a=(i/64)*Math.PI*2; rp.push(new THREE.Vector3(Math.cos(a)*.04,0,Math.sin(a)*.04));} const rl=new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp),new THREE.LineBasicMaterial({color:0xffffff,opacity:.8,transparent:true})); rl.position.copy(pos); rl.lookAt(0,0,0); rl.userData={at:'sat'}; s.scene.add(rl);}
      // Trail
      if(!s.trails[sat.id]) s.trails[sat.id]=[];
      s.trails[sat.id].push(pos.clone());
      if(s.trails[sat.id].length>180) s.trails[sat.id].shift();
      if(s.trails[sat.id].length>2){const tl=new THREE.Line(new THREE.BufferGeometry().setFromPoints(s.trails[sat.id]),new THREE.LineBasicMaterial({color:isSel?0x60a0ff:0x1e4080,opacity:.42,transparent:true})); tl.userData={at:'trail'}; s.scene.add(tl);}
    });
  },[satellites,selectedSat]);

  // Debris — ONE draw call
  useEffect(()=>{
    const s=S.current; if(!s.scene) return;
    if(s.debPts){s.scene.remove(s.debPts); s.debPts.geometry?.dispose(); s.debPts.material?.dispose(); s.debPts=null;}
    if(!debris.length) return;
    const pos=new Float32Array(debris.length*3);
    debris.forEach((d,i)=>{
      const lat=Array.isArray(d)?d[1]:d.lat??0;
      const lon=Array.isArray(d)?d[2]:d.lon??0;
      const alt=Array.isArray(d)?(d[3]??400):(d.alt_km??400);
      const v=llv(lat,lon,alt); pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
    });
    const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    s.debPts=new THREE.Points(geo,new THREE.PointsMaterial({color:0xff7733,size:.006,sizeAttenuation:true,transparent:true,opacity:.7}));
    s.debPts.userData={at:'debris'}; s.scene.add(s.debPts);
  },[debris]);

  const onClick=useCallback(e=>{
    const s=S.current; if(!s.scene||!onSatelliteClick||!s.satMeshes.length) return;
    const rect=el.current.getBoundingClientRect();
    s.mouse.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
    s.rc.setFromCamera(s.mouse,s.cam);
    const hits=s.rc.intersectObjects(s.satMeshes);
    if(hits.length){onSatelliteClick(hits[0].object.userData.id); S.current.ctrl.autoRotate=false;}
  },[onSatelliteClick]);

  return(
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <div ref={el} style={{width:'100%',height:'100%',cursor:'grab'}} onClick={onClick}/>
      <div style={{position:'absolute',top:8,left:8,pointerEvents:'none',fontFamily:'monospace',fontSize:9,color:'#4a6a8a',background:'rgba(0,0,0,.5)',padding:'3px 8px',borderRadius:4,border:'1px solid #1a3a5a'}}>
        AETHER · 3D ORBITAL VIEW · WebGL · PS §6.1
      </div>
      <div style={{position:'absolute',bottom:8,right:8,pointerEvents:'none',display:'flex',flexDirection:'column',gap:3}}>
        {[['#10b981','Fuel >60%'],['#f59e0b','Fuel 30%'],['#ef4444','Fuel <10%'],['#ff7733','Debris'],['#00e5ff','GndStn'],['#ffaa33','Terminator']].map(([c,l])=>(
          <div key={l} style={{display:'flex',alignItems:'center',gap:4}}><div style={{width:7,height:7,borderRadius:'50%',background:c}}/><span style={{color:'#6b7280',fontSize:8,fontFamily:'monospace'}}>{l}</span></div>
        ))}
      </div>
    </div>
  );
}