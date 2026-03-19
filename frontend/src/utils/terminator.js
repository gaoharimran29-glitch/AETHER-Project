// src/utils/terminator.js
import * as THREE from 'three';

// Constants
const EARTH_ROT_RATE = 7.292115e-5; // Earth rotation rate (rad/s)
const RE = 6378.137; // Earth radius (km)
const AU = 149597870; // Astronomical unit (km)
const OBLIQUITY = 23.44 * Math.PI / 180; // Earth's axial tilt (radians)

/**
 * Terminator Utility
 * Calculates day/night boundary (terminator line) for Earth visualization
 * Based on hackathon spec Section 6.2 - "dynamic shadow overlay representing the Terminator Line"
 */
class TerminatorCalculator {
  /**
   * Calculate sun position in ECI coordinates
   * @param {number} time - Simulation time (seconds)
   * @returns {THREE.Vector3} Sun direction vector
   */
  static getSunPosition(time = 0) {
    // Simplified sun position model
    // In reality, this would use more complex astronomical algorithms
    
    // Earth orbits sun once per year (365.25 days)
    const daysSinceEpoch = time / 86400;
    const yearProgress = (daysSinceEpoch % 365.25) / 365.25;
    
    // Sun's ecliptic longitude
    const sunLongitude = yearProgress * 2 * Math.PI;
    
    // Sun's position in ecliptic coordinates (simplified - assume circular orbit)
    const sunEcliptic = new THREE.Vector3(
      Math.cos(sunLongitude),
      Math.sin(sunLongitude) * Math.cos(OBLIQUITY),
      Math.sin(sunLongitude) * Math.sin(OBLIQUITY)
    ).normalize();
    
    // Rotate based on time of day (Earth rotation)
    const earthRotation = EARTH_ROT_RATE * time;
    
    // Apply rotation to get sun direction in ECI
    const sunDir = new THREE.Vector3(
      sunEcliptic.x * Math.cos(earthRotation) - sunEcliptic.y * Math.sin(earthRotation),
      sunEcliptic.x * Math.sin(earthRotation) + sunEcliptic.y * Math.cos(earthRotation),
      sunEcliptic.z
    );
    
    return sunDir.normalize();
  }

  /**
   * Calculate sun position for a given date (more accurate)
   * @param {Date} date - JavaScript Date object
   * @returns {THREE.Vector3} Sun direction vector
   */
  static getSunPositionForDate(date) {
    // Julian day calculation
    const time = date.getTime() / 1000; // Convert to seconds
    return this.getSunPosition(time);
  }

  /**
   * Check if a point on Earth is in daylight
   * @param {number} lat - Latitude (degrees)
   * @param {number} lon - Longitude (degrees)
   * @param {number} time - Simulation time (seconds)
   * @returns {boolean} True if point is in daylight
   */
  static isInDaylight(lat, lon, time = 0) {
    const sunDir = this.getSunPosition(time);
    
    // Convert lat/lon to ECI unit vector
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    const pointDir = new THREE.Vector3(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.cos(latRad) * Math.sin(lonRad),
      Math.sin(latRad)
    ).normalize();
    
    // Dot product > 0 means point is facing sun (daylight)
    return pointDir.dot(sunDir) > 0;
  }

