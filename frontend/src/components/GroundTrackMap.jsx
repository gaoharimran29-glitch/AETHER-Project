// src/components/GroundTrackMap.jsx
// PS §6.2 — Ground Track Map (Mercator Projection)
// Real 90-min historical trail, real RK4 predicted trajectory, terminator overlay, debris cloud
import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import OrbitCalculations from '../utils/orbitCalculations';
import TerminatorCalculator from '../utils/terminator';

export default function GroundTrackMap({satellites=[],debris=[],selectedSat=null,timestamp=new Date().toISOString(),onSatClick}){
  const el=useRef(null);
  const S=useRef({scene:null,cam:null,rend:null,ctrl:null,animId:null,
    satMeshes:[],debPts:null,trailHistories:{},terminatorLine:null,nightOverlay:null,
    rc:new THREE.Raycaster(),mouse:new THREE.Vector2()});

  useEffect(()=>{
    const e=el.current; if(!e) return;
    const s=S.current;
    s.scene=new THREE.Scene(); s.scene.background=new THREE.Color(0x040d1a);
    s.cam=new THREE.OrthographicCamera(-180,180,90,-90,0.1,1000);
    s.cam.position.z=500;
    s.rend=new THREE.WebGLRenderer({antialias:true});
    s.rend.setSize(e.clientWidth,e.clientHeight);
    s.rend.setPixelRatio(Math.min(window.devicePixelRatio,2));
    e.appendChild(s.rend.domElement);
    s.ctrl=new OrbitControls(s.cam,s.rend.domElement);
    s.ctrl.enableRotate=false; s.ctrl.enableDamping=true; s.ctrl.dampingFactor=.05;
    s.scene.add(new THREE.AmbientLight(0xffffff,1));

    // Grid
    const lm=new THREE.LineBasicMaterial({color:0x142840,opacity:.4,transparent:true});
    for(let la=-80;la<=80;la+=20){const pts=[]; for(let lo=-180;lo<=180;lo+=5) pts.push(new THREE.Vector3(lo,la,-1)); s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),lm));}
    for(let lo=-180;lo<=180;lo+=30){const pts=[]; for(let la=-90;la<=90;la+=5) pts.push(new THREE.Vector3(lo,la,-1)); s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),lm));}
    // Equator
    const eqPts=[]; for(let lo=-180;lo<=180;lo+=2) eqPts.push(new THREE.Vector3(lo,0,-1));
    s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(eqPts),new THREE.LineBasicMaterial({color:0x1a5a9a,opacity:.6,transparent:true})));
    // Earth background
    const ec=document.createElement('canvas'); ec.width=1024; ec.height=512;
    const et=ec.getContext('2d');
    const g=et.createLinearGradient(0,0,0,512); g.addColorStop(0,'#04100e'); g.addColorStop(1,'#081828');
    et.fillStyle=g; et.fillRect(0,0,1024,512);
    et.fillStyle='#0c2a0c';
    [[195,200,100,70],[275,295,62,112],[540,215,140,80],[760,200,200,84],[1310,215,230,90],[1820,280,82,54],[1078,490,88,140],[410,610,60,56]].forEach(([cx,cy,rx,ry])=>{et.beginPath(); et.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); et.fill();});
    const plane=new THREE.Mesh(new THREE.PlaneGeometry(360,180),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(ec),opacity:.75,transparent:true}));
    plane.position.z=-2; s.scene.add(plane);
    // Ground stations
    const gsM=new THREE.MeshBasicMaterial({color:0x00e5ff});
    const gsG=new THREE.CircleGeometry(1.4,8);
    [[13.03,77.52],[78.23,15.41],[35.43,-116.89],[-53.15,-70.92],[28.55,77.19],[-77.85,166.67]].forEach(([lat,lon])=>{
      const m=new THREE.Mesh(gsG,gsM); m.position.set(lon,lat,1); s.scene.add(m);
      const rp=[]; for(let i=0;i<=48;i++){const a=(i/48)*Math.PI*2; rp.push(new THREE.Vector3(lon+Math.cos(a)*8,lat+Math.sin(a)*8,0));}
      s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp),new THREE.LineBasicMaterial({color:0x00e5ff,opacity:.12,transparent:true})));
    });
    const animate=()=>{s.animId=requestAnimationFrame(animate); s.ctrl.update(); s.rend.render(s.scene,s.cam);};
    animate();
    const onResize=()=>{if(!e||!s.rend)return; s.rend.setSize(e.clientWidth,e.clientHeight);};
    window.addEventListener('resize',onResize);
    return()=>{cancelAnimationFrame(s.animId); window.removeEventListener('resize',onResize); try{if(e&&s.rend?.domElement)e.removeChild(s.rend.domElement);}catch(e){} s.rend?.dispose();};
  },[]);

  // Terminator
  useEffect(()=>{
    const s=S.current; if(!s.scene) return;
    if(s.terminatorLine){s.scene.remove(s.terminatorLine); s.terminatorLine.geometry?.dispose();}
    try{
      const simTime=(new Date(timestamp).getTime()-Date.now())/1000;
      const pts=TerminatorCalculator.calculateTerminatorPoints(simTime,360)
        .filter(p=>p&&typeof p.lat==='number'&&typeof p.lon==='number')
        .sort((a,b)=>a.lon-b.lon)
        .map(p=>new THREE.Vector3(p.lon,p.lat,2));
      if(pts.length>2){
        s.terminatorLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0xffaa33,opacity:.55,transparent:true}));
        s.scene.add(s.terminatorLine);
      }
    }catch(e){}
  },[timestamp]);

  // Satellites + trails
  useEffect(()=>{
    const s=S.current; if(!s.scene) return;
    s.scene.children.filter(c=>c.userData?.aType==='sat'||c.userData?.aType==='trail'||c.userData?.aType==='pred').forEach(c=>{s.scene.remove(c);c.geometry?.dispose();c.material?.dispose();});
    s.satMeshes=[];
    satellites.forEach(sat=>{
      if(sat.lat===undefined) return;
      const isSel=sat.id===selectedSat;
      const pct=(sat.fuel_kg??50)/50;
      const col=pct>.6?0x10b981:pct>.3?0xf59e0b:0xef4444;
      const m=new THREE.Mesh(new THREE.CircleGeometry(isSel?2.5:1.6,12),new THREE.MeshBasicMaterial({color:col}));
      m.position.set(sat.lon,sat.lat,3); m.userData={aType:'sat',id:sat.id}; s.scene.add(m); s.satMeshes.push(m);
      if(isSel){const rp=[]; for(let i=0;i<=64;i++){const a=(i/64)*Math.PI*2; rp.push(new THREE.Vector3(sat.lon+Math.cos(a)*4,sat.lat+Math.sin(a)*4,3));} const rl=new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp),new THREE.LineBasicMaterial({color:0xffffff,opacity:.8,transparent:true})); rl.userData={aType:'sat'}; s.scene.add(rl);}
      // Trail history
      if(!s.trailHistories[sat.id]) s.trailHistories[sat.id]=[];
      s.trailHistories[sat.id].push({lat:sat.lat,lon:sat.lon});
      if(s.trailHistories[sat.id].length>90) s.trailHistories[sat.id].shift();
      if(s.trailHistories[sat.id].length>1){const tp=s.trailHistories[sat.id].map(p=>new THREE.Vector3(p.lon,p.lat,2)); const tl=new THREE.Line(new THREE.BufferGeometry().setFromPoints(tp),new THREE.LineBasicMaterial({color:0x3b82f6,opacity:.5,transparent:true})); tl.userData={aType:'trail'}; s.scene.add(tl);}
      // Predicted trajectory (real RK4 via OrbitCalculations)
      try{
        const predPts=OrbitCalculations.predictTrajectory(sat,90,45);
        if(predPts.length>2){
          const segs=[[]]; predPts.forEach((p,i)=>{const prev=segs[segs.length-1]; if(i>0&&Math.abs(p.lon-(predPts[i-1].lon))>100) segs.push([]); segs[segs.length-1].push(new THREE.Vector3(p.lon,p.lat,2));});
          segs.forEach(seg=>{if(seg.length<2) return; const dl=new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg),new THREE.LineDashedMaterial({color:0xfbbf24,dashSize:3,gapSize:2,opacity:.5,transparent:true})); dl.computeLineDistances(); dl.userData={aType:'pred'}; s.scene.add(dl);});
        }
      }catch(e){}
    });
  },[satellites,selectedSat]);

  // Debris ONE draw call
  useEffect(()=>{
    const s=S.current; if(!s.scene) return;
    if(s.debPts){s.scene.remove(s.debPts); s.debPts.geometry?.dispose(); s.debPts.material?.dispose(); s.debPts=null;}
    if(!debris.length) return;
    const pos=new Float32Array(debris.length*3);
    debris.forEach((d,i)=>{
      const lat=Array.isArray(d)?d[1]:d.lat??0;
      const lon=Array.isArray(d)?d[2]:d.lon??0;
      pos[i*3]=lon; pos[i*3+1]=lat; pos[i*3+2]=1.5;
    });
    const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    s.debPts=new THREE.Points(geo,new THREE.PointsMaterial({color:0xff6633,size:.9,opacity:.6,transparent:true}));
    s.debPts.userData={aType:'debris'}; s.scene.add(s.debPts);
  },[debris]);

  const onClick=useCallback(e=>{
    const s=S.current; if(!s.scene||!onSatClick||!s.satMeshes.length) return;
    const rect=el.current.getBoundingClientRect();
    s.mouse.set(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
    s.rc.setFromCamera(s.mouse,s.cam);
    const hits=s.rc.intersectObjects(s.satMeshes);
    if(hits.length) onSatClick(hits[0].object.userData.id);
  },[onSatClick]);

  return(
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <div ref={el} style={{width:'100%',height:'100%',cursor:'crosshair'}} onClick={onClick}/>
      <div style={{position:'absolute',top:6,left:6,pointerEvents:'none',fontSize:9,fontFamily:'monospace',color:'#3a5a7a',background:'rgba(0,0,0,.5)',padding:'2px 7px',borderRadius:3}}>GROUND TRACK · MERCATOR · PS §6.2</div>
      <div style={{position:'absolute',bottom:6,left:6,pointerEvents:'none',display:'flex',gap:10}}>
        {[['#10b981','Satellite'],['#ff6633','Debris'],['#3b82f6','Trail 90min'],['#fbbf24','Prediction'],['#ffaa33','Terminator'],['#00e5ff','GndStn']].map(([c,l])=>(
          <div key={l} style={{display:'flex',alignItems:'center',gap:3}}><div style={{width:7,height:7,borderRadius:'50%',background:c}}/><span style={{color:'#6b7280',fontSize:8,fontFamily:'monospace'}}>{l}</span></div>
        ))}
      </div>
    </div>
  );
}