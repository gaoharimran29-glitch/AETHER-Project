"""
AETHER — KD-Tree Spatial Conjunction Check
O(N log M) sat-vs-threat proximity detection using scipy cKDTree.  PS §2

Design
------
Two-stage filter:
    Stage 1 (KD-tree, broad)  : WARNING_RADIUS = 50 km  — fast spatial index
    Stage 2 (exact distance)  : computed for every pair that passed stage 1

Thread-safety note
------------------
    cKDTree.query_ball_point with workers > 1 requires the GIL to be released
    and can fail inside some Docker/OS environments.  We default to workers=1
    and fall back gracefully if the call raises.
"""

import logging
import numpy as np
from scipy.spatial import cKDTree

logger = logging.getLogger("AETHER.kd_tree")

WARNING_RADIUS   = 50.0    # km  — broad pre-filter radius
COLLISION_RADIUS = 0.1     # km  = 100 m  (PS §3.3)


def check_for_conjunctions(
    satellites_data: list,
    debris_data: list,
) -> list:
    """
    Efficient O(N log M) conjunction check.

    Parameters
    ----------
    satellites_data : list[dict]
        Each dict must have keys: "id", "x", "y", "z".
    debris_data     : list[dict]
        Same schema; may be the same list for sat-sat checks.

    Returns
    -------
    list[dict] with keys:
        sat_id, deb_id, distance (km), collision_risk (bool)
    """
    if not satellites_data or not debris_data:
        return []

    try:
        sat_coords = np.array(
            [[float(s.get("x", 0.0)),
              float(s.get("y", 0.0)),
              float(s.get("z", 0.0))]
             for s in satellites_data],
            dtype=float,
        )
        deb_coords = np.array(
            [[float(d.get("x", 0.0)),
              float(d.get("y", 0.0)),
              float(d.get("z", 0.0))]
             for d in debris_data],
            dtype=float,
        )

        if sat_coords.size == 0 or deb_coords.size == 0:
            return []

        logger.debug(
            "KD-tree: %d sats vs %d threats (r=%.0f km)",
            len(satellites_data), len(debris_data), WARNING_RADIUS,
        )

        tree = cKDTree(deb_coords, leafsize=16)

        # Use workers=1 — safe across all platforms (Docker, macOS, Linux)
        try:
            nearby_indices = tree.query_ball_point(
                sat_coords, r=WARNING_RADIUS, workers=1
            )
        except TypeError:
            # Older scipy versions don't have workers= parameter
            nearby_indices = tree.query_ball_point(sat_coords, r=WARNING_RADIUS)

        conjunctions = []
        for sat_idx, deb_list in enumerate(nearby_indices):
            if not deb_list:
                continue
            sat_pos = sat_coords[sat_idx]
            for deb_idx in deb_list:
                deb_pos = deb_coords[deb_idx]
                dist    = float(np.linalg.norm(sat_pos - deb_pos))
                conjunctions.append({
                    "sat_id":         satellites_data[sat_idx]["id"],
                    "deb_id":         debris_data[deb_idx]["id"],
                    "distance":       dist,
                    "collision_risk": dist <= COLLISION_RADIUS,
                })

        logger.debug("KD-tree found %d conjunction(s)", len(conjunctions))
        return conjunctions

    except Exception as exc:
        logger.error("Spatial check error: %s", exc, exc_info=True)
        return []