import React, { useState, useEffect } from 'react';
import { fetchSnapshot } from '../api/aetherApi';

function DebrisCloud() {
  const [debris, setDebris] = useState([]);

  useEffect(() => {
    const loadData = async () => {
      const snapshot = await fetchSnapshot();
      setDebris(snapshot.debris_cloud || []);
    };

    loadData();

    // Refresh every second
    const interval = setInterval(loadData, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full h-96 bg-gray-900 text-white p-4 overflow-auto">
      <h2>Debris Cloud Data</h2>

      {debris.length === 0 ? (
        <p>No debris data available</p>
      ) : (
        debris.map((item, index) => (
          <div key={index}>
            {JSON.stringify(item)}
          </div>
        ))
      )}
    </div>
  );
}

export default DebrisCloud;