  /**
   * Calculate terminator line points (day/night boundary)
   * @param {number} time - Simulation time (seconds)
   * @param {number} resolution - Number of points (default: 360)
   * @returns {Array} Array of { lat, lon } points
   */
  static calculateTerminatorPoints(time = 0, resolution = 360) {
    const points = [];
    const sunDir = this.getSunPosition(time);
    
    // The terminator is where the dot product with sun direction is zero
    // Solve: cos(lat) * cos(lon) * sun.x + cos(lat) * sin(lon) * sun.y + sin(lat) * sun.z = 0
    
    // Generate points by iterating over longitude
    for (let i = 0; i <= resolution; i++) {
      const lon = (i / resolution) * 360 - 180;
      const lonRad = lon * Math.PI / 180;
      
      // Solve for latitude where dot product = 0
      // A * cos(lat) + B * sin(lat) = 0 where:
      const A = sunDir.x * Math.cos(lonRad) + sunDir.y * Math.sin(lonRad);
      const B = sunDir.z;
      
      if (Math.abs(A) < 1e-10) {
        // Special case: terminator passes through poles
        if (Math.abs(B) > 1e-10) {
          points.push({ lat: 90, lon });
          points.push({ lat: -90, lon });
        }
      } else {
        // Solve: tan(lat) = -A/B
        const latRad = Math.atan2(-A, B);
        const lat = latRad * 180 / Math.PI;
        
        // Add both solutions (there are two for each longitude)
        points.push({ lat, lon });
        
        // Add the antipodal point
        points.push({ lat: -lat, lon: (lon + 180) % 360 - 180 });
      }
    }
    
    return points;
  }

  /**
   * Calculate terminator as a set of 3D points for rendering
   * @param {number} time - Simulation time (seconds)
   * @param {number} resolution - Number of segments (default: 64)
   * @returns {Array} Array of THREE.Vector3 points
   */
  static calculateTerminator3D(time = 0, resolution = 64) {
    const points = [];
    const sunDir = this.getSunPosition(time);
    
    // Generate terminator as a great circle perpendicular to sun direction
    // Find two orthogonal vectors to sun direction
    const sunDirNorm = sunDir.clone().normalize();
    
    // Find a vector not parallel to sunDir
    let temp = new THREE.Vector3(0, 0, 1);
    if (Math.abs(sunDirNorm.dot(temp)) > 0.99) {
      temp = new THREE.Vector3(1, 0, 0);
    }
    
    // Create basis vectors for the terminator plane
    const u = new THREE.Vector3().crossVectors(sunDirNorm, temp).normalize();
    const v = new THREE.Vector3().crossVectors(sunDirNorm, u).normalize();
    
    // Generate circle in terminator plane
    for (let i = 0; i <= resolution; i++) {
      const angle = (i / resolution) * Math.PI * 2;
      
      // Point in terminator plane (perpendicular to sun)
      const termPoint = new THREE.Vector3(
        u.x * Math.cos(angle) + v.x * Math.sin(angle),
        u.y * Math.cos(angle) + v.y * Math.sin(angle),
        u.z * Math.cos(angle) + v.z * Math.sin(angle)
      ).normalize();
      
      // Scale to Earth's surface
      termPoint.multiplyScalar(RE);
      points.push(termPoint);
    }
    
    return points;
  }

  /**
   * Calculate shadow gradient (for atmosphere rendering)
   * @param {number} time - Simulation time (seconds)
   * @param {number} resolution - Number of points (default: 180)
   * @returns {Array} Array of { lat, lon, shadowStrength }
   */
  static calculateShadowGradient(time = 0, resolution = 180) {
    const gradient = [];
    const sunDir = this.getSunPosition(time);
    
    for (let i = 0; i <= resolution; i++) {
      const lat = (i / resolution) * 180 - 90;
      const latRad = lat * Math.PI / 180;
      
      for (let j = 0; j <= resolution; j++) {
        const lon = (j / resolution) * 360 - 180;
        const lonRad = lon * Math.PI / 180;
        
        // Point on Earth
        const pointDir = new THREE.Vector3(
          Math.cos(latRad) * Math.cos(lonRad),
          Math.cos(latRad) * Math.sin(lonRad),
          Math.sin(latRad)
        );
        
        // Cosine of angle between point and sun
        const cosAngle = pointDir.dot(sunDir);
        
        // Shadow strength: 0 in full sun, 1 in full shadow, with gradient near terminator
        let shadowStrength;
        if (cosAngle > 0.1) {
          shadowStrength = 0; // Full daylight
        } else if (cosAngle < -0.1) {
          shadowStrength = 1; // Full night
        } else {
          // Gradient zone
          shadowStrength = 0.5 - cosAngle * 5; // Smooth transition
        }
        
        gradient.push({
          lat,
          lon,
          shadow: shadowStrength,
          cosAngle
        });
      }
    }
    
    return gradient;
  }

