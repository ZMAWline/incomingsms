---
name: skyline-api-expert
description: Expert knowledge of the Skyline HTTP API for managing multi-port gateway devices with SMS, MMS, call handling, and eSIM capabilities. Use when working with SMS/MMS sending and receiving, device command control, call and SMS statistics, port status monitoring, eSIM management, and building automation scripts for Skyline devices. Helps explain API endpoints, write scripts, debug responses, and guide through multi-step operations. Credentials load from environment variables (SK_HOST, SK_USERNAME, SK_PASSWORD, SK_PORT).
---

# Skyline API Expert Skill

Expert knowledge of the Skyline HTTP API for controlling multi-port gateway devices and managing SMS, calls, and eSIM profiles.

## What This Skill Covers

The Skyline API handles these core operations:

1. **Status Notification** - Monitor device and port status
2. **Command Sending** - Lock/unlock ports, switch SIMs, reboot
3. **SMS Sending** - Send SMS and MMS messages
4. **SMS Task Management** - Pause, resume, delete, query SMS tasks
5. **SMS Receiving** - Receive SMS via HTTP push
6. **Query SMS** - Retrieve received messages
7. **SMS Statistics** - Track send/receive metrics
8. **Call Statistics** - Monitor call metrics (ASR, PDD, ACD)
9. **MMS Receiving** - Receive MMS via HTTP push
10. **eSIM Management** - Query, add, and delete eSIM profiles

## Environment Variables (SK_ prefix)

The skill uses these variables from your `.env` file:

```
SK_HOST=192.168.1.67
SK_USERNAME=root
SK_PASSWORD=your_password
SK_PORT=80
```

When you request scripts, Claude automatically writes code that loads these variables using `python-dotenv`.

## When to Use This Skill

Use this skill when you need to:

- Explain how an API endpoint works
- Write automation scripts to control Skyline devices
- Debug API responses and error codes
- Build multi-step workflows (send SMS, check status, etc.)
- Query device statistics (SMS, calls, delivery reports)
- Manage eSIM profiles (add, remove, query)
- Handle SMS/MMS sending and receiving
- Lock/unlock ports and switch SIM cards
- Configure device status reporting

## Quick Reference: Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/goip_get_status.html` | GET | Configure status reporting |
| `/goip_send_cmd.html` | GET/POST | Send device commands |
| `/goip_post_sms.html` | POST | Send SMS/MMS |
| `/goip_pause_sms.html` | POST | Pause SMS task |
| `/goip_resume_sms.html` | POST | Resume SMS task |
| `/goip_remove_sms.html` | POST | Delete SMS task |
| `/goip_get_tasks.html` | GET | Query SMS tasks |
| `/goip_get_sms.html` | GET | Query received SMS |
| `/goip_get_sms_stat.html` | GET | SMS statistics |
| `/goip_get_call_stat.html` | GET | Call statistics |
| `/goip_get_esims.html` | GET | Query eSIM profiles |
| `/goip_write_esims.html` | POST | Add eSIM profile |
| `/goip_delete_esims.html` | POST | Delete eSIM profile |

## Port Status Codes

- **0** - No SIM
- **1** - Idle
- **2** - Registering
- **3** - Registered (Ready)
- **4** - Call connected
- **5** - No balance
- **6** - Registration failed
- **15** - Access Mobile Network
- **16** - Module timeout

## Example: Send an SMS

```python
import os
import requests
from dotenv import load_dotenv

load_dotenv()

host = os.getenv('SK_HOST')
username = os.getenv('SK_USERNAME')
password = os.getenv('SK_PASSWORD')
port = os.getenv('SK_PORT', '80')

url = f"http://{host}:{port}/goip_post_sms.html"

payload = {
    "type": "send-sms",
    "task_num": 1,
    "tasks": [
        {
            "tid": 1,
            "to": "13686876620",
            "sms": "Hello World",
            "smstype": 0,  # 0=SMS, 1=MMS
            "coding": 0
        }
    ]
}

response = requests.post(
    url,
    json=payload,
    auth=(username, password)
)

result = response.json()
if result['code'] == 200:
    print("SMS sent successfully")
else:
    print(f"Error: {result['reason']}")
```

## Example: Query SMS Statistics

```python
import os
import requests
from dotenv import load_dotenv

load_dotenv()

host = os.getenv('SK_HOST')
username = os.getenv('SK_USERNAME')
password = os.getenv('SK_PASSWORD')
port = os.getenv('SK_PORT', '80')

url = f"http://{host}:{port}/goip_get_sms_stat.html"

params = {
    'version': '1.1',
    'username': username,
    'password': password,
    'ports': 'all',
    'type': 3  # 3 = cumulative
}

response = requests.get(url, params=params)
stats = response.json()

for port_stat in stats.get('stats', []):
    port = port_stat['port']
    slot = port_stat['slot']
    sent_ok = port_stat['sent_ok']
    received = port_stat['received']
    failed = port_stat['sent_failed']
    
    print(f"Port {port}.{slot}: {sent_ok} sent, {received} received, {failed} failed")
```

## Example: Lock a Port

```python
import os
import requests
from dotenv import load_dotenv

load_dotenv()

host = os.getenv('SK_HOST')
username = os.getenv('SK_USERNAME')
password = os.getenv('SK_PASSWORD')
port = os.getenv('SK_PORT', '80')

url = f"http://{host}:{port}/goip_send_cmd.html"

payload = {
    "type": "command",
    "op": "lock",
    "ports": "1A"  # Lock port 1, slot A
}

response = requests.post(
    url,
    json=payload,
    auth=(username, password)
)

result = response.json()
print(result)
```

## How to Request Scripts

When asking Claude to write code, mention your `.env` setup:

✅ **Good:**
"Write a script to send an SMS using my SK_ environment variables."

✅ **Better:**
"Write a Python script that reads SK_HOST, SK_USERNAME, SK_PASSWORD, SK_PORT from my .env file and sends 'Test message' to 13686876620."

Claude will automatically write code that:
- Imports `dotenv` and loads variables
- Uses the SK_ variable names
- Handles authentication correctly
- Parses JSON responses

## Response Format

All endpoints return JSON:

```json
{
  "code": 200,
  "reason": "OK",
  "data": {...}
}
```

- **Code 200** = Success
- **Non-200** = Error (check `reason` field)

## How I Can Help

Tell me what you want to do with Skyline devices:

- **"Explain how to send an SMS"** - I'll walk through the endpoint, required fields, example request
- **"Write a script to query SMS stats"** - I'll generate Python code with .env integration
- **"Why did my SMS send fail?"** - I'll help debug the error code
- **"How do I switch a SIM card?"** - I'll explain the command and show examples
- **"Build a script that sends SMS and checks delivery"** - I'll create a multi-step workflow
- **"Manage eSIM profiles"** - I'll guide you through add/remove/query operations

---

For complete endpoint specifications and field details, see [skyline_api_reference.md](references/skyline_api_reference.md)
