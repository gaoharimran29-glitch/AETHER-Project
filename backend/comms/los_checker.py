import numpy as np
import pandas as pd

EARTH_RADIUS = 6378.137 

class LOSChecker:
    def __init__(self, csv_path="backend/data/ground_stations.csv"):
        self.raw_data = pd.read_csv(csv_path)
        self.stations = self.raw_data.to_dict('records')

    def get_rotating_gs_pos(self, station, sim_time_sec):
        # Earth rotation approximation (7.292115e-5 rad/s)
        theta = (7.292115e-5) * sim_time_sec
        
        lat = np.radians(station["lat"])
        lon = np.radians(station["lon"]) + theta # Rotation added
        r = EARTH_RADIUS + station.get("alt", 0)
        
        return np.array([
            r * np.cos(lat) * np.cos(lon),
            r * np.cos(lat) * np.sin(lon),
            r * np.sin(lat)
        ])

    def check_los(self, sat_pos, sim_time_sec=0, elevation_mask=10):
        visible = []
        min_sin_el = np.sin(np.radians(elevation_mask))
        
        for gs in self.stations:
            gs_pos = self.get_rotating_gs_pos(gs, sim_time_sec)
            rho_vec = sat_pos - gs_pos
            rho_mag = np.linalg.norm(rho_vec)
            
            # Elevation angle check
            # sin(el) = (rho_vec dot gs_unit_vec) / rho_mag
            gs_unit = gs_pos / np.linalg.norm(gs_pos)
            sin_el = np.dot(rho_vec, gs_unit) / rho_mag
            
            if sin_el >= min_sin_el:
                visible.append(gs["name"])
        return visible