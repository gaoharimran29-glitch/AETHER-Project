import numpy as np
import pandas as pd

EARTH_RADIUS = 6378.0  # km

class LOSChecker:

    def __init__(self, csv_path="data/ground_stations.csv"):
        self.stations = self.load_ground_stations(csv_path)

    def load_ground_stations(self, path):

        df = pd.read_csv(path)

        stations = []

        for _, row in df.iterrows():

            lat = np.radians(row["lat"])
            lon = np.radians(row["lon"])
            alt = float(row["alt"])

            r = EARTH_RADIUS + alt

            x = r * np.cos(lat) * np.cos(lon)
            y = r * np.cos(lat) * np.sin(lon)
            z = r * np.sin(lat)

            stations.append({
                "name": row["name"],
                "pos": np.array([x, y, z])
            })

        return stations


    def check_los(self, sat_pos):

        visible = []

        for gs in self.stations:

            gs_pos = gs["pos"]

            vec = sat_pos - gs_pos

            if np.dot(vec, gs_pos) > 0:
                visible.append(gs["name"])

        return visible
