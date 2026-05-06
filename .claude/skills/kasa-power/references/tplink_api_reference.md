# TP-Link Cloud API — Full Reference

Library: `tplink-cloud-api` v5.2.0+
Install: `pip3 install tplink-cloud-api`
Python: 3.10+
Cloud: Uses TP-Link V2 Cloud API with HMAC-SHA1 request signing

---

## TPLinkDeviceManager

```python
from tplinkcloud import TPLinkDeviceManager

TPLinkDeviceManager(
    username: str,
    password: str,
    prefetch: bool = False,        # Pre-fetch device details on init
    cache: bool = True,            # Cache device states
    cloud_api_host: str = '',      # Override cloud endpoint (rare)
    verbose: bool = False,         # Debug logging
    terminal_id: str = '',         # Custom terminal ID
    mfa_callback = None,           # Callable for MFA: fn(prompt) -> str
    include_tapo: bool = True      # Also fetch Tapo devices
)
```

### Methods

```python
await manager.async_init()                  # Initialize session + fetch device list
manager.get_devices() -> List[Device]       # All devices
manager.find_device(name: str) -> Device    # Exact name match (None if not found)
manager.find_devices(name: str) -> List     # Partial name match
manager.get_token() -> str
manager.set_auth_token(token: str)
manager.get_refresh_token() -> str
manager.set_refresh_token(token: str)
```

---

## TPLinkDeviceManagerPowerTools

```python
from tplinkcloud import TPLinkDeviceManagerPowerTools

power_tools = TPLinkDeviceManagerPowerTools(manager)
power_tools.get_emeter_devices()                          # Devices with EMeter
await power_tools.get_devices_power_usage_realtime()      # Realtime across all
await power_tools.get_devices_power_usage_day(year, month)
await power_tools.get_devices_power_usage_month(year)
```

---

## Device Model Types

After calling `manager.get_devices()`, each device has `.model_type.name`:

- `HS300` — 6-outlet strip with EMeter
- `KP303` — 3-outlet strip (no EMeter)
- `KP400` — 2-outlet outdoor strip
- `KP200` — in-wall dual outlet
- `HS100`, `HS103`, `HS105` — single plugs (no EMeter)
- `HS110`, `KP115`, `KP125` — single plugs with EMeter
- `EP40` — outdoor dual outlet with EMeter

---

## Power Strip Classes

### HS300 (6 outlets, EMeter)

```python
strip = manager.find_device("My HS300")

# Whole-strip control
strip.power_on()
strip.power_off()
strip.toggle()
strip.is_on() -> bool
strip.is_off() -> bool
strip.get_alias() -> str
strip.has_children() -> True
strip.set_led_state(on: bool)

# Get outlet objects
outlets: List[HS300Child] = await strip.get_children_async()

# System info (raw)
sys_info = await strip.get_sys_info()
# sys_info.alias, sys_info.children, sys_info.relay_state, etc.
```

### HS300Child (individual outlet)

```python
outlet = outlets[0]   # index 0–5

# Control
outlet.power_on()
outlet.power_off()
outlet.toggle()
outlet.is_on() -> bool
outlet.is_off() -> bool
outlet.get_alias() -> str       # e.g. "Gateway 1"
outlet.has_emeter() -> True     # HS300 outlets have EMeter
outlet.set_led_state(on: bool)

# Energy (HS300 only — has_emeter() == True)
usage = await outlet.get_power_usage_realtime()
# usage.power    — current watts
# usage.voltage  — volts
# usage.current  — amps
# usage.total    — total kWh since last reset

daily = await outlet.get_power_usage_day(year=2026, month=3)
# Returns list of daily kWh values (index = day-1)

monthly = await outlet.get_power_usage_month(year=2026)
# Returns list of monthly kWh values (index = month-1)

# Runtime stats
runtime_day = await outlet.get_runtime_day(year=2026, month=3)
runtime_month = await outlet.get_runtime_month(year=2026)

# Raw sys info
sys_info = await outlet.get_sys_info()
```

### KP303 / KP400 (no EMeter)

Same interface as HS300/HS300Child except:
- `has_emeter()` returns `False`
- `get_power_usage_realtime()` / stats methods not available

---

## Scheduling

Available on all devices and child outlets:

```python
rules = await device.get_schedule_rules()
# Returns list of rule dicts

rule = await device.get_schedule_rule(rule_id: str)

await device.add_schedule_rule(rule: dict)
# rule dict structure:
# {
#   "name": "Morning On",
#   "enable": 1,
#   "wday": [1,1,1,1,1,1,1],   # Sun=0 ... Sat=6
#   "stime_opt": 0,             # 0=absolute, 1=sunrise, 2=sunset
#   "smin": 480,                # minutes from midnight (480 = 8:00am)
#   "action": 1,                # 1=on, 0=off
# }

await device.edit_schedule_rule(rule: dict)   # rule must include id
await device.delete_schedule_rule(rule_id: str)
await device.delete_all_scheduled_rules()
```