  /**
   * Calculate solar elevation for a specific point
   * @param {number} lat - Latitude (degrees)
   * @param {number} lon - Longitude (degrees)
   * @param {number} time - Simulation time (seconds)
   * @returns {number} Solar elevation angle (degrees)
   */
  static getSolarElevation(lat, lon, time = 0) {
    const sunDir = this.getSunPosition(time);
    
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    // Local up vector
    const up = new THREE.Vector3(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.cos(latRad) * Math.sin(lonRad),
      Math.sin(latRad)
    );
    
    // Sun direction relative to local horizon
    const cosElevation = up.dot(sunDir);
    
    return Math.asin(cosElevation) * 180 / Math.PI;
  }

  /**
   * Calculate sunrise/sunset times for a location
   * @param {number} lat - Latitude (degrees)
   * @param {number} lon - Longitude (degrees)
   * @param {Date} date - Reference date
   * @returns {Object} { sunrise, sunset } as Date objects
   */
  static getSunriseSunset(lat, lon, date = new Date()) {
    // Simplified sunrise/sunset calculation
    // Based on solar elevation crossing -0.833° (horizon including refraction)
    
    const time = date.getTime() / 1000;
    const sunDir = this.getSunPosition(time);
    
    // Search for sunrise and sunset times
    let sunrise = null;
    let sunset = null;
    
    // Check every hour for 48 hours
    for (let hour = -24; hour <= 24; hour++) {
      const checkTime = time + hour * 3600;
      const elevation = this.getSolarElevation(lat, lon, checkTime);
      
      if (Math.abs(elevation + 0.833) < 0.1) {
        // Close to horizon
        const prevElev = this.getSolarElevation(lat, lon, checkTime - 1800);
        
        if (prevElev < -0.833 && elevation > -0.833) {
          sunrise = new Date(checkTime * 1000);
        } else if (prevElev > -0.833 && elevation < -0.833) {
          sunset = new Date(checkTime * 1000);
        }
      }
    }
    
    return { sunrise, sunset };
  }

  /**
   * Calculate daylight duration for a location
   * @param {number} lat - Latitude (degrees)
   * @param {Date} date - Reference date
   * @returns {number} Daylight duration (hours)
   */
  static getDaylightDuration(lat, date = new Date()) {
    const { sunrise, sunset } = this.getSunriseSunset(lat, 0, date);
    
    if (!sunrise || !sunset) {
      // Polar night or midnight sun
      const sunDir = this.getSunPosition(date.getTime() / 1000);
      const latRad = lat * Math.PI / 180;
      
      // Check if sun is always above or below horizon
      const maxElevation = Math.asin(
        Math.sin(latRad) * Math.sin(OBLIQUITY) + 
        Math.cos(latRad) * Math.cos(OBLIQUITY)
      ) * 180 / Math.PI;
      
      if (maxElevation < -0.833) {
        return 0; // Polar night
      } else if (maxElevation > 0.833) {
        return 24; // Midnight sun
      }
    }
    
    return sunrise && sunset ? (sunset - sunrise) / 3600000 : 12;
  }

  /**
   * Create a Three.js material for terminator line visualization
   * @param {number} time - Simulation time
   * @returns {THREE.LineBasicMaterial} Material for terminator line
   */
  static createTerminatorMaterial(time = 0) {
    return new THREE.LineBasicMaterial({
      color: 0xffaa33,
      opacity: 0.3,
      transparent: true
    });
  }

