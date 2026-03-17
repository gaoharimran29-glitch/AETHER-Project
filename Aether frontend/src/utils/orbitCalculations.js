// src/utils/orbitCalculations.js
import * as THREE from 'three';

// Constants
const MU = 398600.4418; // Earth's gravitational parameter (km³/s²)
const RE = 6378.137; // Earth's radius (km)
const J2 = 1.08263e-3; // J2 perturbation constant
const EARTH_ROT_RATE = 7.292115e-5; // Earth rotation rate (rad/s)

/**
 * Orbit Calculations Utility
 * Provides functions for orbital mechanics, trajectory prediction,
 * and coordinate transformations for the AETHER system.
 */
class OrbitCalculations {
  // ==========================================================================
  // CONVERSION FUNCTIONS
  // ==========================================================================

  /**
   * Convert ECI coordinates to Lat/Lon/Alt
   * @param {number} x - ECI X coordinate (km)
   * @param {number} y - ECI Y coordinate (km)
   * @param {number} z - ECI Z coordinate (km)
   * @param {number} time - Simulation time (s) for Earth rotation correction
   * @returns {Object} { lat, lon, alt }
   */
  static eciToLatLonAlt(x, y, z, time = 0) {
    const r = Math.sqrt(x*x + y*y + z*z);
    
    // Calculate latitude (geocentric)
    const latRad = Math.asin(z / r);
    const lat = latRad * 180 / Math.PI;
    
    // Calculate longitude with Earth rotation correction
    let lonRad = Math.atan2(y, x);
    // Correct for Earth rotation (Earth rotates eastward)
    lonRad -= EARTH_ROT_RATE * time;
    
    // Normalize longitude to -180 to 180
    let lon = lonRad * 180 / Math.PI;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    
    // Calculate altitude
    const alt = r - RE;
    
    return { lat, lon, alt };
  }

  /**
   * Convert Lat/Lon/Alt to ECI coordinates
   * @param {number} lat - Latitude (degrees)
   * @param {number} lon - Longitude (degrees)
   * @param {number} alt - Altitude (km)
   * @param {number} time - Simulation time (s) for Earth rotation
   * @returns {THREE.Vector3} ECI position
   */
  static latLonAltToECI(lat, lon, alt, time = 0) {
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    // Add Earth rotation
    const correctedLon = lonRad + EARTH_ROT_RATE * time;
    
    const r = RE + alt;
    
    return new THREE.Vector3(
      r * Math.cos(latRad) * Math.cos(correctedLon),
      r * Math.cos(latRad) * Math.sin(correctedLon),
      r * Math.sin(latRad)
    );
  }

  /**
   * Convert ECI to RTN frame
   * @param {THREE.Vector3} position - ECI position
   * @param {THREE.Vector3} velocity - ECI velocity
   * @param {THREE.Vector3} vectorECI - Vector in ECI frame to convert
   * @returns {THREE.Vector3} Vector in RTN frame [Radial, Tangential, Normal]
   */
  static eciToRTN(position, velocity, vectorECI) {
    // Radial unit vector (pointing from Earth to satellite)
    const rHat = position.clone().normalize();
    
    // Normal unit vector (angular momentum direction)
    const h = new THREE.Vector3().crossVectors(position, velocity);
    const nHat = h.clone().normalize();
    
    // Tangential unit vector (completes right-handed system)
    const tHat = new THREE.Vector3().crossVectors(nHat, rHat).normalize();
    
    // Transform matrix from ECI to RTN
    const rtnX = vectorECI.dot(rHat);
    const rtnY = vectorECI.dot(tHat);
    const rtnZ = vectorECI.dot(nHat);
    
    return new THREE.Vector3(rtnX, rtnY, rtnZ);
  }

