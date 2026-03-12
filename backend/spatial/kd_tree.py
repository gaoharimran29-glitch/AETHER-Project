from scipy.spatial import KDTree
import numpy as np

def check_for_conjunctions(satellites_data, debris_data):
    """
    satellites_data: List of dicts from Redis
    debris_data: List of dicts from Redis
    """
    # Safety Check: If there is any empty list, then no need to check conjuction
    if not debris_data or not satellites_data:
        return []

    try:
        # 1. Extract Coordinates
        deb_coords = np.array([[float(d['x']), float(d['y']), float(d['z'])] for d in debris_data])
        sat_coords = np.array([[float(s['x']), float(s['y']), float(s['z'])] for s in satellites_data])
        
        # 2. Build KD-Tree
        tree = KDTree(deb_coords)
        
        # 3. Search in 10km radius (Warning Zone)
        indices = tree.query_ball_point(sat_coords, r=10.0) 
        
        conjunctions = []
        
        # 4. Parse Results
        for i, deb_idx_list in enumerate(indices):
            for deb_idx in deb_idx_list:
                # Calculate actual distance for exact precision
                dist = np.linalg.norm(sat_coords[i] - deb_coords[deb_idx])
                
                conjunctions.append({
                    "sat_id": satellites_data[i]['id'],
                    "deb_id": debris_data[deb_idx]['id'],
                    "distance": float(dist) # float to make J2 serialization
                })
        
        return conjunctions

    except Exception as e:
        print(f"Spatial Error: {e}")
        return []