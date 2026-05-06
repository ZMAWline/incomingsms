---
name: kasa-power
description: Expert knowledge of the tplink-cloud-api Python library for managing KASA smart power strips via TP-Link cloud. Use when controlling gateway power supplies, rebooting gateways via outlet cycling, checking outlet states, monitoring power usage, or building automation scripts that interact with KASA HS300/KP303/KP400 power strips. Credentials load from environment variables (KASA_USERNAME, KASA_PASSWORD).
---

# KASA Power Management Skill

Expert in `tplink-cloud-api` (Python ≥3.10, pip package) for cloud-based control of TP-Link KASA smart power strips.

## What This Skill Covers

1. **Authentication** — TP-Link cloud login with optional MFA + token/refresh-token persistence
2. **Device Discovery** — List all devices, find strip by name or partial match
3. **Strip Control** — Power the entire strip on/off
4. **Outlet Control** — Turn individual outlets on/off, toggle, query state
5. **Energy Monitoring** — Real-time watts/voltage/current per outlet (HS300 has EMeter)
6. **Power Statistics** — Daily/monthly consumption history per outlet
7. **Runtime Statistics** — Daily/monthly on-time per outlet
8. **Scheduling** — Get/add/edit/delete scheduled rules on any device

## Environment Variables (KASA_ prefix)

```
KASA_USERNAME=user@example.com
KASA_PASSWORD=your_tp_link_cloud_password
```

## Installation

```bash
pip3 install tplink-cloud-api
```

## Supported Devices

| Model | Type | EMeter |
|-------|------|--------|
| HS300 | 6-outlet power strip | Yes |
| KP303 | 3-outlet power strip | No  |
| KP400 | 2-outlet outdoor strip | No  |
| KP200 | In-wall dual outlet | No  |
| HS100/HS110 | Single plugs | HS110 only |

## Quick Reference: Key Methods

### TPLinkDeviceManager
| Method | Returns | Purpose |
|--------|---------|---------|
| `get_devices()` | `List[Device]` | All devices on account |
| `find_device(name)` | `Device` | Exact name match |
| `find_devices(name_like)` | `List[Device]` | Partial name match |
| `get_token()` | `str` | Current auth token |
| `get_refresh_token()` | `str` | Refresh token for persistence |
| `set_auth_token(token)` | — | Restore saved token |
| `set_refresh_token(token)` | — | Restore saved refresh token |

### Power Strip (HS300 / KP303 / KP400)
| Method | Purpose |
|--------|---------|
| `power_on()` | Turn entire strip on |
| `power_off()` | Turn entire strip off |
| `toggle()` | Toggle entire strip |
| `is_on()` / `is_off()` | Check strip state |
| `get_children_async()` | Get list of outlet objects |
| `has_children()` | Returns True for strips |
| `get_alias()` | Device name |
| `set_led_state(on)` | LED on/off |

### Individual Outlet (HS300Child, KP303Child, etc.)
| Method | Purpose |
|--------|---------|
| `power_on()` | Turn outlet on |
| `power_off()` | Turn outlet off |
| `toggle()` | Toggle outlet |
| `is_on()` / `is_off()` | Check outlet state |
| `get_alias()` | Outlet name (e.g. "Gateway 1") |
| `get_power_usage_realtime()` | Watts, voltage, current, total kWh |
| `get_power_usage_day(year, month)` | Daily kWh array |
| `get_power_usage_month(year)` | Monthly kWh array |
| `get_runtime_day(year, month)` | Daily on-time array |
| `get_runtime_month(year)` | Monthly on-time array |
| `has_emeter()` | True for HS300 outlets |

## Key Patterns

### Initialization (always await async_init)

```python
import asyncio, os
from tplinkcloud import TPLinkDeviceManager

async def get_manager():
    manager = TPLinkDeviceManager(
        username=os.environ['KASA_USERNAME'],
        password=os.environ['KASA_PASSWORD']
    )
    await manager.async_init()
    return manager
```

### List All Devices

```python
async def list_devices():
    manager = await get_manager()
    for device in manager.get_devices():
        print(f"{device.get_alias()} — {device.model_type.name}")
```

### Turn Outlet On/Off by Name

