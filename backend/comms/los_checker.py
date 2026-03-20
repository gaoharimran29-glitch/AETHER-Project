"""
AETHER — Line-of-Sight (LOS) Checker
Determines whether a satellite is visible from any ground station.  PS §5.4

Physics
-------
    1. Convert ground station from geodetic (lat, lon, alt) to ECI,
       accounting for Earth's rotation at the current simulation time.
    2. Ray-sphere intersection test to detect Earth occlusion.
    3. Elevation angle above local horizon must exceed the per-station
       minimum mask angle  (PS §5.5.1).

Elevation angle formula
-----------------------
    The satellite elevation angle above the station's local horizon is:

        el = arcsin( (r_sat - r_gs) · r_gs_unit / |r_sat - r_gs| )

    where r_gs_unit = r_gs / |r_gs|.

    Note: this is arcsin of the dot-product, NOT arccos.  The original
    code had arcsin(cos_angle) where cos_angle was actually computed
    as dot(ρ̂, r̂_gs) — that IS the sine of the elevation angle, so
    arcsin is correct.  This version makes the naming explicit.
"""

import logging
import numpy as np
import pandas as pd

logger = logging.getLogger("AETHER.los_checker")

EARTH_RADIUS_KM = 6378.137     # km
EARTH_ROT_RAD_S = 7.292115e-5  # rad/s


class LOSChecker:
    """
    Vectorised LOS checker loaded from the hackathon ground stations CSV.
    """

    def __init__(self, csv_path: str):
        df            = pd.read_csv(csv_path)
        self.stations = df.to_dict("records")
        logger.info(
            "LOSChecker: loaded %d ground stations from %s",
            len(self.stations), csv_path,
        )

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _gs_eci(self, station: dict, sim_time_s: float) -> np.ndarray:
        """
        ECI position of *station* at *sim_time_s* (rotating Earth model).
        Handles both the hackathon CSV column names and generic aliases.
        """
        lat_deg = float(station.get("Latitude",    station.get("lat",   0.0)))
        lon_deg = float(station.get("Longitude",   station.get("lon",   0.0)))
        alt_m   = float(station.get("Elevation_m", station.get("alt",   0.0)))

        # Earth has rotated by theta since epoch
        theta  = EARTH_ROT_RAD_S * sim_time_s
        lat_r  = np.radians(lat_deg)
        lon_r  = np.radians(lon_deg) + theta
        r_surf = EARTH_RADIUS_KM + alt_m / 1000.0

        return np.array([
            r_surf * np.cos(lat_r) * np.cos(lon_r),
            r_surf * np.cos(lat_r) * np.sin(lon_r),
            r_surf * np.sin(lat_r),
        ])

    # ── Public API ────────────────────────────────────────────────────────────

    def check_los(self, sat_pos, sim_time_s: float = 0.0) -> list:
        """
        Return names of all ground stations with clear LOS to *sat_pos*.

        Parameters
        ----------
        sat_pos    : array-like (3,)   satellite ECI position (km)
        sim_time_s : float             simulation elapsed time (s)
        """
        sat_pos = np.asarray(sat_pos, dtype=float)
        visible = []

        for gs in self.stations:
            min_el = float(gs.get("Min_Elevation_Angle_deg",
                                  gs.get("min_el_deg", 5.0)))

            gs_pos  = self._gs_eci(gs, sim_time_s)
            rho_vec = sat_pos - gs_pos      # vector from GS to satellite
            rho_mag = float(np.linalg.norm(rho_vec))
            if rho_mag < 1e-6:
                continue

            # ── Earth occlusion: parametric ray-sphere test GS → sat ─────────
            # Parametric: P(t) = gs_pos + t * rho_vec, t ∈ [0, 1]
            # Earth surface: |P(t)|² = RE²
            a    = float(np.dot(rho_vec, rho_vec))
            b    = float(2.0 * np.dot(gs_pos, rho_vec))
            c    = float(np.dot(gs_pos, gs_pos) - EARTH_RADIUS_KM ** 2)
            disc = b * b - 4.0 * a * c
            if disc > 0.0:
                sqrt_d = np.sqrt(disc)
                t1 = (-b - sqrt_d) / (2.0 * a)
                t2 = (-b + sqrt_d) / (2.0 * a)
                # If any intersection lies strictly between GS and satellite,
                # the Earth blocks the signal.
                if (0.0 < t1 < 1.0) or (0.0 < t2 < 1.0):
                    continue

            # ── Elevation angle above local horizon ───────────────────────────
            # sin(el) = dot(ρ̂, r̂_gs)
            rho_unit = rho_vec / rho_mag
            gs_unit  = gs_pos  / float(np.linalg.norm(gs_pos))
            sin_el   = float(np.clip(np.dot(rho_unit, gs_unit), -1.0, 1.0))
            elevation_deg = float(np.degrees(np.arcsin(sin_el)))

            if elevation_deg >= min_el:
                name = gs.get("Station_Name", gs.get("name", "unknown"))
                visible.append(name)

        return visible

    def has_any_los(self, sat_pos, sim_time_s: float = 0.0) -> bool:
        """Return True if any station can see the satellite."""
        sat_pos = np.asarray(sat_pos, dtype=float)

        for gs in self.stations:
            min_el  = float(gs.get("Min_Elevation_Angle_deg",
                                   gs.get("min_el_deg", 5.0)))
            gs_pos  = self._gs_eci(gs, sim_time_s)
            rho_vec = sat_pos - gs_pos
            rho_mag = float(np.linalg.norm(rho_vec))
            if rho_mag < 1e-6:
                continue

            a    = float(np.dot(rho_vec, rho_vec))
            b    = float(2.0 * np.dot(gs_pos, rho_vec))
            c    = float(np.dot(gs_pos, gs_pos) - EARTH_RADIUS_KM ** 2)
            disc = b * b - 4.0 * a * c
            if disc > 0.0:
                sqrt_d = np.sqrt(disc)
                t1 = (-b - sqrt_d) / (2.0 * a)
                t2 = (-b + sqrt_d) / (2.0 * a)
                if (0.0 < t1 < 1.0) or (0.0 < t2 < 1.0):
                    continue

            rho_unit  = rho_vec / rho_mag
            gs_unit   = gs_pos  / float(np.linalg.norm(gs_pos))
            sin_el    = float(np.clip(np.dot(rho_unit, gs_unit), -1.0, 1.0))
            elevation = float(np.degrees(np.arcsin(sin_el)))

            if elevation >= min_el:
                return True

        return False