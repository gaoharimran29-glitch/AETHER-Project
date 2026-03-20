// src/components/ThreeScene.jsx
// PS §6.1 — WebGL 3D globe: 50+ sats + 10k+ debris at 60 FPS
// Uses THREE.js with OrbitControls; single-draw-call debris Points geometry
import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

const RE = 6378.137, SC = 1/RE;

function ll2v(lat, lon, altKm = 0) {
  const r = (RE + altKm) * SC;
  const phi = (90 - lat) * Math.PI / 180;
  const th  = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(th),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(th)
  );
}

function fuelHex(kg, max = 50) {
  const p = kg / max;
  if (p > 0.6) return 0x10b981;
  if (p > 0.3) return 0xf59e0b;
  if (p > 0.1) return 0xf97316;
  return 0xef4444;
}

const GS_POS = [
  [13.03,77.52],[78.23,15.41],[35.43,-116.89],
  [-53.15,-70.92],[28.55,77.19],[-77.85,166.67],
];

export default function ThreeScene({ satellites=[], debris=[], selectedSat=null, onSatelliteClick }) {
  const el   = useRef(null);
  const S    = useRef({
    scene:null,cam:null,rend:null,ctrl:null,animId:null,
    satMeshes:[],debPts:null,trails:{},
    rc:new THREE.Raycaster(),mouse:new THREE.Vector2(),
  });

  // Build the scene once
  useEffect(() => {
    const e = el.current;
    if (!e) return;
    const s = S.current;

    // Scene
    s.scene = new THREE.Scene();
    s.scene.background = new THREE.Color(0x010810);

    // Stars (single draw call)
    const stBuf = new Float32Array(12000);
    for (let i = 0; i < 12000; i++) stBuf[i] = (Math.random() - 0.5) * 600;
    const stGeo = new THREE.BufferGeometry();
    stGeo.setAttribute('position', new THREE.BufferAttribute(stBuf, 3));
    s.scene.add(new THREE.Points(stGeo, new THREE.PointsMaterial({ color:0xffffff, size:0.08, sizeAttenuation:true })));

    // Camera
    s.cam = new THREE.PerspectiveCamera(42, e.clientWidth/e.clientHeight, 0.01, 600);
    s.cam.position.set(0, 0, 3.6);

    // Renderer
    s.rend = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
    s.rend.setSize(e.clientWidth, e.clientHeight);
    s.rend.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    s.rend.outputColorSpace = THREE.SRGBColorSpace;
    s.rend.toneMapping = THREE.ACESFilmicToneMapping;
    s.rend.toneMappingExposure = 1.15;
    e.appendChild(s.rend.domElement);

    // Controls
    s.ctrl = new OrbitControls(s.cam, s.rend.domElement);
    s.ctrl.enableDamping = true;
    s.ctrl.dampingFactor = 0.04;
    s.ctrl.autoRotate    = true;
    s.ctrl.autoRotateSpeed = 0.2;
    s.ctrl.minDistance = 1.15;
    s.ctrl.maxDistance = 15;

    // Lighting
    s.scene.add(new THREE.AmbientLight(0x1a2a4a, 0.8));
    const sun = new THREE.DirectionalLight(0xfff5e0, 2.5);
    sun.position.set(6, 2, 4);
    s.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x3366ff, 0.25);
    rim.position.set(-5, -2, -4);
    s.scene.add(rim);

    // Earth — procedural canvas texture
    const ec = document.createElement('canvas');
    ec.width = 2048; ec.height = 1024;
    const et = ec.getContext('2d');
    // Ocean
    const og = et.createLinearGradient(0,0,0,1024);
    og.addColorStop(0, '#04122a'); og.addColorStop(0.5, '#071e3d'); og.addColorStop(1, '#04122a');
    et.fillStyle = og; et.fillRect(0,0,2048,1024);
    // Grid lines
    et.strokeStyle = 'rgba(18,65,130,0.18)'; et.lineWidth = 0.6;
    for (let la=-75;la<=75;la+=15) { const y=((90-la)/180)*1024; et.beginPath(); et.moveTo(0,y); et.lineTo(2048,y); et.stroke(); }
    for (let lo=-180;lo<=180;lo+=15) { const x=((lo+180)/360)*2048; et.beginPath(); et.moveTo(x,0); et.lineTo(x,1024); et.stroke(); }
    // Equator
    et.strokeStyle='rgba(35,120,220,0.45)'; et.lineWidth=1.5;
    et.beginPath(); et.moveTo(0,512); et.lineTo(2048,512); et.stroke();
    // Continents (approximate polygons)
    et.fillStyle = '#102a10';
    const conts = [[380,300,110,75],[285,330,68,125],[830,265,155,88],
                   [1220,230,255,95],[1640,260,295,100],[1835,300,88,60],
                   [1080,490,90,145],[415,610,62,58],[960,350,45,55]];
    conts.forEach(([cx,cy,rx,ry]) => { et.beginPath(); et.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); et.fill(); });
    // Continent borders
    et.strokeStyle = 'rgba(28,130,55,0.35)'; et.lineWidth = 2;
    conts.forEach(([cx,cy,rx,ry]) => { et.beginPath(); et.ellipse(cx,cy,rx+3,ry+3,0,0,Math.PI*2); et.stroke(); });
    // Polar ice caps
    et.fillStyle = 'rgba(220,240,255,0.35)';
    et.beginPath(); et.ellipse(1024,40,200,40,0,0,Math.PI*2); et.fill();
    et.beginPath(); et.ellipse(1024,984,180,40,0,0,Math.PI*2); et.fill();

    const earthMat = new THREE.MeshPhongMaterial({
      map:      new THREE.CanvasTexture(ec),
      shininess: 8,
      specular:  new THREE.Color(0x1a3a66),
    });
    s.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 72, 72), earthMat));

    // Atmosphere glow shader
    s.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 64), new THREE.ShaderMaterial({
      vertexShader:   `varying float vi; void main(){vec3 vn=normalize(normalMatrix*normal);vi=pow(max(0.,.75-dot(vn,vec3(0,0,1))),2.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying float vi; void main(){gl_FragColor=vec4(.1,.45,1.,vi*.55);}`,
      side:THREE.FrontSide, blending:THREE.AdditiveBlending, transparent:true, depthWrite:false,
    })));

    // Night-side shadow shader (terminator)
    const sunDir = new THREE.Vector3(0.75, 0.28, 0.6).normalize();
    s.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.006, 64, 64), new THREE.ShaderMaterial({
      uniforms: { sd:{ value:sunDir } },
      vertexShader:   `varying vec3 vp; void main(){vp=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform vec3 sd; varying vec3 vp; void main(){float d=dot(vp,sd);float s=smoothstep(-.06,.1,-d);gl_FragColor=vec4(0.,.01,.05,s*.85);}`,
      transparent:true, depthWrite:false, blending:THREE.NormalBlending,
    })));

    // Terminator line
    const tv = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0,1,0)).normalize();
    const tw = new THREE.Vector3().crossVectors(sunDir, tv).normalize();
    const tPts = [];
    for (let i=0;i<=128;i++) {
      const a=(i/128)*Math.PI*2;
      tPts.push(new THREE.Vector3(tv.x*Math.cos(a)+tw.x*Math.sin(a),tv.y*Math.cos(a)+tw.y*Math.sin(a),tv.z*Math.cos(a)+tw.z*Math.sin(a)).normalize().multiplyScalar(1.004));
    }
    s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tPts), new THREE.LineBasicMaterial({ color:0xffaa33, opacity:.55, transparent:true })));

    // Equator ring
    const eqPts=[]; for(let i=0;i<=128;i++){const a=(i/128)*Math.PI*2; eqPts.push(new THREE.Vector3(Math.cos(a),0,Math.sin(a)).multiplyScalar(1.003));}
    s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(eqPts), new THREE.LineBasicMaterial({ color:0x1a5a9a, opacity:.3, transparent:true })));

    // Ground stations
    GS_POS.forEach(([lat,lon]) => {
      const pos = ll2v(lat, lon, 8);
      const gsm = new THREE.Mesh(new THREE.SphereGeometry(.009,8,8), new THREE.MeshBasicMaterial({ color:0x00e5ff }));
      gsm.position.copy(pos);
      s.scene.add(gsm);
      // Coverage ring
      const rp=[]; for(let i=0;i<=48;i++){const a=(i/48)*Math.PI*2; rp.push(ll2v(lat+8*Math.cos(a),lon+8*Math.sin(a),8));}
      s.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp), new THREE.LineBasicMaterial({ color:0x00e5ff, opacity:.08, transparent:true })));
    });

    // Animate
    const animate = () => {
      s.animId = requestAnimationFrame(animate);
      s.ctrl.update();
      s.rend.render(s.scene, s.cam);
    };
    animate();

    const onResize = () => {
      if (!e || !s.rend) return;
      s.cam.aspect = e.clientWidth / e.clientHeight;
      s.cam.updateProjectionMatrix();
      s.rend.setSize(e.clientWidth, e.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(s.animId);
      window.removeEventListener('resize', onResize);
      try { if (e && s.rend?.domElement) e.removeChild(s.rend.domElement); } catch {}
      s.rend?.dispose();
    };
  }, []);

  // Satellites + trails update
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    s.scene.children.filter(c => c.userData?.aType === 'sat' || c.userData?.aType === 'trail').forEach(c => {
      s.scene.remove(c); c.geometry?.dispose(); c.material?.dispose();
    });
    s.satMeshes = [];

    satellites.forEach(sat => {
      if (sat.lat == null) return;
      const pos  = ll2v(sat.lat, sat.lon, sat.alt_km ?? 550);
      const isSel = sat.id === selectedSat;
      const col   = fuelHex(sat.fuel_kg ?? 50);

      // Glow sphere
      const gm = new THREE.Mesh(new THREE.SphereGeometry(isSel?.034:.02,12,12), new THREE.MeshBasicMaterial({ color:col, transparent:true, opacity:.25 }));
      gm.position.copy(pos); gm.userData = { aType:'sat' }; s.scene.add(gm);
      // Core
      const cm = new THREE.Mesh(new THREE.SphereGeometry(isSel?.018:.012,10,10), new THREE.MeshBasicMaterial({ color:col }));
      cm.position.copy(pos); cm.userData = { aType:'sat', id:sat.id }; s.scene.add(cm); s.satMeshes.push(cm);
      // Selection ring
      if (isSel) {
        const rp=[]; for(let i=0;i<=64;i++){const a=(i/64)*Math.PI*2; rp.push(new THREE.Vector3(Math.cos(a)*.045,0,Math.sin(a)*.045));}
        const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp), new THREE.LineBasicMaterial({ color:0xffffff, opacity:.9, transparent:true }));
        rl.position.copy(pos); rl.lookAt(0,0,0); rl.userData = { aType:'sat' }; s.scene.add(rl);
      }
      // Trail
      if (!s.trails[sat.id]) s.trails[sat.id] = [];
      s.trails[sat.id].push(pos.clone());
      if (s.trails[sat.id].length > 180) s.trails[sat.id].shift();
      if (s.trails[sat.id].length > 2) {
        const tl = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(s.trails[sat.id]),
          new THREE.LineBasicMaterial({ color:isSel?0x60a0ff:0x1e4080, opacity:.45, transparent:true })
        );
        tl.userData = { aType:'trail' }; s.scene.add(tl);
      }
    });
  }, [satellites, selectedSat]);

  // Debris — single draw call (PS §6.1 performance requirement)
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    if (s.debPts) { s.scene.remove(s.debPts); s.debPts.geometry?.dispose(); s.debPts.material?.dispose(); s.debPts=null; }
    if (!debris.length) return;
    const pos = new Float32Array(debris.length * 3);
    debris.forEach((d, i) => {
      const lat = Array.isArray(d) ? d[1] : (d.lat ?? 0);
      const lon = Array.isArray(d) ? d[2] : (d.lon ?? 0);
      const alt = Array.isArray(d) ? (d[3] ?? 400) : (d.alt_km ?? 400);
      const v = ll2v(lat, lon, alt);
      pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    s.debPts = new THREE.Points(geo, new THREE.PointsMaterial({ color:0xff6622, size:.007, sizeAttenuation:true, transparent:true, opacity:.65 }));
    s.debPts.userData = { aType:'debris' };
    s.scene.add(s.debPts);
  }, [debris]);

  const onClick = useCallback(e => {
    const s = S.current;
    if (!s.scene || !onSatelliteClick || !s.satMeshes.length) return;
    const rect = el.current.getBoundingClientRect();
    s.mouse.set(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1);
    s.rc.setFromCamera(s.mouse, s.cam);
    const hits = s.rc.intersectObjects(s.satMeshes);
    if (hits.length) { onSatelliteClick(hits[0].object.userData.id); s.ctrl.autoRotate = false; }
  }, [onSatelliteClick]);

  return (
    <div style={{ position:'relative', width:'100%', height:'100%' }}>
      <div ref={el} style={{ width:'100%', height:'100%', cursor:'grab' }} onClick={onClick} />
      {/* Legend overlay */}
      <div style={{ position:'absolute', top:8, left:8, pointerEvents:'none', fontFamily:"'Orbitron',sans-serif", fontSize:8, color:'#2a4a6a', background:'rgba(1,8,20,.7)', padding:'4px 10px', borderRadius:3, border:'1px solid rgba(30,80,160,0.25)', letterSpacing:'0.1em' }}>
        AETHER · 3D ORBITAL VIEW ·
      </div>
      <div style={{ position:'absolute', bottom:8, right:8, pointerEvents:'none', display:'flex', flexDirection:'column', gap:4 }}>
        {[['#10b981','Fuel >60%'],['#f59e0b','Fuel 30–60%'],['#ef4444','Fuel <10%'],['#ff6622','Debris'],['#00e5ff','Gnd Station'],['#ffaa33','Terminator']].map(([c,l]) => (
          <div key={l} style={{ display:'flex', alignItems:'center', gap:5 }}>
            <div style={{ width:7, height:7, borderRadius:'50%', background:c }} />
            <span style={{ color:'#4a6a8a', fontSize:8, fontFamily:"'Share Tech Mono',monospace" }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}