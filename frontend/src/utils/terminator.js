// src/utils/terminator.js
// Terminator (day/night boundary) calculations — PS §6.2
const OBLIQUITY = 23.44 * Math.PI / 180;
const EARTH_ROT = 7.292115e-5;

class TerminatorCalculator {
  static getSunDirection(simTimeS = 0) {
    // Sun ecliptic longitude (approx, 1 year = 365.25 days)
    const dayOfYear = (simTimeS / 86400) % 365.25;
    const lambda = (dayOfYear / 365.25) * 2 * Math.PI;
    // Sun in ECI (fixed direction rotating with Earth)
    const gmst = EARTH_ROT * simTimeS;
    const sx = Math.cos(lambda - gmst);
    const sy = Math.sin(lambda - gmst) * Math.cos(OBLIQUITY);
    const sz = Math.sin(lambda - gmst) * Math.sin(OBLIQUITY);
    const mag = Math.sqrt(sx*sx+sy*sy+sz*sz);
    return [sx/mag, sy/mag, sz/mag];
  }

  // Returns array of {lat,lon} terminator points sorted by longitude for 2D map
  static calculateTerminatorPoints(simTimeS = 0, resolution = 180) {
    const [sx,sy,sz] = this.getSunDirection(simTimeS);
    const pts = [];
    for (let i = 0; i <= resolution; i++) {
      const lon = (i / resolution) * 360 - 180;
      const lonR = lon * Math.PI / 180;
      // Solve: sx*cos(lat)*cos(lon) + sy*cos(lat)*sin(lon) + sz*sin(lat) = 0
      const A = sx*Math.cos(lonR) + sy*Math.sin(lonR);
      const B = sz;
      if (Math.abs(A) < 1e-9) continue;
      const latR = Math.atan2(-A, B);
      const lat = latR * 180 / Math.PI;
      if (lat >= -90 && lat <= 90) pts.push({ lat, lon });
    }
    return pts.sort((a, b) => a.lon - b.lon);
  }

  static isInDaylight(lat, lon, simTimeS = 0) {
    const [sx,sy,sz] = this.getSunDirection(simTimeS);
    const latR = lat*Math.PI/180, lonR = lon*Math.PI/180;
    return Math.cos(latR)*Math.cos(lonR)*sx + Math.cos(latR)*Math.sin(lonR)*sy + Math.sin(latR)*sz > 0;
  }
}

export default TerminatorCalculator;