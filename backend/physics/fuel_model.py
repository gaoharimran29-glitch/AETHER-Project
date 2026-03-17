import numpy as np

G0 = 9.80665  
ISP = 300.0   
DRY_MASS = 500.0

def fuel_consumption(m_current, dv_km_s):
    # m_current includes fuel. Total Mass M = Dry + Fuel
    dv_m_s = abs(float(dv_km_s)) * 1000.0
    
    # Tsiolkovsky: delta_m = M_initial * (1 - e^(-dv / (Isp * g0)))
    fuel_used = m_current * (1 - np.exp(-dv_m_s / (ISP * G0)))
    return float(fuel_used)

def update_mass(m_current, dv_km_s):
    fuel_used = fuel_consumption(m_current, dv_km_s)
    new_mass = m_current - fuel_used
    
    # Critical Check: Don't let mass drop below Dry Mass
    if new_mass < DRY_MASS:
        fuel_used = m_current - DRY_MASS
        new_mass = DRY_MASS
        
    return float(new_mass), float(fuel_used)