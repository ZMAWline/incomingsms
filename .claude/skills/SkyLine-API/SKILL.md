---
name: skyline-api-expert
description: Expert knowledge of the Skyline HTTP API for managing multi-port gateway devices with SMS, MMS, call handling, and eSIM capabilities. Use when working with SMS/MMS sending and receiving, device command control, call and SMS statistics, port status monitoring, eSIM management, IMEI/SIM number configuration, and building automation scripts for Skyline devices. Helps explain API endpoints, write scripts, debug responses, and guide through multi-step operations. Credentials load from environment variables (SK_HOST, SK_USERNAME, SK_PASSWORD, SK_PORT).
---

# Skyline API Expert Skill

Expert knowledge of the Skyline HTTP API (V2.4.0) for controlling multi-port gateway devices.

## What This Skill Covers

1. **Status Notification** - Monitor device and port status, configure reporting
2. **Command Sending** - Lock/unlock ports, switch SIMs, reboot, LED control
3. **IMEI Modification** - Change IMEI per SIM slot via `sim_imei(n)` format
4. **SIM Number Configuration** - Set SIM numbers via `sim_number(n)` format
5. **SMS Sending** - Send SMS and MMS with task management
6. **SMS Task Management** - Pause, resume, delete, query SMS tasks
7. **SMS Receiving** - Receive SMS via HTTP push (BASE64 encoded)
8. **Query SMS** - Actively retrieve received messages with pagination
9. **SMS Statistics** - Track send/receive/fail metrics per port/slot
10. **Call Statistics** - Monitor ASR, PDD, ACD, call counts per port/slot
11. **MMS Receiving** - Receive MMS via HTTP push (multipart/related)
12. **eSIM Management** - Query, write, and delete eSIM profiles (async operations)
13. **Interface Security** - Optional encrypted sessions via MD5-based handshake

## Environment Variables (SK_ prefix)

```
SK_HOST=192.168.1.67
SK_USERNAME=root
SK_PASSWORD=your_password
SK_PORT=80
```

## Quick Reference: Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/goip_get_status.html` | GET | query params | Configure status reporting |
| `/goip_send_cmd.html` | GET/POST | query params | Commands: lock/unlock/switch/reset/reboot/save/ledon/ledoff/get/set |
| `/goip_send_cmd.html?op=set` | POST | query params | Set IMEI/SIM numbers (plain text body) |
| `/goip_post_sms.html` | POST | query params | Send SMS/MMS |
| `/goip_pause_sms.html` | POST | query params | Pause SMS tasks |
| `/goip_resume_sms.html` | POST | query params | Resume SMS tasks |
| `/goip_remove_sms.html` | POST | query params | Delete SMS tasks |
| `/goip_get_tasks.html` | GET | query params | Query SMS tasks |
| `/goip_get_sms.html` | GET | query params | Query received SMS |
| `/goip_get_sms_stat.html` | GET | query params | SMS statistics |
| `/goip_get_call_stat.html` | GET | query params | Call statistics |
| `/goip_get_esims.html` | GET | query params | Query eSIM profiles |
| `/goip_write_esims.html` | POST | query params | Write eSIM profile (async) |
| `/goip_delete_esims.html` | POST | query params | Delete eSIM profile (async) |
| `/crypt_sess.json` | GET | MD5 auth | Establish encrypted session |

## Key Concepts

- **Auth:** All endpoints use `username` & `password` as URL query params
- **Port notation:** `port.slot` (e.g., `1.01`) or `portLetter` (e.g., `1A`, `2B`)
- **Port format in commands:** `1A,2B,3C` or `4-32` or `all`/`*`
- **Device info:** `max-ports` and `max-slots` from dev-status tell you device layout
- **Response codes:** Most endpoints return `code: 200` for success; config set (`op=set`) returns `code: 0`

## Port Status Codes

