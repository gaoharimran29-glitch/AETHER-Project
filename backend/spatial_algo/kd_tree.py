import logging
import numpy as np
from scipy.spatial import cKDTree

logger = logging.getLogger("AETHER.kd_tree")

WARNING_RADIUS   = 50.0   # km  — broad first-pass filter
COLLISION_RADIUS = 0.1    # km  = 100 m  (PS §3.3)


def check_for_conjunctions(satellites_data, debris_data):
    """
    Efficient O(N log M) sat–threat conjunction check using a KD-tree.
    Returns a list of dicts: { sat_id, deb_id, distance, collision_risk }
    """
    if not satellites_data or not debris_data:
        return []

    try:
        sat_coords = np.array(
            [[float(s.get("x", 0)), float(s.get("y", 0)), float(s.get("z", 0))]
             for s in satellites_data],
            dtype=float,
        )
        deb_coords = np.array(
            [[float(d.get("x", 0)), float(d.get("y", 0)), float(d.get("z", 0))]
             for d in debris_data],
            dtype=float,
        )

        if sat_coords.size == 0 or deb_coords.size == 0:
            return []

        logger.debug(
            f"KD-tree check: {len(satellites_data)} sats vs "
            f"{len(debris_data)} threats  (radius={WARNING_RADIUS} km)"
        )

        tree           = cKDTree(deb_coords, leafsize=16)
        nearby_indices = tree.query_ball_point(
            sat_coords, r=WARNING_RADIUS, workers=-1
        )

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

        logger.debug(f"KD-tree found {len(conjunctions)} conjunction(s)")
        return conjunctions

    except Exception as e:
        logger.error(f"Spatial check error: {e}", exc_info=True)
        return []
