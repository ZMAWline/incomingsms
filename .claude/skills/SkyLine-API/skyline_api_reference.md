# Skyline HTTP API Reference

**Version:** 2.4.0 | **Last Updated:** 11/22/2024

## Overview

The Skyline HTTP API manages multi-port gateway devices with SMS, MMS, call handling, and eSIM capabilities. All requests require authentication via username and password.

## Key Concepts

**Device Access:**
- Base URL: `http://[SK_HOST]:[SK_PORT]`
- Default port: 80
- Authentication: Username/password in requests

**Port Notation:** `[port].[slot]` (e.g., `1.01` = port 1, slot 1)

**JSON Format:** `application/json;charset=utf-8`

---

## Core Endpoints

### Status Notification
**URL:** `/goip_get_status.html` (GET)  
Configure device to push status updates

### Command Sending
**URL:** `/goip_send_cmd.html` (GET/POST)  
Operations: lock, unlock, switch, reset, reboot, save, ledon, ledoff, get, set

### SMS Sending
**URL:** `/goip_post_sms.html` (POST)  
Send SMS/MMS with task management

### SMS Management
- **Pause:** `/goip_pause_sms.html` (POST)
- **Resume:** `/goip_resume_sms.html` (POST)
- **Delete:** `/goip_remove_sms.html` (POST)
- **Query:** `/goip_get_tasks.html` (GET)

### SMS Operations
- **Query SMS:** `/goip_get_sms.html` (GET)
- **SMS Stats:** `/goip_get_sms_stat.html` (GET)
- **Call Stats:** `/goip_get_call_stat.html` (GET)

### eSIM Management
- **Query:** `/goip_get_esims.html` (GET)
- **Write:** `/goip_write_esims.html` (POST)
- **Delete:** `/goip_delete_esims.html` (POST)

---

## Device Port Status Codes

- 0: No SIM | 1: Idle | 2: Registering | 3: Registered | 4: Call connected
- 5: No balance | 6: Registration failed | 7: Locked by device | 8: Locked by operator
- 9: SIM error | 11: Card detected | 12: User locked | 13: Inter-calling
- 14: Inter-calling holding | 15: Access Mobile Network | 16: Module timeout

---

## Response Format

```json
{
  "code": 200,
  "reason": "OK",
  "data": {...}
}
```

Code 200 = Success. Non-200 = Error.

---

## Environment Variables (SK_ prefix)

```
SK_HOST=192.168.1.67
SK_USERNAME=root
SK_PASSWORD=your_password
SK_PORT=80
```

Claude will automatically load these from your `.env` file when writing scripts.
