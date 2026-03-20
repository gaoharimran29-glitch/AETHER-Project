// src/components/ManeuverTimeline.jsx
// PS §6.2 — Maneuver Timeline Gantt: burns, 600s cooldown blocks, blackout zones
import React, { useEffect, useState, useCallback } from 'react';
import { format, addSeconds, differenceInSeconds, parseISO } from 'date-fns';
import { fetchBurnQueue, fetchStatus, fetchNextPass } from '../api/aetherApi';

export default function ManeuverTimeline({ satelliteId, onBurnClick }) {
  const [burns,     setBurns]     = useState([]);
  const [cooldowns, setCooldowns] = useState([]);
  const [blackouts, setBlackouts] = useState([]);
  const [now,       setNow]       = useState(new Date());
  const [sel,       setSel]       = useState(null);
  const [range,     setRange]     = useState({ start:new Date(), end:addSeconds(new Date(),7200) });
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [queue, status, pass] = await Promise.all([
          fetchBurnQueue(),
          fetchStatus(),
          satelliteId ? fetchNextPass(satelliteId) : Promise.resolve(null),
        ]);
        const simNow = status?.sim_timestamp ? parseISO(status.sim_timestamp) : new Date();
        setNow(simNow);

        const satBurns = queue
          .filter(b => !satelliteId || b.sat_id === satelliteId)
          .sort((a,b) => new Date(a.burn_time_iso) - new Date(b.burn_time_iso));
        setBurns(satBurns);
        setCooldowns(satBurns.map(b => ({
          id: `cd-${b.burn_id}`,
          start: new Date(b.burn_time_iso),
          end:   addSeconds(new Date(b.burn_time_iso), 600),
        })));

        // Build blackout zones from next-pass estimates
        if (pass?.upcoming_passes) {
          const bz = []; let cursor = simNow;
          pass.upcoming_passes.forEach(p => {
            const wait = p.estimated_wait_seconds || 0;
            if (wait > 90) bz.push({ id:`bo-${p.station}`, start:addSeconds(cursor,20), end:addSeconds(cursor,wait-20), station:p.station });
            cursor = addSeconds(cursor, wait + 600);
          });
          setBlackouts(bz.slice(0, 8));
        }
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [satelliteId]);

  useEffect(() => {
    setRange({ start:addSeconds(now,-1800), end:addSeconds(now,5400) });
  }, [now]);

  const totalS   = differenceInSeconds(range.end, range.start);
  const pct      = useCallback(d => Math.max(0, Math.min(100, (differenceInSeconds(d, range.start) / totalS) * 100)), [range, totalS]);
  const inRange  = useCallback(d => d >= range.start && d <= range.end, [range]);
  const shift    = useCallback(delta => setRange(r => ({ start:addSeconds(r.start,delta), end:addSeconds(r.end,delta) })), []);
  const jumpNow  = useCallback(() => setRange({ start:addSeconds(now,-1800), end:addSeconds(now,5400) }), [now]);

  const conflict = burns.some((b,i) => i>0 && differenceInSeconds(new Date(b.burn_time_iso), new Date(burns[i-1].burn_time_iso)) < 600);

  if (loading) return (
    <div className="w-full h-full flex items-center justify-center" style={{ background:'rgba(2,8,18,.95)' }}>
      <span style={{ color:'#334155', fontSize:11, fontFamily:"'Share Tech Mono',monospace" }}>Loading timeline…</span>
    </div>
  );

  return (
    <div className="w-full h-full flex flex-col gap-2 p-3 overflow-hidden" style={{ background:'rgba(2,8,18,.95)', fontFamily:"'Share Tech Mono',monospace" }}>

      {/* Header */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div>
          <div style={{ fontFamily:"'Orbitron',sans-serif", fontSize:10, letterSpacing:'0.15em', color:'#f59e0b' }}>MANEUVER TIMELINE</div>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{satelliteId || 'All Satellites'} · Gantt · PS §6.2</div>
        </div>
        <div style={{ fontFamily:"'Orbitron',monospace", fontSize:12, color:'#10b981' }}>{format(now,'HH:mm:ss')} SIM</div>
      </div>

      {/* Time ruler */}
      <div className="relative flex-shrink-0" style={{ height:28, borderBottom:'1px solid rgba(30,80,160,0.2)' }}>
        {[-30,-15,0,15,30,45,60,75,90].map(min => {
          const t    = addSeconds(now, min*60);
          const left = pct(t);
          if (left < 0 || left > 100) return null;
          return (
            <div key={min} className="absolute bottom-0" style={{ left:`${left}%`, transform:'translateX(-50%)' }}>
              <div style={{ width:1, height:6, background:'rgba(30,80,160,0.4)', margin:'0 auto' }} />
              <div style={{ fontSize:10, color:'rgba(90,130,200,0.8)', whiteSpace:'nowrap', marginTop:1, fontFamily:"'Orbitron',monospace" }}>
                {min===0?'NOW':`${min>0?'+':''}${min}m`}
              </div>
            </div>
          );
        })}
        {/* Now line */}
        <div style={{ position:'absolute', top:0, bottom:0, left:`${pct(now)}%`, width:1, background:'#10b981', zIndex:10 }}>
          <div style={{ width:5, height:5, background:'#10b981', borderRadius:'50%', marginLeft:-2 }} />
        </div>
      </div>

      {/* Timeline canvas */}
      <div className="relative flex-1 min-h-0 rounded border overflow-hidden" style={{ borderColor:'rgba(30,80,160,0.2)', background:'rgba(1,6,15,.8)' }}>
        {/* Grid lines */}
        {[0,25,50,75,100].map(p => (
          <div key={p} style={{ position:'absolute', top:0, bottom:0, left:`${p}%`, width:1, background:'rgba(30,80,160,0.1)' }} />
        ))}

        {/* Blackout zones */}
        {blackouts.map(bz => {
          const s = Math.max(pct(bz.start), 0), e = Math.min(pct(bz.end), 100);
          if (e <= s) return null;
          return (
            <div key={bz.id} style={{ position:'absolute', top:0, bottom:0, left:`${s}%`, width:`${e-s}%`, background:'rgba(127,29,29,0.2)', borderLeft:'1px solid rgba(239,68,68,0.3)', borderRight:'1px solid rgba(239,68,68,0.3)' }}>
              <div style={{ position:'absolute', top:4, left:4, fontSize:11, color:'rgba(248,113,113,0.8)', fontFamily:"'Orbitron',monospace" }}>NO LOS</div>
              <div style={{ position:'absolute', bottom:4, right:4, fontSize:7, color:'rgba(239,68,68,0.4)', fontFamily:"'Share Tech Mono',monospace" }}>{bz.station}</div>
            </div>
          );
        })}

        {/* Cooldown zones */}
        {cooldowns.map(cd => {
          const s = Math.max(pct(cd.start), 0), e = Math.min(pct(cd.end), 100);
          if (e <= s) return null;
          return (
            <div key={cd.id} style={{ position:'absolute', top:0, bottom:0, left:`${s}%`, width:`${e-s}%`, background:'rgba(120,53,15,0.2)', borderLeft:'1px solid rgba(245,158,11,0.3)', borderRight:'1px solid rgba(245,158,11,0.3)' }}>
              <div style={{ position:'absolute', top:4, left:4, fontSize:11, color:'rgba(251,191,36,0.8)', fontFamily:"'Orbitron',monospace" }}>COOLDOWN</div>
              <div style={{ position:'absolute', bottom:4, right:4, fontSize:7, color:'rgba(245,158,11,0.4)' }}>600s</div>
            </div>
          );
        })}

        {/* Burns */}
        {burns.map(burn => {
          const bt = new Date(burn.burn_time_iso);
          if (!inRange(bt)) return null;
          const left  = pct(bt);
          const isSel = sel === burn.burn_id;
          const dv    = Math.sqrt((burn.dv_x||0)**2+(burn.dv_y||0)**2+(burn.dv_z||0)**2);
          return (
            <div key={burn.burn_id} style={{ position:'absolute', top:0, bottom:0, left:`${left}%`, zIndex:isSel?30:20, cursor:'pointer' }}
                 onClick={() => { setSel(p=>p===burn.burn_id?null:burn.burn_id); if(onBurnClick)onBurnClick(burn); }}>
              <div style={{ position:'absolute', top:0, bottom:0, width:2, background:isSel?'#93c5fd':'#3b82f6' }} />
              <div style={{ position:'absolute', top:-1, left:4, padding:'2px 6px', borderRadius:2, fontSize:11, fontFamily:"'Orbitron',monospace", background:isSel?'#3b82f6':'rgba(30,80,180,0.8)', color:'#fff', whiteSpace:'nowrap', border:'1px solid rgba(147,197,253,0.3)' }}>
                {burn.burn_id?.slice(-6)||'BURN'}
              </div>
              {isSel && (
                <div style={{ position:'absolute', top:22, left:4, background:'rgba(4,15,35,.97)', border:'1px solid rgba(59,130,246,0.5)', borderRadius:3, padding:'8px 10px', fontSize:9, zIndex:40, minWidth:160, fontFamily:"'Share Tech Mono',monospace" }}>
                  <div style={{ fontFamily:"'Orbitron',monospace", fontSize:11, color:'#60a0d0', marginBottom:8 }}>BURN DETAILS</div>
                  <div style={{ color:'var(--text-muted)' }}>Time: <span style={{ color:'#fff' }}>{format(bt,'HH:mm:ss')}</span></div>
                  <div style={{ color:'#475569' }}>ΔV ECI: <span style={{ color:'#93c5fd' }}>[{burn.dv_x?.toFixed(3)},{burn.dv_y?.toFixed(3)},{burn.dv_z?.toFixed(3)}]</span></div>
                  <div style={{ color:'#475569' }}>|ΔV|: <span style={{ color:'#fcd34d' }}>{(dv*1000).toFixed(2)} m/s</span></div>
                </div>
              )}
            </div>
          );
        })}

        {/* Now marker */}
        <div style={{ position:'absolute', top:0, bottom:0, left:`${pct(now)}%`, width:1, background:'#10b981', zIndex:15 }}>
          <div style={{ fontSize:7, color:'#10b981', fontFamily:"'Orbitron',monospace", position:'absolute', top:4, left:3, background:'rgba(1,6,15,.8)', padding:'1px 3px' }}>NOW</div>
        </div>
      </div>

      {/* Nav buttons */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div className="flex gap-1">
          {[{l:'⏪ 1h',d:-3600},{l:'◀ 15m',d:-900},{l:'NOW',d:null},{l:'15m ▶',d:900},{l:'1h ⏩',d:3600}].map(btn => (
            <button key={btn.l} onClick={btn.d===null?jumpNow:()=>shift(btn.d)} className="btn"
              style={{ background:btn.d===null?'rgba(59,130,246,0.2)':'rgba(8,20,45,0.6)', borderColor:btn.d===null?'rgba(59,130,246,0.5)':'rgba(30,80,160,0.3)', color:btn.d===null?'#93c5fd':'#475569', fontSize:10, padding:'5px 10px' }}>
              {btn.l}
            </button>
          ))}
        </div>
        <div style={{ fontSize:11, color:'var(--text-muted)' }}>{format(range.start,'HH:mm')} – {format(range.end,'HH:mm')}</div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 flex-shrink-0" style={{ fontSize:8 }}>
        {[['rgba(59,130,246,0.9)','Burn'],['rgba(245,158,11,0.6)','Cooldown 600s (PS §5.1)'],['rgba(239,68,68,0.5)','Blackout/No LOS'],['#10b981','Now']].map(([c,l]) => (
          <div key={l} style={{ display:'flex', alignItems:'center', gap:4 }}>
            <div style={{ width:10, height:10, background:c, borderRadius:2 }} />
            <span style={{ color:'#334155', fontFamily:"'Share Tech Mono',monospace" }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Scheduled burns list */}
      <div className="flex-shrink-0 rounded border overflow-y-auto" style={{ maxHeight:100, borderColor:'rgba(30,80,160,0.2)', background:'rgba(1,6,15,.7)' }}>
        <div style={{ padding:'4px 8px', fontSize:11, color:'var(--text-muted)', fontFamily:"'Orbitron',monospace", letterSpacing:'0.1em', borderBottom:'1px solid rgba(30,80,160,0.15)' }}>SCHEDULED BURNS</div>
        {burns.length === 0
          ? <div style={{ color:'#1e293b', fontSize:10, textAlign:'center', padding:'10px 0', fontFamily:"'Share Tech Mono',monospace" }}>No scheduled burns</div>
          : burns.map(burn => {
            const bt = new Date(burn.burn_time_iso);
            const secs = differenceInSeconds(bt, now);
            const past = secs < 0;
            const dv = Math.sqrt((burn.dv_x||0)**2+(burn.dv_y||0)**2+(burn.dv_z||0)**2);
            return (
              <div key={burn.burn_id} onClick={() => { setSel(p=>p===burn.burn_id?null:burn.burn_id); if(onBurnClick)onBurnClick(burn); }}
                style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 8px', borderBottom:'1px solid rgba(30,80,160,0.1)', cursor:'pointer', background:sel===burn.burn_id?'rgba(30,80,160,0.15)':'transparent', fontSize:12, fontFamily:"'Share Tech Mono',monospace'" }}>
                <span style={{ color:past?'#334155':'#60a0d0', fontWeight:'bold' }}>{burn.burn_id}</span>
                <span style={{ color:past?'#1e293b':secs<300?'#f59e0b':'#10b981' }}>{past?`${Math.abs(secs)}s ago`:`in ${secs}s`}</span>
                <span style={{ color:'#334155' }}>|ΔV|:{(dv*1000).toFixed(1)}m/s</span>
              </div>
            );
          })
        }
      </div>

      {conflict && (
        <div style={{ background:'rgba(127,29,29,0.25)', border:'1px solid rgba(239,68,68,0.35)', borderRadius:3, padding:'5px 10px', fontSize:9, color:'#f87171', flexShrink:0 }}>
          ⚠ Burns within 600s cooldown — PS §5.1 violation detected
        </div>
      )}
    </div>
  );
}