```python
async def set_outlet(strip_name, outlet_name, turn_on: bool):
    manager = await get_manager()
    strip = manager.find_device(strip_name)
    outlets = await strip.get_children_async()
    for outlet in outlets:
        if outlet.get_alias() == outlet_name:
            outlet.power_on() if turn_on else outlet.power_off()
            return True
    return False  # outlet not found
```

### Reboot Gateway (power cycle outlet)

```python
import asyncio

async def reboot_gateway(strip_name, outlet_name, delay_seconds=10):
    manager = await get_manager()
    strip = manager.find_device(strip_name)
    outlets = await strip.get_children_async()
    for outlet in outlets:
        if outlet.get_alias() == outlet_name:
            outlet.power_off()
            await asyncio.sleep(delay_seconds)
            outlet.power_on()
            return True
    return False
```

### Get Power Usage (HS300 with EMeter)

```python
async def get_outlet_power(strip_name, outlet_name):
    manager = await get_manager()
    strip = manager.find_device(strip_name)
    outlets = await strip.get_children_async()
    for outlet in outlets:
        if outlet.get_alias() == outlet_name:
            if outlet.has_emeter():
                usage = await outlet.get_power_usage_realtime()
                return {
                    "watts": usage.power,
                    "voltage": usage.voltage,
                    "current": usage.current,
                    "total_kwh": usage.total
                }
    return None
```

### Get All Outlet States

```python
async def get_all_outlet_states(strip_name):
    manager = await get_manager()
    strip = manager.find_device(strip_name)
    outlets = await strip.get_children_async()
    return [
        {"name": o.get_alias(), "on": o.is_on()}
        for o in outlets
    ]
```

### Token Persistence (avoid re-login every run)

```python
import json, os

TOKEN_FILE = "/tmp/kasa_tokens.json"

async def get_manager_cached():
    manager = TPLinkDeviceManager(
        username=os.environ['KASA_USERNAME'],
        password=os.environ['KASA_PASSWORD']
    )
    if os.path.exists(TOKEN_FILE):
        tokens = json.load(open(TOKEN_FILE))
        manager.set_auth_token(tokens['token'])
        manager.set_refresh_token(tokens['refresh_token'])
    else:
        await manager.async_init()
        json.dump({
            "token": manager.get_token(),
            "refresh_token": manager.get_refresh_token()
        }, open(TOKEN_FILE, 'w'))
    return manager
```

## Exceptions to Handle

| Exception | Meaning |
|-----------|---------|
| `TPLinkAuthError` | Bad credentials |
| `TPLinkCloudError` | General cloud error |
| `TPLinkDeviceOfflineError` | Device unreachable |
| `TPLinkMFARequiredError` | MFA challenge needed |
| `TPLinkTokenExpiredError` | Token expired — re-init |

```python
from tplinkcloud.exceptions import TPLinkTokenExpiredError, TPLinkDeviceOfflineError

try:
    outlet.power_on()
except TPLinkTokenExpiredError:
    # Re-authenticate
    await manager.async_init()
    outlet.power_on()
except TPLinkDeviceOfflineError:
    print("Power strip is offline")
```

## Common Gotchas

- **Always `await manager.async_init()`** — skipping it means you get no devices
- **`get_children_async()` must be awaited** — it's async even though the strip methods aren't
- **`power_on()` / `power_off()` on child outlets are NOT async** — call directly, no await
- **HS300 has 6 outlets** — indexed 0–5 in `get_children_async()` result
- **Device offline** does NOT raise — `is_on()` may return stale cached state; use `get_sys_info()` to force refresh
- **Cloud API only** — this library uses TP-Link's cloud, requires internet (not local LAN)
- **Rate limits** — avoid hammering; add small delays between bulk outlet toggles

## Gateway Power Management Use Case

For this project, each gateway is plugged into a KASA HS300 outlet. The outlet alias should match the gateway identifier. Typical operations:

1. **Hard reboot** — power_off → wait 10s → power_on
2. **Status check** — is_on() per outlet to verify gateway is powered
3. **Emergency shutoff** — power_off all outlets on a strip

For complete API details, see [references/tplink_api_reference.md](references/tplink_api_reference.md).
