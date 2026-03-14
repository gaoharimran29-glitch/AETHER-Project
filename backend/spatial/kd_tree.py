from scipy.spatial import ckdtree
import numpy as np

WARNING_RADIUS = 10.0      # km
COLLISION_RADIUS = 0.1     # km (100 meters)


def check_for_conjunctions(satellites_data, debris_data):

    if not satellites_data or not debris_data:
        return []

    try:

        sat_coords = np.asarray(
            [(s['x'], s['y'], s['z']) for s in satellites_data],
            dtype=float
        )

        deb_coords = np.asarray(
            [(d['x'], d['y'], d['z']) for d in debris_data],
            dtype=float
        )

        tree = ckdtree(deb_coords , leaf_size=16)

        nearby_indices = tree.query_ball_point(
            sat_coords,
            r=WARNING_RADIUS,
            workers=-1
        )

        conjunctions = []

        for sat_idx, deb_list in enumerate(nearby_indices):

            if not deb_list:
                continue

            sat_pos = sat_coords[sat_idx]

            for deb_idx in deb_list:

                deb_pos = deb_coords[deb_idx]

                dist = np.linalg.norm(sat_pos - deb_pos)

                conjunctions.append({
                    "sat_id": satellites_data[sat_idx]["id"],
                    "deb_id": debris_data[deb_idx]["id"],
                    "distance_km": float(dist),
                    "collision_risk": dist <= COLLISION_RADIUS
                })

        return conjunctions

    except Exception as e:

        print(f"Spatial Error: {e}")
        return []