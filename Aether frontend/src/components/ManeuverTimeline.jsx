// src/components/ManeuverTimeline.jsx
import React, { useEffect, useState } from 'react';
import { format, addSeconds, differenceInSeconds, parseISO } from 'date-fns';
import { fetchBurnQueue, fetchStatus } from '../api/aetherApi';

const ManeuverTimeline = ({ satelliteId, onBurnClick }) => {
  const [burns, setBurns] = useState([]);
  const [cooldowns, setCooldowns] = useState([]);
  const [blackoutPeriods, setBlackoutPeriods] = useState([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [selectedBurn, setSelectedBurn] = useState(null);
  const [timelineRange, setTimelineRange] = useState({ start: new Date(), end: addSeconds(new Date(), 7200) }); // 2 hours
  const [loading, setLoading] = useState(true);

  // Fetch burns and status every second
  useEffect(() => {
    const loadData = async () => {
      try {
        const queue = await fetchBurnQueue();
        const status = await fetchStatus();
        
        // Update current simulation time
        if (status.sim_timestamp) {
          setCurrentTime(parseISO(status.sim_timestamp));
        }

        // Filter burns for this satellite
        const satBurns = queue.filter(b => b.sat_id === satelliteId);
        
        // Sort by time
        satBurns.sort((a, b) => 
          new Date(a.burn_time_iso) - new Date(b.burn_time_iso)
        );
        
        setBurns(satBurns);

        // Generate cooldown periods (600 seconds after each burn)
        const cd = [];
        const bp = [];
        
        satBurns.forEach((burn, index) => {
          const burnTime = new Date(burn.burn_time_iso);
          
          // Cooldown period
          cd.push({
            id: `cd-${burn.burn_id}`,
            start: burnTime,
            end: addSeconds(burnTime, 600),
            type: 'cooldown',
            burnId: burn.burn_id
          });

          // Simulate blackout periods (random for demo - in real app, this comes from LOS checker)
          // Blackouts occur when satellite is out of ground station coverage
          if (Math.random() > 0.7) {
            const blackoutStart = addSeconds(burnTime, -300 + (index * 100));
            const blackoutEnd = addSeconds(burnTime, 200 + (index * 50));
            bp.push({
              id: `bo-${burn.burn_id}`,
              start: blackoutStart,
              end: blackoutEnd,
              type: 'blackout',
              burnId: burn.burn_id
            });
          }
        });

        setCooldowns(cd);
        setBlackoutPeriods(bp);

      } catch (error) {
        console.error('Failed to load maneuver data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 1000);
    return () => clearInterval(interval);
  }, [satelliteId]);

  // Update timeline range to keep current time visible
  useEffect(() => {
    setTimelineRange({
      start: addSeconds(currentTime, -1800), // 30 minutes past
      end: addSeconds(currentTime, 5400)      // 90 minutes future
    });
  }, [currentTime]);

  // Calculate position percentage on timeline
  const getPositionPercent = (date) => {
    const totalSeconds = differenceInSeconds(timelineRange.end, timelineRange.start);
    const secondsFromStart = differenceInSeconds(date, timelineRange.start);
    return (secondsFromStart / totalSeconds) * 100;
  };

  // Check if a time is within timeline range
  const isInRange = (date) => {
    return date >= timelineRange.start && date <= timelineRange.end;
  };

  // Format time for display
  const formatTime = (date) => {
    return format(date, 'HH:mm:ss');
  };

  // Handle burn click
  const handleBurnClick = (burn) => {
    setSelectedBurn(selectedBurn === burn.burn_id ? null : burn.burn_id);
    if (onBurnClick) onBurnClick(burn);
  };

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-900 rounded">
        <div className="text-gray-400">Loading maneuver timeline...</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg p-4 font-mono">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-blue-400 font-bold text-lg">MANEUVER TIMELINE</h3>
          <p className="text-gray-500 text-xs">Satellite: {satelliteId}</p>
        </div>
        <div className="text-right">
          <div className="text-green-400 text-sm">{formatTime(currentTime)} UTC</div>
          <div className="text-gray-600 text-xs">Current Time</div>
        </div>
      </div>

      {/* Timeline Ruler */}
      <div className="relative h-8 mb-2 border-b border-gray-700">
        {/* Time markers - every 15 minutes */}
        {[0, 15, 30, 45, 60, 75, 90].map((minute) => {
          const markerTime = addSeconds(timelineRange.start, minute * 60);
          if (markerTime > timelineRange.end) return null;
          
          const left = getPositionPercent(markerTime);
          
          return (
            <div
              key={minute}
              className="absolute bottom-0 transform -translate-x-1/2"
              style={{ left: `${left}%` }}
            >
              <div className="h-2 w-px bg-gray-600"></div>
              <div className="text-gray-500 text-xs mt-1">
                {minute === 0 ? 'Now' : `+${minute}m`}
              </div>
            </div>
          );
        })}

        {/* Current time marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-green-500 z-20"
          style={{ left: `${getPositionPercent(currentTime)}%` }}
        >
          <div className="absolute -top-1 -left-1 w-2 h-2 bg-green-500 rounded-full"></div>
        </div>
      </div>

      {/* Timeline Canvas */}
      <div className="relative h-40 bg-gray-950 rounded border border-gray-800 mb-4 overflow-hidden">
        {/* Background grid */}
        <div className="absolute inset-0">
          {[0, 25, 50, 75, 100].map((percent) => (
            <div
              key={percent}
              className="absolute top-0 bottom-0 w-px bg-gray-800"
              style={{ left: `${percent}%` }}
            ></div>
          ))}
        </div>

        {/* Blackout periods (LOS gaps) */}
        {blackoutPeriods.map((period) => {
          if (!isInRange(period.start) && !isInRange(period.end)) return null;
          
          const start = Math.max(getPositionPercent(period.start), 0);
          const end = Math.min(getPositionPercent(period.end), 100);
          const width = end - start;
          
          return (
            <div
              key={period.id}
              className="absolute top-0 bottom-0 bg-red-900/30 border-l border-r border-red-700"
              style={{ left: `${start}%`, width: `${width}%` }}
            >
              <div className="absolute top-1 left-1 text-red-400 text-xs">
                ⚡ NO LOS
              </div>
              <div className="absolute bottom-1 right-1 text-red-600 text-xs">
                Blackout
              </div>
            </div>
          );
        })}

        {/* Cooldown periods */}
        {cooldowns.map((cd) => {
          if (!isInRange(cd.start) && !isInRange(cd.end)) return null;
          
          const start = Math.max(getPositionPercent(cd.start), 0);
          const end = Math.min(getPositionPercent(cd.end), 100);
          const width = end - start;
          
          return (
            <div
              key={cd.id}
              className="absolute top-0 bottom-0 bg-yellow-900/40 border-l border-r border-yellow-600"
              style={{ left: `${start}%`, width: `${width}%` }}
            >
              <div className="absolute top-1 left-1 text-yellow-400 text-xs flex items-center">
                <span className="mr-1">⏳</span> COOLDOWN
              </div>
              <div className="absolute bottom-1 right-1 text-yellow-600 text-xs">
                600s
              </div>
            </div>
          );
        })}

        {/* Burn events */}
        {burns.map((burn) => {
          const burnTime = new Date(burn.burn_time_iso);
          if (!isInRange(burnTime)) return null;
          
          const left = getPositionPercent(burnTime);
          const isSelected = selectedBurn === burn.burn_id;
          
          return (
            <div
              key={burn.burn_id}
              className={`absolute top-0 bottom-0 cursor-pointer transition-all duration-200 ${
                isSelected ? 'z-30' : 'z-20'
              }`}
              style={{ left: `${left}%` }}
              onClick={() => handleBurnClick(burn)}
            >
              {/* Burn marker line */}
              <div className={`absolute top-0 bottom-0 w-0.5 ${
                isSelected ? 'bg-blue-400' : 'bg-blue-600'
              }`}></div>
              
              {/* Burn indicator */}
              <div className={`absolute -top-6 left-1/2 transform -translate-x-1/2 whitespace-nowrap`}>
                <div className={`px-2 py-1 rounded text-xs font-bold ${
                  isSelected 
                    ? 'bg-blue-500 text-white ring-2 ring-blue-300' 
                    : 'bg-blue-600 text-white'
                }`}>
                  🔥 {burn.burn_id}
                </div>
              </div>

              {/* Burn details tooltip (shown when selected) */}
              {isSelected && (
                <div className="absolute top-8 left-1/2 transform -translate-x-1/2 bg-gray-800 border border-blue-500 rounded-lg p-2 text-xs z-40 w-48">
                  <div className="text-blue-400 font-bold mb-1">Burn Details</div>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Time:</span>
                      <span className="text-white">{formatTime(burnTime)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">ΔV:</span>
                      <span className="text-white">
                        [{burn.dv_x?.toFixed(3)}, {burn.dv_y?.toFixed(3)}, {burn.dv_z?.toFixed(3)}]
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Magnitude:</span>
                      <span className="text-yellow-400">
                        {Math.sqrt(
                          (burn.dv_x || 0)**2 + 
                          (burn.dv_y || 0)**2 + 
                          (burn.dv_z || 0)**2
                        ).toFixed(3)} km/s
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* "Now" indicator line */}
        <div
          className="absolute top-0 bottom-0 w-px bg-green-500 z-25"
          style={{ left: `${getPositionPercent(currentTime)}%` }}
        >
          <div className="absolute top-1 left-1 text-green-400 text-xs bg-gray-900 px-1">
            NOW
          </div>
        </div>
      </div>

      {/* Timeline controls */}
      <div className="flex justify-between items-center text-xs">
        <div className="flex space-x-2">
          <button className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">
            ⏪ 1h
          </button>
          <button className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">
            ◀ 15m
          </button>
          <button className="px-2 py-1 bg-blue-600 rounded hover:bg-blue-500">
            NOW
          </button>
          <button className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">
            15m ▶
          </button>
          <button className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">
            1h ▶▶
          </button>
        </div>

        <div className="text-gray-400">
          {formatTime(timelineRange.start)} - {formatTime(timelineRange.end)} UTC
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 pt-2 border-t border-gray-800 flex space-x-6 text-xs">
        <div className="flex items-center">
          <div className="w-3 h-3 bg-blue-600 rounded mr-2"></div>
          <span className="text-gray-400">Burn</span>
        </div>
        <div className="flex items-center">
          <div className="w-3 h-3 bg-yellow-900/40 border border-yellow-600 mr-2"></div>
          <span className="text-gray-400">Cooldown (600s)</span>
        </div>
        <div className="flex items-center">
          <div className="w-3 h-3 bg-red-900/30 border border-red-700 mr-2"></div>
          <span className="text-gray-400">Blackout (No LOS)</span>
        </div>
        <div className="flex items-center">
          <div className="w-3 h-3 bg-green-500 rounded-full mr-2"></div>
          <span className="text-gray-400">Current Time</span>
        </div>
      </div>

      {/* Upcoming burns summary */}
      <div className="mt-4 bg-gray-950 rounded p-3">
        <h4 className="text-gray-400 text-xs mb-2">📋 SCHEDULED MANEUVERS</h4>
        <div className="space-y-2 max-h-32 overflow-y-auto">
          {burns.length === 0 ? (
            <div className="text-gray-600 text-xs">No scheduled burns</div>
          ) : (
            burns.map((burn) => {
              const burnTime = new Date(burn.burn_time_iso);
              const secondsUntil = differenceInSeconds(burnTime, currentTime);
              const isPast = secondsUntil < 0;
              
              return (
                <div 
                  key={burn.burn_id}
                  className={`flex justify-between items-center p-2 rounded ${
                    isPast ? 'bg-gray-800/50' : 'bg-blue-900/20'
                  } ${selectedBurn === burn.burn_id ? 'ring-1 ring-blue-500' : ''}`}
                  onClick={() => handleBurnClick(burn)}
                >
                  <div className="flex items-center space-x-3">
                    <span className={`font-bold ${isPast ? 'text-gray-600' : 'text-blue-400'}`}>
                      {burn.burn_id}
                    </span>
                    <span className="text-gray-400 text-xs">
                      {formatTime(burnTime)}
                    </span>
                  </div>
                  <div className="flex items-center space-x-4">
                    <span className={`text-xs ${
                      secondsUntil < 0 ? 'text-gray-600' :
                      secondsUntil < 300 ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {secondsUntil < 0 
                        ? `${Math.abs(secondsUntil)}s ago` 
                        : `in ${secondsUntil}s`}
                    </span>
                    <span className="text-xs text-gray-400">
                      |ΔV|: {Math.sqrt(
                        (burn.dv_x || 0)**2 + 
                        (burn.dv_y || 0)**2 + 
                        (burn.dv_z || 0)**2
                      ).toFixed(3)} km/s
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Conflict warning */}
      {burns.length > 1 && burns.some((burn, i) => {
        if (i === 0) return false;
        const prevTime = new Date(burns[i-1].burn_time_iso);
        const currTime = new Date(burn.burn_time_iso);
        return differenceInSeconds(currTime, prevTime) < 600;
      }) && (
        <div className="mt-2 bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-400">
          ⚠️ WARNING: Burns scheduled within cooldown period of each other!
        </div>
      )}
    </div>
  );
};

export default ManeuverTimeline;