  /**
   * Create a Three.js geometry for terminator line
   * @param {number} time - Simulation time
   * @param {number} resolution - Number of segments
   * @returns {THREE.BufferGeometry} Terminator line geometry
   */
  static createTerminatorGeometry(time = 0, resolution = 128) {
    const points = this.calculateTerminator3D(time, resolution);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return geometry;
  }

  /**
   * Create a Three.js mesh for shadow hemisphere (night side)
   * @param {number} time - Simulation time
   * @returns {THREE.Mesh} Shadow hemisphere mesh
   */
  static createShadowHemisphere(time = 0) {
    const sunDir = this.getSunPosition(time);
    
    // Create a hemisphere opposite the sun
    const geometry = new THREE.SphereGeometry(RE + 10, 64, 32);
    
    // Custom shader material for shadow
    const material = new THREE.ShaderMaterial({
      uniforms: {
        sunDir: { value: sunDir },
        color: { value: new THREE.Color(0x000022) }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        
        void main() {
          vNormal = normalize(normal);
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 sunDir;
        uniform vec3 color;
        varying vec3 vNormal;
        varying vec3 vPosition;
        
        void main() {
          float dotNL = dot(vNormal, sunDir);
          
          // Darken the hemisphere opposite the sun
          float shadow = smoothstep(-0.3, 0.3, -dotNL);
          
          // Add atmospheric glow at edges
          float glow = pow(1.0 - abs(dotNL), 2.0) * 0.3;
          
          vec3 finalColor = mix(color, vec3(0.1, 0.15, 0.3), shadow);
          finalColor += vec3(0.2, 0.3, 0.6) * glow;
          
          gl_FragColor = vec4(finalColor, shadow * 0.7);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    
    // Rotate to align with sun direction
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      sunDir.clone().negate()
    );
    mesh.applyQuaternion(quaternion);
    
    return mesh;
  }

  /**
   * Update terminator for new time
   * @param {THREE.Line} terminatorLine - Three.js line object
   * @param {number} time - New simulation time
   */
  static updateTerminatorLine(terminatorLine, time) {
    if (!terminatorLine) return;
    
    const points = this.calculateTerminator3D(time);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    terminatorLine.geometry.dispose();
    terminatorLine.geometry = geometry;
  }

  /**
   * Calculate twilight zones (civil, nautical, astronomical)
   * @param {number} time - Simulation time
   * @returns {Object} Twilight zone boundaries
   */
  static calculateTwilightZones(time = 0) {
    const sunDir = this.getSunPosition(time);
    
    // Twilight occurs when sun is 0-6° (civil), 6-12° (nautical), 12-18° (astronomical) below horizon
    const twilightZones = {
      civil: [],
      nautical: [],
      astronomical: []
    };
    
    // Calculate for each longitude
    for (let lon = -180; lon <= 180; lon += 5) {
      const lonRad = lon * Math.PI / 180;
      
      // Solve for latitude where sun elevation equals specific angles
      const A = sunDir.x * Math.cos(lonRad) + sunDir.y * Math.sin(lonRad);
      const B = sunDir.z;
      
      // Civil twilight (sun 6° below horizon)
      const civilLat = Math.atan2(-A, B - Math.tan(6 * Math.PI / 180) * Math.sqrt(A*A + B*B));
      twilightZones.civil.push({ lat: civilLat * 180 / Math.PI, lon });
      
      // Nautical twilight (sun 12° below horizon)
      const nauticalLat = Math.atan2(-A, B - Math.tan(12 * Math.PI / 180) * Math.sqrt(A*A + B*B));
      twilightZones.nautical.push({ lat: nauticalLat * 180 / Math.PI, lon });
      
      // Astronomical twilight (sun 18° below horizon)
      const astroLat = Math.atan2(-A, B - Math.tan(18 * Math.PI / 180) * Math.sqrt(A*A + B*B));
      twilightZones.astronomical.push({ lat: astroLat * 180 / Math.PI, lon });
    }
    
    return twilightZones;
  }
}

export default TerminatorCalculator;