| Code | Description |
|------|-------------|
| 0 | No SIM card |
| 1 | Idle SIM card |
| 2 | Registering |
| 3 | Registered (ready) |
| 4 | Call connected |
| 5 | No balance / alarm |
| 6 | Registration failed |
| 7 | SIM locked by device |
| 8 | SIM locked by operator |
| 9 | SIM card error |
| 11 | Card detected |
| 12 | User locked |
| 13 | Port inter-calling |
| 14 | Inter-calling holding |
| 15 | Access Mobile Network |
| 16 | Module response timeout |

## Example: Send an SMS

```python
import os, requests
from dotenv import load_dotenv
load_dotenv()

host = os.getenv('SK_HOST')
username = os.getenv('SK_USERNAME')
password = os.getenv('SK_PASSWORD')
port = os.getenv('SK_PORT', '80')

url = f"http://{host}:{port}/goip_post_sms.html"
params = {"username": username, "password": password}

payload = {
    "type": "send-sms",
    "task_num": 1,
    "tasks": [{
        "tid": 1,
        "to": "13686876620",
        "sms": "Hello World",
        "smstype": 0,  # 0=SMS, 1=MMS, 2=MMS multi-number
        "coding": 0    # 0=auto, 1=UCS2, 2=7bit
    }]
}

response = requests.post(url, params=params, json=payload)
result = response.json()
if result['code'] == 200:
    print("SMS sent:", result['status'])
else:
    print(f"Error: {result['reason']}")
```

## Example: Send MMS with Attachment

```python
import base64

payload = {
    "type": "send-sms",
    "task_num": 1,
    "tasks": [{
        "tid": 100,
        "to": "13686876620",
        "sms": "Check this out",
        "smstype": 1,
        "smstitle": "My MMS Subject",
        "attachments": "jpg|" + base64.b64encode(open("photo.jpg","rb").read()).decode()
    }]
}
# Max 5 attachments, total <100KB, supported: jpg, gif, txt, mp3
# Multiple: "jpg|<b64>;txt|<b64>"
```

## Example: Lock/Unlock/Switch Port

```python
url = f"http://{host}:{port}/goip_send_cmd.html"
params = {"username": username, "password": password}

# Lock a port+slot
payload = {"type": "command", "op": "lock", "ports": "1A"}
# Lock entire port (all slots): just use port number
payload = {"type": "command", "op": "lock", "ports": "1"}
# Unlock
payload = {"type": "command", "op": "unlock", "ports": "1A,2B"}
# Switch to specific slot
payload = {"type": "command", "op": "switch", "ports": "2.02"}
# Reset module (port number only)
payload = {"type": "command", "op": "reset", "ports": "5"}
# Reboot entire device
payload = {"type": "command", "op": "reboot"}
# Multiple commands
payload = {"type": "command", "op": "multiple", "ops": [
    {"op": "lock", "ports": "1A"},
    {"op": "switch", "ports": "2B"}
]}

response = requests.post(url, params=params, json=payload)
```

## Example: Change IMEI (Section 6.4.3)

```python
# IMEI index formula: n = (port_number-1) * slots_per_port + (slot_number-1)
# slots_per_port = device's max-slots (from dev-status)
# Slot: A=1, B=2, C=3, D=4, etc.
#
# 4 slots/port: Port 6B  -> n = (6-1)*4 + (2-1) = 21
# 1 slot/port:  Port 22A -> n = (22-1)*1 + (1-1) = 21

slots_per_port = 1  # from device max-slots
port_number = 22
slot_number = 1     # A=1
n = (port_number - 1) * slots_per_port + (slot_number - 1)

url = f"http://{host}:{port}/goip_send_cmd.html"
params = {"username": username, "password": password, "op": "set"}

# Body is PLAIN TEXT, NOT JSON
body = f"sim_imei({n})=865847053403202"
# Multiple: "sim_imei(21)=865847053403202&sim_imei(51)=865847053403213"

response = requests.post(url, params=params, data=body,
                         headers={"Content-Type": "text/plain"})
result = response.json()
# Success: {"code": 0, "reason": "OK", "par_set": 1}
```