  /**
   * Convert RTN to ECI frame
   * @param {THREE.Vector3} position - ECI position
   * @param {THREE.Vector3} velocity - ECI velocity
   * @param {THREE.Vector3} vectorRTN - Vector in RTN frame [Radial, Tangential, Normal]
   * @returns {THREE.Vector3} Vector in ECI frame
   */
  static rtnToECI(position, velocity, vectorRTN) {
    // Radial unit vector
    const rHat = position.clone().normalize();
    
    // Normal unit vector
    const h = new THREE.Vector3().crossVectors(position, velocity);
    const nHat = h.clone().normalize();
    
    // Tangential unit vector
    const tHat = new THREE.Vector3().crossVectors(nHat, rHat).normalize();
    
    // Combine basis vectors
    return new THREE.Vector3()
      .copy(rHat.clone().multiplyScalar(vectorRTN.x))
      .add(tHat.clone().multiplyScalar(vectorRTN.y))
      .add(nHat.clone().multiplyScalar(vectorRTN.z));
  }

  // ==========================================================================
  // ORBITAL ELEMENTS
  // ==========================================================================

  /**
   * Calculate classical orbital elements from position and velocity
   * @param {THREE.Vector3} r - ECI position (km)
   * @param {THREE.Vector3} v - ECI velocity (km/s)
   * @returns {Object} Orbital elements
   */
  static rvToElements(r, v) {
    const rMag = r.length();
    const vMag = v.length();
    
    // Specific angular momentum
    const h = new THREE.Vector3().crossVectors(r, v);
    const hMag = h.length();
    
    // Node vector
    const n = new THREE.Vector3(0, 0, 1).cross(h);
    const nMag = n.length();
    
    // Eccentricity vector
    const eVec = new THREE.Vector3()
      .copy(v.clone().multiplyScalar(hMag / MU))
      .sub(r.clone().divideScalar(rMag));
    const e = eVec.length();
    
    // Energy
    const energy = vMag * vMag / 2 - MU / rMag;
    
    // Semi-major axis
    const a = -MU / (2 * energy);
    
    // Inclination
    const i = Math.acos(h.z / hMag) * 180 / Math.PI;
    
    // Right ascension of ascending node (RAAN)
    let raan = 0;
    if (nMag > 0) {
      raan = Math.acos(n.x / nMag) * 180 / Math.PI;
      if (n.y < 0) raan = 360 - raan;
    }
    
    // Argument of periapsis
    let w = 0;
    if (nMag > 0 && e > 0) {
      w = Math.acos(n.dot(eVec) / (nMag * e)) * 180 / Math.PI;
      if (eVec.z < 0) w = 360 - w;
    }
    
    // True anomaly
    let nu = 0;
    if (e > 0) {
      nu = Math.acos(eVec.dot(r) / (e * rMag)) * 180 / Math.PI;
      if (r.dot(v) < 0) nu = 360 - nu;
    } else {
      // Circular orbit - use argument of latitude
      nu = Math.acos(n.dot(r) / (nMag * rMag)) * 180 / Math.PI;
      if (r.z < 0) nu = 360 - nu;
    }
    
    return {
      a,              // Semi-major axis (km)
      e,              // Eccentricity
      i,              // Inclination (deg)
      raan,           // RAAN (deg)
      w,              // Argument of periapsis (deg)
      nu,             // True anomaly (deg)
      period: 2 * Math.PI * Math.sqrt(a * a * a / MU), // Orbital period (s)
      hMag            // Angular momentum magnitude
    };
  }

