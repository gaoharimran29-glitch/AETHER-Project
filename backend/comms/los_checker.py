import logging
import numpy as np
import pandas as pd

logger = logging.getLogger("AETHER.los_checker")

EARTH_RADIUS = 6378.137    # km
EARTH_ROT    = 7.292115e-5  # rad/s


class LOSChecker:
    def __init__(self, csv_path: str):
        df             = pd.read_csv(csv_path)
        self.stations  = df.to_dict("records")
        logger.info(f"LOSChecker loaded {len(self.stations)} ground stations "
                    f"from {csv_path}")

    def _get_gs_eci(self, station: dict, sim_time_s: float) -> np.ndarray:
        """
        Return the ECI position of a ground station at the given simulation
        time, accounting for Earth's rotation  (PS §5.4).

        Reads the exact CSV column names produced by the hackathon dataset:
            Latitude, Longitude, Elevation_m
        """
        lat_deg = float(station.get("Latitude",    station.get("lat",   0.0)))
        lon_deg = float(station.get("Longitude",   station.get("lon",   0.0)))
        alt_m   = float(station.get("Elevation_m", station.get("alt",   0.0)))

        # Earth rotation offset
        theta = EARTH_ROT * sim_time_s

        lat_r  = np.radians(lat_deg)
        lon_r  = np.radians(lon_deg) + theta
        r_surf = EARTH_RADIUS + alt_m / 1000.0

        return np.array([
            r_surf * np.cos(lat_r) * np.cos(lon_r),
            r_surf * np.cos(lat_r) * np.sin(lon_r),
            r_surf * np.sin(lat_r),
        ])

    def check_los(self, sat_pos: np.ndarray, sim_time_s: float = 0.0) -> list:
        """
        Returns a list of station names that have clear LOS to sat_pos.
        Uses per-station minimum elevation angle mask  (PS §5.5.1).

        Parameters
        ----------
        sat_pos      : ECI position of satellite (km)
        sim_time_s   : current simulation time (s) for Earth rotation
        """
        visible = []
        sat_pos = np.asarray(sat_pos, dtype=float)

        for gs in self.stations:
            # Per-station elevation mask  (PS §5.5.1)
            min_el = float(gs.get("Min_Elevation_Angle_deg",
                                  gs.get("min_el_deg", 5.0)))

            gs_pos  = self._get_gs_eci(gs, sim_time_s)
            rho_vec = sat_pos - gs_pos
            rho_mag = float(np.linalg.norm(rho_vec))
            if rho_mag < 1e-6:
                continue

            # Earth occlusion check (ray-sphere test)
            a    = float(np.dot(rho_vec, rho_vec))
            b    = float(2.0 * np.dot(gs_pos, rho_vec))
            c    = float(np.dot(gs_pos, gs_pos) - EARTH_RADIUS ** 2)
            disc = b * b - 4.0 * a * c
            if disc > 0:
                t1 = (-b - np.sqrt(disc)) / (2.0 * a)
                t2 = (-b + np.sqrt(disc)) / (2.0 * a)
                if (0.0 < t1 < 1.0) or (0.0 < t2 < 1.0):
                    continue   # Earth blocks LOS

            # Elevation angle above local horizon
            gs_unit   = gs_pos / np.linalg.norm(gs_pos)
            cos_angle = float(np.clip(
                np.dot(rho_vec / rho_mag, gs_unit), -1.0, 1.0))
            elevation = np.degrees(np.arcsin(cos_angle))

            if elevation >= min_el:
                name = gs.get("Station_Name", gs.get("name", "unknown"))
                visible.append(name)

        return visible

    def has_any_los(self, sat_pos: np.ndarray, sim_time_s: float = 0.0) -> bool:
        """Convenience wrapper — True if any station can see the satellite."""
        return len(self.check_los(sat_pos, sim_time_s)) > 0
