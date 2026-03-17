// src/components/SatelliteMarker.js
import * as THREE from 'three';

/**
 * Creates a high-performance satellite marker with different visual states
 * Based on hackathon spec Section 6.2 - Ground Track Map requirements
 */
class SatelliteMarker {
  /**
   * Create a satellite marker
   * @param {Object} sat - Satellite data { id, lat, lon, fuel_kg, status }
   * @param {boolean} isSelected - Whether this satellite is selected
   * @param {Object} options - Additional options (scale, color, etc.)
   * @returns {THREE.Group} Three.js group containing the marker
   */
  static create(sat, isSelected = false, options = {}) {
    const group = new THREE.Group();
    
    // Default options
    const scale = options.scale || 1.0;
    const color = isSelected ? 0xffaa00 : this.getStatusColor(sat.status);
    const fuelLevel = sat.fuel_kg || 50;
    const fuelPercent = fuelLevel / 50; // 50kg is max

    // --- MAIN MARKER BODY ---
    // Use different shapes based on satellite status
    let mainGeo, mainMat;
    
    if (sat.status === 'GRAVEYARD') {
      // Graveyard satellites - dim, gray, different shape
      mainGeo = new THREE.OctahedronGeometry(2 * scale, 0);
      mainMat = new THREE.MeshStandardMaterial({ 
        color: 0x666666,
        emissive: 0x222222,
        roughness: 0.8,
        metalness: 0.2
      });
    } else if (sat.status === 'MANEUVER') {
      // Maneuvering satellites - brighter, distinct shape
      mainGeo = new THREE.ConeGeometry(2.5 * scale, 4 * scale, 8);
      mainMat = new THREE.MeshStandardMaterial({ 
        color: color,
        emissive: 0x442200,
        roughness: 0.3,
        metalness: 0.7
      });
    } else {
      // Normal satellites - standard shape
      mainGeo = new THREE.ConeGeometry(2 * scale, 3 * scale, 8);
      mainMat = new THREE.MeshStandardMaterial({ 
        color: color,
        emissive: isSelected ? 0x442200 : 0x112244,
        roughness: 0.4,
        metalness: 0.6
      });
    }
    
    const mainBody = new THREE.Mesh(mainGeo, mainMat);
    
    // Rotate to point "up" from Earth's surface
    mainBody.rotation.x = Math.PI / 2;
    mainBody.position.z = 2 * scale;
    mainBody.castShadow = true;
    mainBody.receiveShadow = true;
    group.add(mainBody);

    // --- SOLAR PANELS (for active satellites) ---
    if (sat.status !== 'GRAVEYARD') {
      const panelMat = new THREE.MeshStandardMaterial({ 
        color: 0xcccccc,
        emissive: 0x111111,
        roughness: 0.5,
        metalness: 0.3
      });
      
      // Left panel
      const leftPanelGeo = new THREE.BoxGeometry(1 * scale, 0.2 * scale, 2 * scale);
      const leftPanel = new THREE.Mesh(leftPanelGeo, panelMat);
      leftPanel.position.set(-2 * scale, 0, 1 * scale);
      leftPanel.rotation.z = 0.2;
      group.add(leftPanel);
      
      // Right panel
      const rightPanel = new THREE.Mesh(leftPanelGeo, panelMat);
      rightPanel.position.set(2 * scale, 0, 1 * scale);
      rightPanel.rotation.z = -0.2;
      group.add(rightPanel);
      
      // Panel connectors
      const connectorMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
      const connectorGeo = new THREE.CylinderGeometry(0.2 * scale, 0.2 * scale, 4 * scale);
      const connector = new THREE.Mesh(connectorGeo, connectorMat);
      connector.rotation.z = Math.PI / 2;
      connector.position.set(0, 0, 1 * scale);
      group.add(connector);
    }

    // --- GLOW EFFECT (based on fuel level and status) ---
    const glowSize = isSelected ? 6 : (3 + fuelPercent * 2);
    const glowGeo = new THREE.SphereGeometry(glowSize * scale, 16, 16);
    
    // Glow color based on fuel level
    let glowColor;
    if (fuelPercent < 0.2) {
      glowColor = 0xff4444; // Low fuel - red glow
    } else if (fuelPercent < 0.5) {
      glowColor = 0xffaa44; // Medium fuel - orange glow
    } else {
      glowColor = color; // High fuel - normal glow
    }
    
    const glowMat = new THREE.MeshBasicMaterial({ 
      color: glowColor,
      transparent: true,
      opacity: isSelected ? 0.4 : 0.2,
      side: THREE.BackSide
    });
    
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.z = 1 * scale;
    group.add(glow);

    // --- FUEL INDICATOR RING (visual fuel gauge) ---
    if (sat.status !== 'GRAVEYARD') {
      const ringRadius = 3 * scale;
      const ringGeo = new THREE.TorusGeometry(ringRadius, 0.3 * scale, 16, 32, Math.PI * 2 * fuelPercent);
      const ringMat = new THREE.MeshStandardMaterial({ 
        color: fuelPercent > 0.5 ? 0x44ff44 : (fuelPercent > 0.2 ? 0xffaa44 : 0xff4444),
        emissive: 0x112211,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide
      });
      
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = -Math.PI / 2;
      ring.position.z = 2.5 * scale;
      group.add(ring);
      
      // Add tick marks for fuel level
      const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff });
      for (let i = 0; i <= 4; i++) {
        const angle = (i / 4) * Math.PI * 2;
        const tickPoints = [];
        tickPoints.push(new THREE.Vector3(
          Math.cos(angle) * (ringRadius + 0.5) * scale,
          Math.sin(angle) * (ringRadius + 0.5) * scale,
          2.5 * scale
        ));
        tickPoints.push(new THREE.Vector3(
          Math.cos(angle) * (ringRadius - 0.5) * scale,
          Math.sin(angle) * (ringRadius - 0.5) * scale,
          2.5 * scale
        ));
        
        const tickGeo = new THREE.BufferGeometry().setFromPoints(tickPoints);
        const tick = new THREE.Line(tickGeo, tickMat);
        group.add(tick);
      }
    }

    // --- IDENTIFICATION TAG ---
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    // Background
    ctx.fillStyle = isSelected ? 'rgba(255, 170, 0, 0.9)' : 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Border
    ctx.strokeStyle = isSelected ? '#ffffff' : '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    
    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(sat.id.slice(-8), 8, 30);
    
    // Fuel percentage
    ctx.font = '12px monospace';
    ctx.fillStyle = fuelPercent > 0.5 ? '#44ff44' : (fuelPercent > 0.2 ? '#ffaa44' : '#ff4444');
    ctx.fillText(`${Math.round(fuelPercent * 100)}%`, 8, 52);
    
    // Status icon
    ctx.font = '20px monospace';
    ctx.fillStyle = '#ffffff';
    let statusIcon = '🛰️';
    if (sat.status === 'GRAVEYARD') statusIcon = '⚰️';
    else if (sat.status === 'MANEUVER') statusIcon = '🚀';
    ctx.fillText(statusIcon, canvas.width - 40, 40);
    
    const texture = new THREE.CanvasTexture(canvas);
    const labelMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const label = new THREE.Sprite(labelMat);
    label.scale.set(8 * scale, 4 * scale, 1);
    label.position.set(0, 8 * scale, 5 * scale);
    group.add(label);

    // --- ORBIT RING (for selected satellites) ---
    if (isSelected) {
      const orbitPoints = [];
      const radius = 10 * scale;
      const segments = 64;
      
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        orbitPoints.push(new THREE.Vector3(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius,
          1 * scale
        ));
      }
      
      const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPoints);
      const orbitMat = new THREE.LineBasicMaterial({ color: 0xffaa00, opacity: 0.3, transparent: true });
      const orbitLine = new THREE.Line(orbitGeo, orbitMat);
      group.add(orbitLine);
    }

    // --- SIGNAL PING ANIMATION (for active satellites) ---
    if (sat.status === 'ACTIVE' && !isSelected) {
      const pingGeo = new THREE.TorusGeometry(4 * scale, 0.2 * scale, 16, 32);
      const pingMat = new THREE.MeshBasicMaterial({ 
        color: 0x44aaff,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide
      });
      
      const ping = new THREE.Mesh(pingGeo, pingMat);
      ping.rotation.x = Math.PI / 2;
      ping.position.z = 1 * scale;
      
      // Store for animation
      ping.userData = { type: 'ping', phase: Math.random() * Math.PI * 2 };
      group.add(ping);
    }

    // --- POSITION AND METADATA ---
    group.position.set(sat.lon, sat.lat, 3 * scale);
    group.userData = { 
      type: 'satellite', 
      id: sat.id,
      fuel: sat.fuel_kg,
      status: sat.status,
      isSelected: isSelected,
      originalData: sat
    };

    return group;
  }

  /**
   * Get color based on satellite status
   * @param {string} status - Satellite status
   * @returns {number} Hex color code
   */
  static getStatusColor(status) {
    switch(status) {
      case 'GRAVEYARD':
        return 0x666666;
      case 'MANEUVER':
        return 0xff6600;
      case 'WARNING':
        return 0xffaa00;
      case 'CRITICAL':
        return 0xff4444;
      case 'ACTIVE':
      default:
        return 0x3b82f6;
    }
  }

  /**
   * Update marker animation (call in animation loop)
   * @param {THREE.Group} marker - The satellite marker group
   * @param {number} time - Current time for animations
   */
  static animate(marker, time) {
    if (!marker) return;

    // Animate ping rings
    marker.children.forEach(child => {
      if (child.userData?.type === 'ping') {
        const scale = 1 + Math.sin(time * 5 + child.userData.phase) * 0.2;
        child.scale.set(scale, scale, scale);
        child.material.opacity = 0.3 * (1 - (scale - 1) * 2);
      }
    });

    // Gentle floating motion
    marker.position.z = 3 + Math.sin(time * 2 + marker.userData.id.length) * 0.5;
    
    // Rotate solar panels if present
    marker.children.forEach(child => {
      if (child.geometry && child.geometry.type === 'BoxGeometry' && child.position.x !== 0) {
        child.rotation.y += 0.01;
      }
    });
  }

  /**
   * Create a batch of satellite markers for better performance
   * @param {Array} satellites - Array of satellite data
   * @param {string} selectedId - Currently selected satellite ID
   * @returns {THREE.Group} Group containing all markers
   */
  static createBatch(satellites, selectedId = null) {
    const batchGroup = new THREE.Group();
    
    satellites.forEach(sat => {
      const isSelected = sat.id === selectedId;
      const marker = this.create(sat, isSelected);
      batchGroup.add(marker);
    });

    return batchGroup;
  }

  /**
   * Update batch markers positions (for real-time tracking)
   * @param {THREE.Group} batchGroup - Group containing markers
   * @param {Array} newSatellites - Updated satellite data
   */
  static updateBatch(batchGroup, newSatellites) {
    if (!batchGroup) return;

    // Create a map for quick lookup
    const satMap = {};
    newSatellites.forEach(sat => { satMap[sat.id] = sat; });

    // Update existing markers
    batchGroup.children.forEach(marker => {
      const satId = marker.userData?.id;
      const newData = satMap[satId];
      
      if (newData) {
        // Update position
        marker.position.set(newData.lon, newData.lat, 3);
        
        // Update fuel level (visual indicator)
        const fuelRing = marker.children.find(c => c.geometry?.type === 'TorusGeometry');
        if (fuelRing) {
          const fuelPercent = (newData.fuel_kg || 50) / 50;
          // Recreate ring with new fuel level (simplified - in production, update geometry)
        }
        
        // Update label
        const label = marker.children.find(c => c.type === 'Sprite');
        if (label) {
          // Update canvas texture with new data
          const canvas = label.material.map.image;
          const ctx = canvas.getContext('2d');
          
          // Clear and redraw with new data
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = marker.userData.isSelected ? 'rgba(255, 170, 0, 0.9)' : 'rgba(0, 0, 0, 0.8)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.strokeStyle = marker.userData.isSelected ? '#ffffff' : '#3b82f6';
          ctx.strokeRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 16px monospace';
          ctx.fillText(satId.slice(-8), 8, 30);
          
          label.material.map.needsUpdate = true;
        }
      }
    });
  }

  /**
   * Highlight a specific satellite
   * @param {THREE.Group} marker - The marker to highlight
   * @param {boolean} highlight - Whether to highlight
   */
  static setHighlight(marker, highlight = true) {
    if (!marker) return;

    marker.userData.isSelected = highlight;
    
    marker.children.forEach(child => {
      // Adjust glow
      if (child.geometry?.type === 'SphereGeometry' && child.material.transparent) {
        child.material.opacity = highlight ? 0.4 : 0.2;
        if (highlight) child.material.color.setHex(0xffaa00);
      }
      
      // Adjust main body
      if (child.geometry?.type === 'ConeGeometry' && !child.material.transparent) {
        child.material.color.setHex(highlight ? 0xffaa00 : this.getStatusColor(marker.userData.status));
        child.material.emissive.setHex(highlight ? 0x442200 : 0x112244);
      }
      
      // Update label border
      if (child.type === 'Sprite') {
        // Update canvas border color
        const canvas = child.material.map.image;
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = highlight ? '#ffffff' : '#3b82f6';
        ctx.strokeRect(0, 0, canvas.width, canvas.height);
        child.material.map.needsUpdate = true;
      }
    });
  }
}

export default SatelliteMarker;