  /**
   * Calculate position and velocity from orbital elements
   * @param {Object} elements - Orbital elements
   * @returns {Object} { position, velocity } as THREE.Vector3
   */
  static elementsToRV(elements) {
    const { a, e, i, raan, w, nu } = elements;
    
    // Convert to radians
    const iRad = i * Math.PI / 180;
    const raanRad = raan * Math.PI / 180;
    const wRad = w * Math.PI / 180;
    const nuRad = nu * Math.PI / 180;
    
    // Position in orbital plane
    const rMag = a * (1 - e * e) / (1 + e * Math.cos(nuRad));
    const rPerif = new THREE.Vector3(
      rMag * Math.cos(nuRad),
      rMag * Math.sin(nuRad),
      0
    );
    
    // Velocity in orbital plane
    const vMag = Math.sqrt(MU * (2 / rMag - 1 / a));
    const gamma = Math.atan2(e * Math.sin(nuRad), 1 + e * Math.cos(nuRad));
    const vPerif = new THREE.Vector3(
      vMag * Math.cos(gamma + nuRad),
      vMag * Math.sin(gamma + nuRad),
      0
    );
    
    // Rotation matrices
    const cosRaan = Math.cos(raanRad);
    const sinRaan = Math.sin(raanRad);
    const cosW = Math.cos(wRad);
    const sinW = Math.sin(wRad);
    const cosI = Math.cos(iRad);
    const sinI = Math.sin(iRad);
    
    // Rotate from perifocal to ECI
    const position = new THREE.Vector3(
      rPerif.x * (cosRaan * cosW - sinRaan * sinW * cosI) +
      rPerif.y * (-cosRaan * sinW - sinRaan * cosW * cosI),
      
      rPerif.x * (sinRaan * cosW + cosRaan * sinW * cosI) +
      rPerif.y * (-sinRaan * sinW + cosRaan * cosW * cosI),
      
      rPerif.x * (sinW * sinI) +
      rPerif.y * (cosW * sinI)
    );
    
    const velocity = new THREE.Vector3(
      vPerif.x * (cosRaan * cosW - sinRaan * sinW * cosI) +
      vPerif.y * (-cosRaan * sinW - sinRaan * cosW * cosI),
      
      vPerif.x * (sinRaan * cosW + cosRaan * sinW * cosI) +
      vPerif.y * (-sinRaan * sinW + cosRaan * cosW * cosI),
      
      vPerif.x * (sinW * sinI) +
      vPerif.y * (cosW * sinI)
    );
    
    return { position, velocity };
  }

  // ==========================================================================
  // TRAJECTORY PREDICTION
  // ==========================================================================