---

## Network & Time

```python
net_info = await device.get_net_info()
# .ssid, .rssi, .mac, .type

time_info = await device.get_time()
tz_info = await device.get_timezone()
```

---

## Exceptions

```python
from tplinkcloud.exceptions import (
    TPLinkAuthError,              # 401 / bad credentials
    TPLinkCloudError,             # General cloud error
    TPLinkDeviceOfflineError,     # Device not reachable
    TPLinkMFARequiredError,       # MFA challenge required
    TPLinkTokenExpiredError,      # Access token expired
)
```

---

## Full Working Script: Gateway Power Manager

```python
#!/usr/bin/env python3
"""
Gateway Power Manager — controls KASA HS300 outlets for gateway management.
Credentials: KASA_USERNAME, KASA_PASSWORD env vars.
"""
import asyncio, os, sys
from tplinkcloud import TPLinkDeviceManager
from tplinkcloud.exceptions import TPLinkTokenExpiredError, TPLinkDeviceOfflineError

STRIP_NAME = "Gateway Strip"   # TP-Link device alias

async def get_manager():
    mgr = TPLinkDeviceManager(
        username=os.environ['KASA_USERNAME'],
        password=os.environ['KASA_PASSWORD']
    )
    await mgr.async_init()
    return mgr

async def get_strip(mgr, name=STRIP_NAME):
    strip = mgr.find_device(name)
    if not strip:
        raise RuntimeError(f"Strip '{name}' not found")
    return strip

async def list_outlets(strip_name=STRIP_NAME):
    mgr = await get_manager()
    strip = await get_strip(mgr, strip_name)
    outlets = await strip.get_children_async()
    for i, o in enumerate(outlets):
        state = "ON" if o.is_on() else "OFF"
        print(f"  [{i}] {o.get_alias():<20} {state}")

async def outlet_on(outlet_name: str, strip_name=STRIP_NAME):
    mgr = await get_manager()
    strip = await get_strip(mgr, strip_name)
    for o in await strip.get_children_async():
        if o.get_alias() == outlet_name:
            o.power_on()
            print(f"  {outlet_name} → ON")
            return
    print(f"  Outlet '{outlet_name}' not found")

async def outlet_off(outlet_name: str, strip_name=STRIP_NAME):
    mgr = await get_manager()
    strip = await get_strip(mgr, strip_name)
    for o in await strip.get_children_async():
        if o.get_alias() == outlet_name:
            o.power_off()
            print(f"  {outlet_name} → OFF")
            return
    print(f"  Outlet '{outlet_name}' not found")

async def reboot_outlet(outlet_name: str, delay=10, strip_name=STRIP_NAME):
    mgr = await get_manager()
    strip = await get_strip(mgr, strip_name)
    for o in await strip.get_children_async():
        if o.get_alias() == outlet_name:
            print(f"  Powering off {outlet_name}...")
            o.power_off()
            await asyncio.sleep(delay)
            print(f"  Powering on {outlet_name}...")
            o.power_on()
            print(f"  Reboot complete.")
            return
    print(f"  Outlet '{outlet_name}' not found")

async def power_status(strip_name=STRIP_NAME):
    mgr = await get_manager()
    strip = await get_strip(mgr, strip_name)
    outlets = await strip.get_children_async()
    result = []
    for o in outlets:
        entry = {"name": o.get_alias(), "on": o.is_on()}
        if o.has_emeter():
            usage = await o.get_power_usage_realtime()
            entry["watts"] = usage.power
        result.append(entry)
    return result

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        asyncio.run(list_outlets())
    elif cmd == "on" and len(sys.argv) > 2:
        asyncio.run(outlet_on(sys.argv[2]))
    elif cmd == "off" and len(sys.argv) > 2:
        asyncio.run(outlet_off(sys.argv[2]))
    elif cmd == "reboot" and len(sys.argv) > 2:
        asyncio.run(reboot_outlet(sys.argv[2]))
```

---

## Outlet Naming Convention (recommended)

Name each outlet in the Kasa app to match the gateway identifier used in the DB:

```
Gateway Strip
├── [0] GW-001
├── [1] GW-002
├── [2] GW-003
├── [3] GW-004
├── [4] GW-005
└── [5] GW-006
```

This allows direct lookup by gateway ID from the dashboard.
