// src/components/BullseyePlot.jsx
import React, { useEffect, useRef, useState } from 'react';
import { fetchConjunctionForecast } from '../api/aetherApi';

const BullseyePlot = ({ satelliteId, conjunctions = [] }) => {
  const canvasRef = useRef(null);
  const [localConjunctions, setLocalConjunctions] = useState([]);
  const [selectedDebris, setSelectedDebris] = useState(null);

  // Fetch conjunctions if not provided as props
  useEffect(() => {
    if (conjunctions.length === 0) {
      const loadConjunctions = async () => {
        try {
          const data = await fetchConjunctionForecast();
          // Filter for this satellite
          const satConj = (data.forecast || []).filter(c => c.sat_id === satelliteId);
          setLocalConjunctions(satConj);
        } catch (error) {
          console.error('Failed to load conjunctions:', error);
        }
      };
      loadConjunctions();
    }
  }, [satelliteId, conjunctions]);

  // Use either prop or local conjunctions
  const activeConjunctions = conjunctions.length > 0 ? conjunctions : localConjunctions;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.4;

    // Clear canvas with dark background
    ctx.clearRect(0, 0, width, height);
    
    // Draw dark background
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, width, height);

    // Draw outer border
    ctx.strokeStyle = '#2a3a4a';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, width - 4, height - 4);

    // Draw title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('CONJUNCTION BULLSEYE', 20, 30);
    
    // Draw selected satellite
    ctx.fillStyle = '#3b82f6';
    ctx.font = '12px monospace';
    ctx.fillText(`Target: ${satelliteId}`, 20, 55);

    // Draw concentric circles (time rings)
    const timeRings = [5, 10, 15, 20, 25, 30]; // seconds to TCA
    
    timeRings.forEach((seconds, index) => {
      const radius = (seconds / 30) * maxRadius;
      
      // Circle
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = index === 0 ? '#ef4444' : '#2a4a6a';
      ctx.lineWidth = index === 0 ? 2 : 1;
      ctx.stroke();

      // Time label
      ctx.fillStyle = '#8a9aaa';
      ctx.font = '10px monospace';
      ctx.fillText(`${seconds}s`, centerX + radius + 5, centerY - 5);
    });

    // Draw crosshairs
    ctx.beginPath();
    ctx.moveTo(centerX - maxRadius - 10, centerY);
    ctx.lineTo(centerX + maxRadius + 10, centerY);
    ctx.moveTo(centerX, centerY - maxRadius - 10);
    ctx.lineTo(centerX, centerY + maxRadius + 10);
    ctx.strokeStyle = '#1a3a5a';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw degree markers
    for (let angle = 0; angle < 360; angle += 30) {
      const rad = (angle * Math.PI) / 180;
      const x1 = centerX + (maxRadius + 10) * Math.cos(rad);
      const y1 = centerY + (maxRadius + 10) * Math.sin(rad);
      const x2 = centerX + (maxRadius + 20) * Math.cos(rad);
      const y2 = centerY + (maxRadius + 20) * Math.sin(rad);
      
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = '#2a4a6a';
      ctx.stroke();

      // Angle label
      ctx.fillStyle = '#8a9aaa';
      ctx.font = '10px monospace';
      ctx.fillText(`${angle}°`, x2 + 5, y2 - 5);
    }

    // Plot debris threats
    if (activeConjunctions.length > 0) {
      activeConjunctions.forEach((conj, index) => {
        // Calculate position based on TCA (radial distance)
        // Normalize TCA to max 30 seconds for visualization
        const tcaSeconds = Math.min(conj.tca_offset_s || 15, 30);
        const radius = (tcaSeconds / 30) * maxRadius;
        
        // Use debris ID hash to generate consistent angle
        const angleHash = conj.deb_id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const angle = (angleHash % 360) * Math.PI / 180;
        
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);

        // Determine color based on severity and distance
        let color;
        let glowColor;
        const distance = conj.min_dist_km || 0;
        
        if (conj.severity === 'CRITICAL' || distance < 1.0) {
          color = '#ef4444'; // Red
          glowColor = 'rgba(239, 68, 68, 0.5)';
        } else if (conj.severity === 'WARNING' || distance < 5.0) {
          color = '#f59e0b'; // Orange
          glowColor = 'rgba(245, 158, 11, 0.5)';
        } else {
          color = '#10b981'; // Green
          glowColor = 'rgba(16, 185, 129, 0.3)';
        }

        // Draw glow effect
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 15;
        
        // Draw threat marker
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        
        // Draw inner white dot
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Reset shadow
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';

        // Draw debris ID
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(conj.deb_id.slice(-4), x - 15, y - 15);

        // Draw distance label
        ctx.fillStyle = '#cccccc';
        ctx.font = '8px monospace';
        ctx.fillText(`${distance.toFixed(3)} km`, x - 12, y - 25);

        // Draw line to center (approach vector)
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Add hover effect for selected debris
        if (selectedDebris === conj.deb_id) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 12, 0, 2 * Math.PI);
          ctx.stroke();
        }
      });
    } else {
      // No threats message
      ctx.fillStyle = '#4a6a8a';
      ctx.font = '14px monospace';
      ctx.fillText('NO ACTIVE CONJUNCTIONS', centerX - 100, centerY);
    }

    // Draw center satellite marker
    // Outer glow
    ctx.shadowColor = '#3b82f6';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 12, 0, 2 * Math.PI);
    ctx.fillStyle = '#3b82f6';
    ctx.fill();
    
    // Inner core
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    
    // Reset shadow
    ctx.shadowBlur = 0;

    // Draw center label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('SAT', centerX - 15, centerY - 20);

    // Draw legend
    const legendY = height - 80;
    
    // Critical
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(20, legendY, 15, 15);
    ctx.fillStyle = '#ffffff';
    ctx.font = '11px monospace';
    ctx.fillText('Critical (<1km)', 40, legendY + 12);

    // Warning
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(20, legendY + 20, 15, 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Warning (<5km)', 40, legendY + 32);

    // Safe
    ctx.fillStyle = '#10b981';
    ctx.fillRect(20, legendY + 40, 15, 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Safe', 40, legendY + 52);

    // Time legend
    ctx.fillStyle = '#8a9aaa';
    ctx.font = '10px monospace';
    ctx.fillText('Distance from center = Time to TCA', width - 220, legendY + 12);
    ctx.fillText('Angle = Approach direction', width - 220, legendY + 27);

    // Stats box
    ctx.fillStyle = '#1a2a3a';
    ctx.fillRect(width - 200, 20, 180, 70);
    ctx.strokeStyle = '#3a5a7a';
    ctx.lineWidth = 1;
    ctx.strokeRect(width - 200, 20, 180, 70);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('CONJUNCTION STATS', width - 190, 40);
    
    ctx.font = '11px monospace';
    ctx.fillStyle = '#ef4444';
    ctx.fillText(`Critical: ${activeConjunctions.filter(c => c.severity === 'CRITICAL' || (c.min_dist_km || 0) < 1).length}`, width - 190, 60);
    
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`Warning: ${activeConjunctions.filter(c => c.severity === 'WARNING' || ((c.min_dist_km || 0) >= 1 && (c.min_dist_km || 0) < 5)).length}`, width - 190, 75);
    
    ctx.fillStyle = '#10b981';
    ctx.fillText(`Safe: ${activeConjunctions.filter(c => c.severity === 'SAFE' || (c.min_dist_km || 0) >= 5).length}`, width - 190, 90);

  }, [activeConjunctions, satelliteId, selectedDebris]);

  // Handle debris selection
  const handleCanvasClick = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const mouseX = (event.clientX - rect.left) * scaleX;
    const mouseY = (event.clientY - rect.top) * scaleY;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const maxRadius = Math.min(canvas.width, canvas.height) * 0.4;

    // Check each debris marker for click
    let found = false;
    activeConjunctions.forEach((conj) => {
      const tcaSeconds = Math.min(conj.tca_offset_s || 15, 30);
      const radius = (tcaSeconds / 30) * maxRadius;
      const angleHash = conj.deb_id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const angle = (angleHash % 360) * Math.PI / 180;
      
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      
      // Check if click is within 15 pixels of marker
      const distance = Math.sqrt((mouseX - x) ** 2 + (mouseY - y) ** 2);
      if (distance < 15) {
        setSelectedDebris(conj.deb_id);
        found = true;
      }
    });

    if (!found) {
      setSelectedDebris(null);
    }
  };

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        width={700}
        height={700}
        className="w-full h-full cursor-pointer"
        onClick={handleCanvasClick}
      />
      
      {/* Selected debris info panel */}
      {selectedDebris && (
        <div className="absolute bottom-4 right-4 bg-gray-900/90 border border-blue-500 rounded-lg p-3 text-sm">
          <h4 className="text-blue-400 font-bold mb-2">Selected Debris</h4>
          {activeConjunctions
            .filter(c => c.deb_id === selectedDebris)
            .map((conj, i) => (
              <div key={i} className="space-y-1">
                <p><span className="text-gray-400">ID:</span> {conj.deb_id}</p>
                <p><span className="text-gray-400">Distance:</span> {conj.min_dist_km?.toFixed(3)} km</p>
                <p><span className="text-gray-400">TCA:</span> {conj.tca_offset_s?.toFixed(1)} s</p>
                <p><span className="text-gray-400">Severity:</span> 
                  <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                    conj.severity === 'CRITICAL' ? 'bg-red-600' :
                    conj.severity === 'WARNING' ? 'bg-yellow-600' : 'bg-green-600'
                  }`}>
                    {conj.severity}
                  </span>
                </p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};

export default BullseyePlot;