  /**
   * Propagate orbit using Kepler's equation
   * @param {THREE.Vector3} r0 - Initial position (km)
   * @param {THREE.Vector3} v0 - Initial velocity (km/s)
   * @param {number} dt - Time step (seconds)
   * @returns {Object} { position, velocity }
   */
  static keplerPropagate(r0, v0, dt) {
    const r0Mag = r0.length();
    const v0Mag = v0.length();
    
    // Specific angular momentum
    const h = new THREE.Vector3().crossVectors(r0, v0);
    const hMag = h.length();
    
    // Eccentricity vector
    const eVec = new THREE.Vector3()
      .copy(v0.clone().multiplyScalar(hMag / MU))
      .sub(r0.clone().divideScalar(r0Mag));
    const e = eVec.length();
    
    // Semi-major axis
    const energy = v0Mag * v0Mag / 2 - MU / r0Mag;
    const a = -MU / (2 * energy);
    
    if (Math.abs(e - 1) < 1e-6) {
      // Parabolic orbit - use simplified propagation
      return this.rk4Propagate(r0, v0, dt);
    }
    
    // Mean motion
    const n = Math.sqrt(MU / (a * a * a));
    
    // Initial eccentric anomaly
    const cosNu0 = eVec.dot(r0) / (e * r0Mag);
    const sinNu0 = Math.sqrt(1 - cosNu0 * cosNu0) * (r0.dot(v0) > 0 ? 1 : -1);
    const nu0 = Math.atan2(sinNu0, cosNu0);
    
    let E0;
    if (e < 1) {
      // Elliptical
      E0 = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu0 / 2));
    } else {
      // Hyperbolic
      E0 = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu0 / 2));
    }
    
    // Mean anomaly at initial time
    let M0;
    if (e < 1) {
      M0 = E0 - e * Math.sin(E0);
    } else {
      M0 = e * Math.sinh(E0) - E0;
    }
    
    // Mean anomaly at new time
    const M = M0 + n * dt;
    
    // Solve Kepler's equation for E
    let E = M;
    if (e < 1) {
      // Elliptical - Newton iteration
      for (let i = 0; i < 10; i++) {
        const f = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        E = E - f / fp;
      }
    } else {
      // Hyperbolic - Newton iteration
      for (let i = 0; i < 10; i++) {
        const f = e * Math.sinh(E) - E - M;
        const fp = e * Math.cosh(E) - 1;
        E = E - f / fp;
      }
    }
    
    // True anomaly at new time
    let nu;
    if (e < 1) {
      nu = 2 * Math.atan(Math.sqrt((1 + e) / (1 - e)) * Math.tan(E / 2));
    } else {
      nu = 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(E / 2));
    }
    
    // New position in perifocal frame
    const rMagNew = a * (1 - e * e) / (1 + e * Math.cos(nu));
    
    // Create new orbital elements
    const elements = {
      a,
      e,
      i: this.rvToElements(r0, v0).i,
      raan: this.rvToElements(r0, v0).raan,
      w: this.rvToElements(r0, v0).w,
      nu: nu * 180 / Math.PI
    };
    
    return this.elementsToRV(elements);
  }

  /**
   * Runge-Kutta 4th order numerical propagator (with J2)
   * @param {THREE.Vector3} r - Position (km)
   * @param {THREE.Vector3} v - Velocity (km/s)
   * @param {number} dt - Time step (s)
   * @returns {Object} { position, velocity }
   */
  static rk4Propagate(r, v, dt) {
    const state = [r.x, r.y, r.z, v.x, v.y, v.z];
    
    const derivatives = (state) => {
      const [x, y, z, vx, vy, vz] = state;
      
      // Position derivatives are velocity
      const dr = [vx, vy, vz];
      
      // Acceleration from two-body gravity
      const rMag = Math.sqrt(x*x + y*y + z*z);
      const factor = -MU / (rMag * rMag * rMag);
      let ax = factor * x;
      let ay = factor * y;
      let az = factor * z;
      
      // J2 perturbation
      const z2 = z * z;
      const r2 = rMag * rMag;
      const r7 = r2 * r2 * rMag;
      const j2Factor = 1.5 * J2 * MU * RE * RE / r7;
      
      ax += j2Factor * x * (5 * z2 / r2 - 1);
      ay += j2Factor * y * (5 * z2 / r2 - 1);
      az += j2Factor * z * (5 * z2 / r2 - 3);
      
      return [...dr, ax, ay, az];
    };
    
    // RK4 integration
    const k1 = derivatives(state);
    const k2 = derivatives(state.map((s, i) => s + 0.5 * dt * k1[i]));
    const k3 = derivatives(state.map((s, i) => s + 0.5 * dt * k2[i]));
    const k4 = derivatives(state.map((s, i) => s + dt * k3[i]));
    
    const newState = state.map((s, i) => 
      s + (dt / 6) * (k1[i] + 2*k2[i] + 2*k3[i] + k4[i])
    );
    
    return {
      position: new THREE.Vector3(newState[0], newState[1], newState[2]),
      velocity: new THREE.Vector3(newState[3], newState[4], newState[5])
    };
  }

  // ==========================================================================
  // GROUND TRACK CALCULATIONS
  // ==========================================================================

  /**
   * Calculate ground track for a satellite
   * @param {THREE.Vector3} r0 - Initial position (km)
   * @param {THREE.Vector3} v0 - Initial velocity (km/s)
   * @param {number} duration - Duration to calculate (seconds)
   * @param {number} step - Time step (seconds)
   * @returns {Array} Array of { lat, lon, time } points
   */
  static calculateGroundTrack(r0, v0, duration = 5400, step = 60) {
    const track = [];
    let currentR = r0.clone();
    let currentV = v0.clone();
    
    for (let t = 0; t <= duration; t += step) {
      const { lat, lon } = this.eciToLatLonAlt(currentR.x, currentR.y, currentR.z, t);
      track.push({ lat, lon, time: t });
      
      // Propagate to next step
      const next = this.rk4Propagate(currentR, currentV, step);
      currentR = next.position;
      currentV = next.velocity;
    }
    
    return track;
  }

  /**
   * Calculate future trajectory points for visualization
   * @param {Object} sat - Satellite object with lat, lon, alt
   * @param {number} minutes - Minutes to predict
   * @param {number} points - Number of points
   * @returns {Array} Array of { lat, lon } points
   */
  static predictTrajectory(sat, minutes = 90, points = 90) {
    if (!sat || !sat.lat || !sat.lon) return [];
    
    const trajectory = [];
    const step = (minutes * 60) / points;
    
    // Convert current position to ECI
    const r0 = this.latLonAltToECI(sat.lat, sat.lon, sat.alt_km || 500);
    
    // Estimate velocity for circular orbit at this altitude
    const rMag = r0.length();
    const vCircular = Math.sqrt(MU / rMag);
    
    // Assume prograde circular orbit (velocity in local horizontal direction)
    // This is simplified - in reality you'd have actual velocity from telemetry
    const latRad = sat.lat * Math.PI / 180;
    const lonRad = sat.lon * Math.PI / 180;
    
    // Direction of motion (eastward for prograde orbit)
    const vDir = new THREE.Vector3(
      -Math.sin(lonRad),
      Math.cos(lonRad),
      0
    ).normalize();
    
    const v0 = vDir.multiplyScalar(vCircular);
    
    let currentR = r0.clone();
    let currentV = v0.clone();
    
    for (let i = 1; i <= points; i++) {
      const next = this.rk4Propagate(currentR, currentV, step);
      currentR = next.position;
      currentV = next.velocity;
      
      const { lat, lon } = this.eciToLatLonAlt(currentR.x, currentR.y, currentR.z, i * step);
      trajectory.push({ lat, lon });
    }
    
    return trajectory;
  }

  /**
   * Calculate historical trail points
   * @param {Object} sat - Satellite object
   * @param {number} minutes - Minutes of history
   * @param {number} points - Number of points
   * @returns {Array} Array of { lat, lon } points
   */
  static calculateHistoricalTrail(sat, minutes = 90, points = 90) {
    if (!sat || !sat.lat || !sat.lon) return [];
    
    const trail = [];
    const step = (minutes * 60) / points;
    
    // For demo purposes, generate an elliptical trail behind current position
    // In production, this would come from stored telemetry
    for (let i = points; i >= 0; i--) {
      const progress = i / points;
      // Simulate orbital motion - satellites move east at ~4 deg/min for LEO
      const lonOffset = -minutes * 4 * progress; // 4 deg per minute retrograde
      const latOffset = 2 * Math.sin(progress * Math.PI * 4);
      
      trail.push({
        lat: sat.lat + latOffset,
        lon: ((sat.lon + lonOffset + 180) % 360) - 180
      });
    }
    
    return trail;
  }

  // ==========================================================================
  // VISIBILITY CALCULATIONS
  // ==========================================================================

  /**
   * Check if a satellite is visible from a ground station
   * @param {Object} sat - Satellite { lat, lon, alt_km }
   * @param {Object} station - Ground station { lat, lon, alt_m, min_el_deg }
   * @param {number} time - Current time (s)
   * @returns {Object} { visible, elevation, range }
   */
  static checkVisibility(sat, station, time = 0) {
    // Convert to ECI
    const satPos = this.latLonAltToECI(sat.lat, sat.lon, sat.alt_km || 500, time);
    const stationPos = this.latLonAltToECI(
      station.lat, 
      station.lon, 
      (station.alt_m || 0) / 1000, 
      time
    );
    
    // Relative vector
    const rho = new THREE.Vector3().subVectors(satPos, stationPos);
    const range = rho.length();
    
    // Check Earth occlusion
    const stationMag = stationPos.length();
    const satMag = satPos.length();
    
    // Angle between station and satellite vectors
    const cosAngle = stationPos.dot(satPos) / (stationMag * satMag);
    const angle = Math.acos(cosAngle) * 180 / Math.PI;
    
    // Calculate grazing angle
    const grazingAngle = Math.asin(RE / stationMag) * 180 / Math.PI;
    
    // Earth blocks if satellite is below horizon
    const earthOccluded = angle > 180 - grazingAngle;
    
    // Calculate elevation angle
    const localUp = stationPos.clone().normalize();
    const rhoHorizontal = rho.clone().sub(localUp.clone().multiplyScalar(rho.dot(localUp)));
    const elevation = Math.asin(rho.dot(localUp) / range) * 180 / Math.PI;
    
    // Check if above minimum elevation
    const minEl = station.min_el_deg || 5;
    const aboveHorizon = elevation >= minEl && !earthOccluded;
    
    return {
      visible: aboveHorizon,
      elevation,
      range,
      earthOccluded,
      aboveHorizon
    };
  }

  /**
   * Calculate next pass window for a satellite over a station
   * @param {Object} sat - Satellite
   * @param {Object} station - Ground station
   * @param {number} maxLookAhead - Maximum lookahead time (s)
   * @returns {Object} Pass window information
   */
  static calculateNextPass(sat, station, maxLookAhead = 86400) {
    // Simplified pass prediction - in reality this would involve
    // propagating the orbit and checking visibility at each step
    
    // For demo, return a simulated pass
    const randomDelay = 1000 + Math.random() * 5000;
    
    return {
      startTime: randomDelay,
      duration: 600 + Math.random() * 300, // 10-15 minutes
      maxElevation: 20 + Math.random() * 50,
      aosAzimuth: 90 + Math.random() * 180,
      losAzimuth: 90 + Math.random() * 180
    };
  }

  // ==========================================================================
  // TERMINATOR CALCULATIONS
  // ==========================================================================

  /**
   * Calculate terminator line points (day/night boundary)
   * @param {number} time - Current time (s)
   * @returns {Array} Array of { lat, lon } points
   */
  static calculateTerminator(time = 0) {
    const points = [];
    
    // Sun direction (simplified - assume sun at fixed direction in ECI)
    const sunDir = new THREE.Vector3(
      Math.cos(EARTH_ROT_RATE * time),
      0,
      Math.sin(EARTH_ROT_RATE * time)
    ).normalize();
    
    // Calculate terminator for each latitude
    for (let lat = -90; lat <= 90; lat += 5) {
      const latRad = lat * Math.PI / 180;
      
      // Solve for longitude where sun is at horizon
      // cos(θ) = -tan(φ) * tan(δ) where δ is sun declination
      // Simplified: assume sun declination = 0 (equator)
      const cosLon = 0; // Terminator at 90° from sun
      
      // Two points per latitude (morning and evening)
      let lonMorning = 90; // Simplified
      let lonEvening = -90;
      
      points.push({ lat, lon: lonMorning });
      points.push({ lat, lon: lonEvening });
    }
    
    return points;
  }

  // ==========================================================================
  // UTILITY FUNCTIONS
  // ==========================================================================

  /**
   * Calculate distance between two points on Earth's surface
   * @param {number} lat1 - Latitude 1 (deg)
   * @param {number} lon1 - Longitude 1 (deg)
   * @param {number} lat2 - Latitude 2 (deg)
   * @param {number} lon2 - Longitude 2 (deg)
   * @returns {number} Distance (km)
   */
  static greatCircleDistance(lat1, lon1, lat2, lon2) {
    const r = 6371; // Earth radius (km)
    
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const deltaLat = (lat2 - lat1) * Math.PI / 180;
    const deltaLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(deltaLat/2) * Math.sin(deltaLat/2) +
              Math.cos(lat1Rad) * Math.cos(lat2Rad) *
              Math.sin(deltaLon/2) * Math.sin(deltaLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return r * c;
  }

  /**
   * Calculate orbital period for given altitude
   * @param {number} altitude - Altitude (km)
   * @returns {number} Period (seconds)
   */
  static orbitalPeriod(altitude) {
    const a = RE + altitude;
    return 2 * Math.PI * Math.sqrt(a * a * a / MU);
  }

  /**
   * Calculate velocity for circular orbit at given altitude
   * @param {number} altitude - Altitude (km)
   * @returns {number} Velocity (km/s)
   */
  static circularVelocity(altitude) {
    const a = RE + altitude;
    return Math.sqrt(MU / a);
  }
}

export default OrbitCalculations;