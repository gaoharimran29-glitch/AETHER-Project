from scipy.spatial import cKDTree
import numpy as np

WARNING_RADIUS = 50.0      # km
COLLISION_RADIUS = 0.1     # km (100 meters)

def check_for_conjunctions(satellites_data, debris_data):
    if not satellites_data or not debris_data:
        return []

    try:
        print(f"DEBUG DATA: Sat 1 -> {satellites_data[0]}")
        sat_coords = np.array([
            [float(s.get('x', 0)), float(s.get('y', 0)), float(s.get('z', 0))] 
            for s in satellites_data
        ], dtype=float)

        deb_coords = np.array([
            [float(d.get('x', 0)), float(d.get('y', 0)), float(d.get('z', 0))] 
            for d in debris_data
        ], dtype=float)
        print(f"DEBUG DISTANCE: Sat at ({sat_coords[0][0]:.2f}, {sat_coords[0][1]:.2f})")
        print(f"DEBUG DISTANCE: Deb at ({deb_coords[0][0]:.2f}, {deb_coords[0][1]:.2f})")

        actual_dist = np.linalg.norm(sat_coords[0] - deb_coords[0])
        print(f"DEBUG DISTANCE: Actual distance is {actual_dist:.4f} km")
        # Force check for empty arrays after conversion
        if sat_coords.size == 0 or deb_coords.size == 0:
            return []

        tree = cKDTree(deb_coords, leafsize=16)
        nearby_indices = tree.query_ball_point(sat_coords, r=WARNING_RADIUS, workers=-1)

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
                    "distance": float(dist), # Ensure key is 'distance' as main.py expects
                    "collision_risk": dist <= COLLISION_RADIUS
                })

        return conjunctions

    except Exception as e:
        print(f"Spatial Error: {e}")
        import traceback
        traceback.print_exc()
        return []