// src/components/GroundTrackMap.jsx
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

const GroundTrackMap = ({ 
  satellites = [], 
  selectedSat = null, 
  timestamp = new Date().toISOString() 
}) => {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const trailsRef = useRef({});
  const predictionLinesRef = useRef({});
  const animationFrameRef = useRef(null);

  // State for terminator line
  const [terminatorAngle, setTerminatorAngle] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    // --- SCENE SETUP ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c1a);
    sceneRef.current = scene;

    // --- CAMERA (Orthographic for 2D map view) ---
    const camera = new THREE.OrthographicCamera(
      -180, 180, 90, -90, 0.1, 1000
    );
    camera.position.z = 500;
    cameraRef.current = camera;

    // --- RENDERER ---
    const renderer = new THREE.WebGLRenderer({ 
      antialias: true,
      powerPreference: "high-performance"
    });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // --- CONTROLS (for panning/zooming) ---
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.enableRotate = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.zoomSpeed = 1.0;
    controls.panSpeed = 1.0;
    controls.maxZoom = 800;
    controls.minZoom = 200;
    controlsRef.current = controls;

    // --- LIGHTS ---
    const ambientLight = new THREE.AmbientLight(0x404060);
    scene.add(ambientLight);

    // --- CREATE BACKGROUND GRID (Lat/Lon lines) ---
    createGrid(scene);

    // --- CREATE EARTH MAP ---
    createEarthMap(scene);

    // --- CREATE TERMINATOR LINE (Day/Night boundary) ---
    const terminator = createTerminator(scene);
    terminator.rotation.z = terminatorAngle;

    // --- ANIMATION LOOP ---
    const animate = () => {
      if (!rendererRef.current || !sceneRef.current || !cameraRef.current || !controlsRef.current) return;

      controlsRef.current.update();
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animate();

    // --- CLEANUP ---
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  // --- UPDATE TERMINATOR BASED ON TIMESTAMP ---
  useEffect(() => {
    // Calculate terminator position based on time
    // Sun direction rotates ~15 degrees per hour
    const date = new Date(timestamp);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const totalHours = hours + minutes / 60;
    
    // 360° per 24 hours = 15° per hour
    // Offset so that at 12:00 UTC, terminator is at 0° (GMT)
    const angle = (totalHours * 15 - 180) * Math.PI / 180;
    
    setTerminatorAngle(angle);

    // Update terminator line rotation if it exists
    if (sceneRef.current) {
      const terminator = sceneRef.current.children.find(child => child.name === 'terminator');
      if (terminator) {
        terminator.rotation.z = angle;
      }
    }
  }, [timestamp]);

  // --- UPDATE SATELLITE POSITIONS AND TRAILS ---
  useEffect(() => {
    if (!sceneRef.current) return;

    // Remove old satellite markers and trails
    const toRemove = [];
    sceneRef.current.children.forEach(child => {
      if (child.userData.type === 'satellite' || 
          child.userData.type === 'trail' ||
          child.userData.type === 'prediction') {
        toRemove.push(child);
      }
    });
    toRemove.forEach(child => sceneRef.current.remove(child));

    // Add updated satellites
    satellites.forEach((sat, index) => {
      // Create satellite marker
      const marker = createSatelliteMarker(sat, sat.id === selectedSat);
      sceneRef.current.add(marker);

      // Create historical trail (last 90 minutes)
      const trail = createHistoricalTrail(sat, 90); // 90 minutes of history
      sceneRef.current.add(trail);

      // Create predicted trajectory (next 90 minutes)
      const prediction = createPredictedTrail(sat, 90); // 90 minutes prediction
      sceneRef.current.add(prediction);
    });

  }, [satellites, selectedSat]);

  // --- HELPER: Create lat/lon grid ---
  const createGrid = (scene) => {
    const material = new THREE.LineBasicMaterial({ color: 0x2a4a6a });

    // Latitude lines (parallels)
    for (let lat = -80; lat <= 80; lat += 10) {
      const points = [];
      for (let lon = -180; lon <= 180; lon += 5) {
        points.push(new THREE.Vector3(lon, lat, 1));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      line.userData.type = 'grid';
      scene.add(line);
    }

    // Longitude lines (meridians)
    for (let lon = -180; lon <= 180; lon += 15) {
      const points = [];
      for (let lat = -90; lat <= 90; lat += 5) {
        points.push(new THREE.Vector3(lon, lat, 1));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      line.userData.type = 'grid';
      scene.add(line);
    }

    // Equator (highlighted)
    const equatorPoints = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      equatorPoints.push(new THREE.Vector3(lon, 0, 2));
    }
    const equatorGeo = new THREE.BufferGeometry().setFromPoints(equatorPoints);
    const equatorLine = new THREE.Line(equatorGeo, new THREE.LineBasicMaterial({ color: 0x4a8aba }));
    equatorLine.userData.type = 'grid';
    scene.add(equatorLine);

    // Add country borders (simplified - just a few major outlines)
    addCountryBorders(scene);
  };

  // --- HELPER: Add simplified country borders ---
  const addCountryBorders = (scene) => {
    const borderMaterial = new THREE.LineBasicMaterial({ color: 0x3a6a9a, opacity: 0.3, transparent: true });
    
    // North America outline (simplified)
    const naPoints = [
      [-130, 50], [-110, 30], [-80, 25], [-70, 45], [-60, 40], [-50, 20],
      [-80, 10], [-100, 20], [-120, 30], [-130, 50]
    ].map(([lon, lat]) => new THREE.Vector3(lon, lat, 1));
    
    const naGeo = new THREE.BufferGeometry().setFromPoints(naPoints);
    const naLine = new THREE.Line(naGeo, borderMaterial);
    scene.add(naLine);

    // Eurasia outline (simplified)
    const euPoints = [
      [-10, 35], [30, 30], [60, 40], [100, 30], [140, 45], [130, 20],
      [100, 10], [70, 5], [40, 10], [10, 15], [-10, 35]
    ].map(([lon, lat]) => new THREE.Vector3(lon, lat, 1));
    
    const euGeo = new THREE.BufferGeometry().setFromPoints(euPoints);
    const euLine = new THREE.Line(euGeo, borderMaterial);
    scene.add(euLine);
  };

  // --- HELPER: Create Earth map texture ---
  const createEarthMap = (scene) => {
    // Create a canvas for the Earth texture
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // Fill with ocean blue
    ctx.fillStyle = '#1a4a7a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw continents (simplified green blobs)
    ctx.fillStyle = '#3a8a3a';
    
    // North America
    ctx.beginPath();
    ctx.ellipse(200, 200, 60, 40, 0, 0, 2 * Math.PI);
    ctx.fill();
    
    // South America
    ctx.beginPath();
    ctx.ellipse(300, 350, 40, 60, 0, 0, 2 * Math.PI);
    ctx.fill();
    
    // Europe/Africa
    ctx.beginPath();
    ctx.ellipse(550, 200, 80, 100, 0, 0, 2 * Math.PI);
    ctx.fill();
    
    // Asia
    ctx.beginPath();
    ctx.ellipse(750, 180, 120, 60, 0, 0, 2 * Math.PI);
    ctx.fill();
    
    // Australia
    ctx.beginPath();
    ctx.ellipse(900, 350, 50, 40, 0, 0, 2 * Math.PI);
    ctx.fill();

    // Add grid lines overlay
    ctx.strokeStyle = '#4a8aba';
    ctx.lineWidth = 0.5;
    
    // Latitude lines
    for (let i = 0; i <= 10; i++) {
      const y = (i / 10) * canvas.height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.strokeStyle = '#4a8aba40';
      ctx.stroke();
    }

    // Longitude lines
    for (let i = 0; i <= 20; i++) {
      const x = (i / 20) * canvas.width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.strokeStyle = '#4a8aba40';
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    
    // Create a plane with the texture
    const geometry = new THREE.PlaneGeometry(360, 180);
    const material = new THREE.MeshBasicMaterial({ 
      map: texture,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide
    });
    const earthPlane = new THREE.Mesh(geometry, material);
    earthPlane.position.z = 0;
    earthPlane.userData.type = 'earth';
    scene.add(earthPlane);
  };

  // --- HELPER: Create terminator line (day/night boundary) ---
  const createTerminator = (scene) => {
    const points = [];
    
    // Create a half-circle shadow
    for (let lat = -90; lat <= 90; lat += 2) {
      // Terminator is at 90° from sun, so we create a gradient shadow
      const lon = 90; // This will be rotated based on time
      points.push(new THREE.Vector3(lon, lat, 5));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0xffaa00, opacity: 0.3, transparent: true });
    const terminator = new THREE.Line(geometry, material);
    
    // Create a semi-transparent shadow area
    const shadowGeo = new THREE.PlaneGeometry(180, 180);
    const shadowMat = new THREE.MeshBasicMaterial({ 
      color: 0x000000, 
      opacity: 0.3,
      transparent: true,
      side: THREE.DoubleSide
    });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.position.set(90, 0, 4);
    shadow.rotation.y = Math.PI / 2;
    
    const group = new THREE.Group();
    group.add(terminator);
    group.add(shadow);
    group.name = 'terminator';
    group.userData.type = 'terminator';
    
    scene.add(group);
    return group;
  };

  // --- HELPER: Create satellite marker ---
  const createSatelliteMarker = (sat, isSelected) => {
    const group = new THREE.Group();

    // Main marker
    const geometry = new THREE.ConeGeometry(isSelected ? 4 : 2, isSelected ? 8 : 4, 8);
    const material = new THREE.MeshStandardMaterial({ 
      color: isSelected ? 0xffaa00 : 0x3b82f6,
      emissive: isSelected ? 0x442200 : 0x112244
    });
    const cone = new THREE.Mesh(geometry, material);
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 2;
    group.add(cone);

    // Glow effect
    const glowGeo = new THREE.SphereGeometry(isSelected ? 6 : 3, 16);
    const glowMat = new THREE.MeshBasicMaterial({ 
      color: isSelected ? 0xffaa00 : 0x3b82f6,
      transparent: true,
      opacity: 0.3
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.z = 1;
    group.add(glow);

    // Label background
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, 64, 32);
    ctx.strokeStyle = isSelected ? '#ffaa00' : '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 64, 32);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(sat.id.slice(-4), 8, 22);

    const texture = new THREE.CanvasTexture(canvas);
    const labelMat = new THREE.SpriteMaterial({ map: texture });
    const label = new THREE.Sprite(labelMat);
    label.scale.set(8, 4, 1);
    label.position.set(0, 8, 5);
    group.add(label);

    // Position on map
    group.position.set(sat.lon, sat.lat, 3);
    group.userData = { 
      type: 'satellite', 
      id: sat.id,
      fuel: sat.fuel_kg,
      status: sat.status
    };

    return group;
  };

  // --- HELPER: Create historical trail (last N minutes) ---
  const createHistoricalTrail = (sat, minutes) => {
    const points = [];
    const steps = 90; // Number of trail points
    
    // Simulate past positions (in reality, this would come from historical data)
    // For demo, we create an elliptical path behind current position
    for (let i = steps; i >= 0; i--) {
      const progress = i / steps;
      // Simple elliptical offset for trail
      const lonOffset = 5 * Math.sin(progress * Math.PI * 2);
      const latOffset = 3 * Math.cos(progress * Math.PI * 2);
      
      points.push(new THREE.Vector3(
        sat.lon - (minutes / 90) * 15 * progress + lonOffset,
        sat.lat + latOffset,
        2
      ));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0x8aba4a, opacity: 0.6, transparent: true });
    const line = new THREE.Line(geometry, material);
    line.userData = { type: 'trail', satelliteId: sat.id };
    
    return line;
  };

  // --- HELPER: Create predicted trajectory (next N minutes) ---
  const createPredictedTrail = (sat, minutes) => {
    const points = [];
    const steps = 90; // Number of prediction points
    
    // Simulate future positions based on orbit
    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      // Simple orbital prediction: move east (prograde orbit)
      const lonOffset = (minutes / 90) * 15 * progress; // ~15° per 90 min for LEO
      const latOffset = 2 * Math.sin(progress * Math.PI * 4); // Sinusoidal latitude variation
      
      points.push(new THREE.Vector3(
        sat.lon + lonOffset,
        sat.lat + latOffset,
        2
      ));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ 
      color: 0xffaa00, 
      opacity: 0.4, 
      transparent: true,
      lineDash: [5, 3]
    });
    const line = new THREE.Line(geometry, material);
    line.userData = { type: 'prediction', satelliteId: sat.id };
    
    // Make it dashed
    line.computeLineDistances();
    
    return line;
  };

  // --- HELPER: Format timestamp for display ---
  const formatTimestamp = (isoString) => {
    const date = new Date(isoString);
    return date.toUTCString();
  };

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      
      {/* Overlay info */}
      <div className="absolute top-4 left-4 bg-gray-900/80 px-3 py-2 rounded-lg text-sm">
        <div className="text-blue-400 font-bold">GROUND TRACK MAP</div>
        <div className="text-gray-400 text-xs mt-1">
          {formatTimestamp(timestamp)}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-gray-900/80 p-3 rounded-lg text-xs">
        <div className="flex items-center mb-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full mr-2"></div>
          <span className="text-gray-300">Active Satellite</span>
        </div>
        <div className="flex items-center mb-2">
          <div className="w-3 h-3 bg-yellow-500 rounded-full mr-2"></div>
          <span className="text-gray-300">Selected Satellite</span>
        </div>
        <div className="flex items-center mb-2">
          <div className="w-6 h-0.5 bg-green-500 mr-2"></div>
          <span className="text-gray-300">Historical Trail (90 min)</span>
        </div>
        <div className="flex items-center">
          <div className="w-6 h-0.5 bg-yellow-500 border-dashed mr-2" style={{ borderStyle: 'dashed' }}></div>
          <span className="text-gray-300">Predicted Path (90 min)</span>
        </div>
      </div>

      {/* Stats */}
      <div className="absolute top-4 right-4 bg-gray-900/80 p-3 rounded-lg text-xs">
        <div className="text-gray-400">Satellites: <span className="text-white font-bold">{satellites.length}</span></div>
        <div className="text-gray-400 mt-1">Selected: <span className="text-yellow-500 font-bold">{selectedSat || 'None'}</span></div>
        <div className="text-gray-400 mt-1">Time: <span className="text-blue-400">{new Date(timestamp).getUTCHours()}:{String(new Date(timestamp).getUTCMinutes()).padStart(2,'0')} UTC</span></div>
      </div>
    </div>
  );
};

export default GroundTrackMap;