## Example: Set SIM Card Numbers (Section 6.4.4)

```python
# Same index formula as IMEI
n = (port_number - 1) * slots_per_port + (slot_number - 1)

url = f"http://{host}:{port}/goip_send_cmd.html"
params = {"username": username, "password": password, "op": "set"}

body = f"sim_number({n})=1358021178"

response = requests.post(url, params=params, data=body,
                         headers={"Content-Type": "text/plain"})
# Success: {"code": 0, "reason": "OK", "par_set": 1}
```

## Example: Query SMS Statistics

```python
url = f"http://{host}:{port}/goip_get_sms_stat.html"
params = {
    'version': '1.1', 'username': username, 'password': password,
    'ports': 'all',  # or '2' or '1-2,4'
    'slots': 'all',  # or omit for current card
    'type': 3        # 0=last hour, 1=last 2h, 2=today, 3=cumulative
}

response = requests.get(url, params=params)
stats = response.json()

for s in stats.get('stats', []):
    print(f"Port {s['port']}.{s['slot']}: {s['sent_ok']} sent, {s['received']} recv, {s['sent_failed']} fail")
```

## Example: Query Received SMS

```python
url = f"http://{host}:{port}/goip_get_sms.html"
params = {
    'username': username, 'password': password,
    'sms_id': 1,    # start from 1
    'sms_num': 0,   # 0 = all
    'sms_del': 0    # 1 = delete after query
}

response = requests.get(url, params=params)
result = response.json()
# result['ssrc'] changes on reboot -> restart from sms_id=1
# result['next_sms'] -> use as sms_id for next query
for sms in result.get('data', []):
    # [delivery_flag, port, timestamp, sender, recipient, base64_content]
    import base64
    content = base64.b64decode(sms[5]).decode('utf-8')
    print(f"From {sms[3]} on port {sms[1]}: {content}")
```

## Example: eSIM Management

```python
# Query eSIM profiles
url = f"http://{host}:{port}/goip_get_esims.html"
params = {'version': '1.1', 'username': username, 'password': password, 'ports': 'all'}
response = requests.get(url, params=params)
# Returns: port, eid, esim_state, profiles[{slot, enabled, iccid, ac, cc, provider, status}]

# Write eSIM
url = f"http://{host}:{port}/goip_write_esims.html"
params = {'version': '1.1', 'username': username, 'password': password}
data = [{"port": 1, "slot": 1, "ac": "activation_code", "cc": "confirmation_code"}]
response = requests.post(url, params=params, json=data)
# Async! status 1=submitted, poll query endpoint for result

# Delete eSIM
url = f"http://{host}:{port}/goip_delete_esims.html"
params = {'version': '1.1', 'username': username, 'password': password}
data = [{"port": 1, "slot": 1}]
response = requests.post(url, params=params, json=data)
# Async! status 1=submitted, poll query endpoint for result
```

## Task Status Codes (SMS operations)

| Code | Description |
|------|-------------|
| 0 | OK |
| 1 | Invalid User |
| 2 | Invalid Port |
| 5 | SIM Unregistered |
| 6 | Timeout |
| 7 | Server Error |
| 8 | SMS expected |
| 9 | TO expected |
| 10 | Pending Transaction |
| 11 | TID Expected |
| 13 | Duplicated TaskId |
| 14 | Unauthorized |
| 15 | Invalid CMD |
| 16 | Too Many Task |
| 17 | MMS Title expected |
| 18 | Too Many MMS Attachments |
| 19 | MMS Attachments expected |
| 20 | MMS Attachments Cache Overlimit |

## Response Formats

**Most endpoints:** `{"code": 200, "reason": "OK", ...}` (code 200 = success)

**Config set (op=set):** `{"code": 0, "reason": "OK", "par_set": N}` (code 0 = success)

---

For complete field-level specifications, see [skyline_api_reference.md](skyline_api_reference.md)
