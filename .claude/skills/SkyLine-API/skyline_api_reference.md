# Skyline HTTP API Reference

**Version:** 2.4.0 | **Last Updated:** 11/22/2024

## Overview

HTTP API for SKYLINE multi-port gateway devices. Supports SMS/MMS sending & receiving, device commands, statistics, eSIM management, and IMEI/SIM number configuration.

## Key Concepts

- **Base URL:** `http://[host]:[port]` (default port 80)
- **Auth:** `username` & `password` as URL query params for all requests
- **Port Notation:** `[port].[slot]` (e.g., `1.01` = port 1 slot 1) or `[port][letter]` (e.g., `1A`, `2B`)
- **JSON Content-Type:** `application/json;charset=utf-8`
- **Response codes:** `200` = success for most endpoints; `0` = success for config set operations (`op=set`)

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

---

## 1. Status Notification (Section 4)

### Configure Status Reporting
**URL:** `GET /goip_get_status.html`

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| url | Report URL (URL-encoded, set once) | None | N |
| period | Report period in seconds (min 60, 0=cancel) | 60 | N |
| all_sims | Get all card status (0=disable, 1=enable) | 0 | N |
| all_slots | Get status of all card slots (0=disable, 1=enable) | 0 | N |

### Dev-Status Message (pushed by device)
```json
{
  "type": "dev-status",
  "seq": 1,
  "expires": 180,
  "mac": "00-30-f1-01-02-03",
  "ip": "192.168.1.67",
  "max-ports": 32,
  "max-slots": 4,
  "status": [{"port": "1.01", ...}, {"port": "2.02", ...}]
}
```

**IMPORTANT:** `max-slots` tells you `slots_per_port` for the device. Use this for IMEI/SIM number index calculations.

### Port-Status Fields

| Field | Type | Description |
|-------|------|-------------|
| port | string | Port.slot notation (e.g., "1.01", "32.04") |
| sim | string | SIM pool identification |
| seq | int | Sequence number (incremented per port) |
| st | string | Status code + detail (see status codes above) |
| bal | float | SIM card balance |
| opr | string | Operator name + ID (valid when st=3 or 4) |
| sn | string | SIM number |
| imei | string | Module IMEI |
| active | int | Current active card (1=yes, 0=no) |
| imsi | string | IMSI number |
| iccid | string | ICCID number |
| inserted | int | Card inserted in slot (1=yes, 0=no) |
| slot_active | int | Card slot enabled (1=enabled, 0=disabled) |
| sig | int | Signal strength |
| led | int | LED enabled (1=yes, 0=no) |

---

## 2. Command Sending (Section 5)

**URL:** `GET/POST /goip_send_cmd.html`

### URL Parameters

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| version | API version | 1.1 | Y |
| username | Device account | None | Y |
| password | Device password | None | Y |
| op | Operation (see below) | None | N |
| par_name(n) | Config parameter name for get/set (subscript from 0) | None | N |

### Operations
`lock`, `unlock`, `switch`, `reset`, `reboot`, `save`, `ledon`, `ledoff`, `get`, `set`, `multiple`

### JSON Body (for command operations)
```json
{
  "type": "command",
  "op": "lock",
  "ports": "1A,2B,3C,4-32"
}
```

### Ports Format
- `all` or `*`: all ports
- `1A`: single port+slot
- `1A,2B,3C`: multiple ports
- `4-32`: port range
- For `lock`/`unlock`: omitting slot = entire port
- For `switch`: means switch TO this slot
- For `reset`: only port number is valid (no slot)

### Multiple Commands
```json
{
  "type": "command",
  "op": "multiple",
  "ops": [
    {"op": "lock", "ports": "1A"},
    {"op": "switch", "ports": "2B"}
  ]
}
```

### Get/Set Device Config (via URL params)
For getting/setting device configuration parameters, use `op=get` or `op=set` in the URL query string with `par_name(n)=value` format. This is used for IMEI, SIM numbers, and other device config.

---

## 3. Modify IMEI (Section 6.4.3)

**URL:** `POST /goip_send_cmd.html?username=xx&password=xx&op=set`
**Content-Type:** `text/plain`
**Body:** `sim_imei(n)=IMEI_VALUE` (join multiple with `&`)

### Index Formula
```
n = (port_number - 1) * slots_per_port + (slot_number - 1)
```
- `slots_per_port` = device's `max-slots` value from dev-status
- Slot numbering: A=1, B=2, C=3, D=4, etc.

### Examples (4 slots/port device)
- Port 6B: `n = (6-1)*4 + (2-1) = 21`
- Port 13D: `n = (13-1)*4 + (4-1) = 51`
- Body: `sim_imei(21)=865847053403202&sim_imei(51)=865847053403213`

### Example (1 slot/port device)
- Port 22A: `n = (22-1)*1 + (1-1) = 21`
- Body: `sim_imei(21)=865847053403202`

### Response
```json
{"code": 0, "reason": "OK", "par_set": 2}
```
- `code` 0 = success
- `par_set` = number of parameters set

---

## 4. Add SIM Card Numbers (Section 6.4.4)

**URL:** `POST /goip_send_cmd.html?username=xx&password=xx&op=set`
**Content-Type:** `text/plain`
**Body:** `sim_number(n)=PHONE_NUMBER` (join multiple with `&`)

### Same index formula as IMEI:
```
n = (port_number - 1) * slots_per_port + (slot_number - 1)
```

### Examples (8 slots/port device)
- Port 25.01: `n = (25-1)*8 + (1-1) = 192`
- Port 25.05: `n = (25-1)*8 + (5-1) = 196`
- Body: `sim_number(192)=1358021178&sim_number(196)=123456762221`

### Response
```json
{"code": 0, "reason": "OK", "par_set": 2}
```

---

## 5. SMS Sending (Section 6)

**URL:** `POST /goip_post_sms.html`

### URL Parameters
| Param | Default | Required |
|-------|---------|----------|
| version | 1.1 | N |
| username | None | Y |
| password | None | Y |

**Note:** For POST, auth params go in URL query string. Body is JSON.

### JSON Body
```json
{
  "type": "send-sms",
  "task_num": 1,
  "sr_url": "http://server/report",
  "sms_url": "http://server/sms",
  "tasks": [
    {
      "tid": 1223,
      "from": "1-4,6",
      "to": "13686876620",
      "sms": "Hello World",
      "chs": "utf8",
      "coding": 0,
      "smstype": 0,
      "intvl": "0",
      "tmo": 30,
      "sdr": 0,
      "fdr": 1,
      "dr": 0
    }
  ]
}
```

### Task Fields

| Field | Type | Description | Default | Required |
|-------|------|-------------|---------|----------|
| tid | int | Task ID | None | Y |
| from | string | Port(s) to send from. Comma/dash separated (from 1). | Device choice | N |
| to | string | Recipient number(s), comma-separated | None | Y |
| to_all | string | "1" = all ports | "1" | N |
| sms | string | SMS content | None | Y |
| chs | string | Character set (utf8 or base64) | utf8 | N |
| coding | int | Codec: 0=auto, 1=UCS2, 2=7bit | 0 | N |
| smstype | int | 0=SMS, 1=MMS, 2=MMS multi-number/subject | 0 | N |
| smstitle | string | MMS subject (UTF-8) | "" | N |
| to_title_array | array | Multi-recipient MMS: `[["num1","title1"],["num2","title2"]]` | None | N (smstype=2) |
| attachments | string | MMS attachments: `"filetype\|base64;filetype\|base64"` (max 5, total <100KB, jpg/gif/txt/mp3) | "" | N |
| smsc | string | SMSC number | "" | N |
| intvl | string | Interval between SMS in ms | "0" | N |
| tmo | int | Max wait time for send result (seconds) | 30 | N |
| sdr | int | Enable success report (1=on, 0=off) | 0 | N |
| fdr | int | Enable failure report (1=on, 0=off) | 1 | N |
| dr | int | Enable delivery report (1=on, 0=off) | 0 | N |
| sr_prd | int | Status report period (seconds) | 60 | N |
| sr_cnt | int | Status report SMS count threshold | 10 | N |

### Global Fields (outside tasks)
| Field | Description |
|-------|-------------|
| sr_url | Status report forward URL |
| sr_cnt | Max reports in cache before flush |
| sr_prd | Max cache time before flush (seconds) |
| sms_url | SMS forward URL |
| sms_cnt | Max SMS in cache (set >1 for new buffering) |
| sms_prd | Max SMS cache time (seconds) |

### Send Response
```json
{
  "code": 200,
  "reason": "OK",
  "type": "task-status",
  "status": [{"tid": 1223, "status": "0 OK"}]
}
```

### Task Status Codes
| Code | Description |
|------|-------------|
| 0 | OK |
| 1 | Invalid User |
| 2 | Invalid Port |
| 3 | USSD Expected |
| 5 | SIM Unregistered |
| 6 | Timeout |
| 7 | Server Error |
| 8 | SMS expected |
| 9 | TO expected |
| 10 | Pending Transaction |
| 11 | TID Expected |
| 12 | FROM Expected |
| 13 | Duplicated TaskId |
| 14 | Unauthorized |
| 15 | Invalid CMD |
| 16 | Too Many Task |
| 17 | MMS Title expected |
| 18 | Too Many MMS Attachments |
| 19 | MMS Attachments expected |
| 20 | MMS Attachments Cache size Overlimit |

### Status Report (pushed by device)
```json
{
  "type": "status-report",
  "rpt_num": 1,
  "rpts": [{
    "tid": 1223,
    "sending": 0,
    "sent": 5,
    "failed": 1,
    "unsent": 0,
    "sdr": [[0, "13686876620", "1.01", 1466506477]],
    "fdr": [[1, "13686876621", "1.02", 1466506480, "6 Timeout", ""]]
  }]
}
```

**sdr** (success detail): `[recipient_index, number, port, timestamp_utc]`
**fdr** (failure detail): `[recipient_index, number, port, timestamp_utc, progress_reason, carrier_reason]`

---

## 6. SMS Task Management

### Pause SMS Task
**URL:** `POST /goip_pause_sms.html?username=xx&password=xx`
**Body:** `{"tids": [tid1, tid2]}` (omit tids to pause all)

### Resume SMS Task
**URL:** `POST /goip_resume_sms.html?username=xx&password=xx`
**Body:** `{"tids": [tid1, tid2]}` (omit tids to resume all)

### Delete SMS Task
**URL:** `POST /goip_remove_sms.html?username=xx&password=xx`
**Body:** `{"tids": [tid1, tid2]}` (omit tids to delete all)

### Query SMS Tasks
**URL:** `GET /goip_get_tasks.html`

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| version | API version | 1.1 | Y |
| username | Device username | None | Y |
| password | Device password | None | Y |
| port | Send port (from 1) | None | Y |
| pos | Start position (0 = first task) | None | Y |
| num | Number of tasks to return | 10 | N |
| has_content | Include SMS text (0=no, 1=yes) | 0 | N |

**Response:**
```json
{
  "code": 200,
  "reason": "OK",
  "total_num": 5,
  "task_num": 5,
  "tasks": [
    {"tid": 2, "state": 0, "from": "", "to": "13686876820", "chs": "utf8", "coding": 0, "sms": "hello123"}
  ]
}
```
- `state`: 0=normal, 1=suspended

---

## 7. Receive SMS (Section 7)

Device pushes received SMS to configured URL via POST.

### Push Format
```json
{
  "type": "recv-sms",
  "sms_num": 2,
  "sms": [
    [0, "1B", 1466506477, "10010", "13265825775", "<base64_content>"]
  ]
}
```

### SMS Array Fields
| Index | Description |
|-------|-------------|
| [0] | Delivery report flag: 0=normal SMS, 1=delivery report |
| [1] | Receive port (e.g., "1.01", "1B") |
| [2] | Timestamp (UTC epoch) |
| [3] | Sender (if delivery report: SMSC) |
| [4] | Recipient (if delivery report: original recipient) |
| [5] | Content: delivery report = "code scts" (code 0=delivered, utf-8); normal SMS = BASE64 of utf-8 |

---

## 8. Query SMS (Section 8)

**URL:** `GET /goip_get_sms.html`

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| username | Device username | None | Y |
| password | Device password | None | Y |
| sms_id | Start SMS ID | 1 | N |
| sms_num | Number of SMS to query (0=all) | 0 | N |
| sms_del | Delete returned SMS (0=no, 1=yes) | 0 | N |

### Response
```json
{
  "code": 0,
  "reason": "OK",
  "ssrc": "0123456789abcdef",
  "sms_num": 2,
  "next_sms": 3,
  "data": [[0, "1B", 1466506477, "10010", "13265825775", "<base64>"]]
}
```

- `ssrc`: Synchronization source ID (changes on device reboot — if changed, start from sms_id=1)
- `next_sms`: Use as sms_id for next query
- `data`: Same array format as received SMS (section 7)

---

## 9. SMS Statistics (Section 9)

**URL:** `GET /goip_get_sms_stat.html`

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| version | API version | 1.1 | N |
| username | Device username | None | Y |
| password | Device password | None | Y |
| ports | Port selection: `all`, `2`, `1-2,4` | all | N |
| slots | Slot selection: `all`, `2`, `1-2,4` (omit=current card) | current | N |
| type | 0=last hour, 1=last 2 hours, 2=today, 3=cumulative | 0 | N |

### Response
```json
{
  "code": 200,
  "reason": "OK",
  "count": 32,
  "stats": [
    {
      "port": 1, "slot": 1,
      "received": 10, "sent": 50, "sent_ok": 48,
      "sent_failed": 2, "con_failed": 0,
      "unsent": 5, "sending": 1
    }
  ]
}
```

---

## 10. Call Statistics (Section 10)

**URL:** `GET /goip_get_call_stat.html`

Same parameters as SMS statistics (ports, slots, type).

### Response
```json
{
  "code": 200,
  "reason": "OK",
  "count": 32,
  "stats": [
    {
      "port": 1, "slot": 1,
      "calls": 100, "alerted": 90, "connected": 80,
      "con_failed": 20, "nc": "15/20",
      "pdd": 5, "acd": 120, "asr": 80,
      "tcd": 160, "act_tcd": 9600
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| calls | Total calls |
| alerted | Number alerting |
| connected | Number connected |
| con_failed | Number failed |
| nc | No Carrier ratio ("success/total") |
| pdd | Post-Dial Delay |
| acd | Average Call Duration |
| asr | Answer-Seizure Ratio (percentage, e.g., 80 = 80%) |
| tcd | Total Call Duration (minutes) |
| act_tcd | Actual Total Call Duration (seconds) |

---

## 11. MMS Receiving (Section 11)

Device pushes received MMS via HTTP POST to configured URL.

### Configuration
Set in device web UI: SMS/MMS Settings > MMS Inbox > Enable + URL

### Custom HTTP Headers
| Header | Description | Format |
|--------|-------------|--------|
| Emms-Subject | MMS subject | BASE64; charset=UTF-8 |
| Emms-From | Sender address | BASE64; type=PLMN; charset=UTF-8 |
| Emms-To | Recipient address | BASE64; type=PLMN; charset=UTF-8 |
| Date | MMS send time | Standard HTTP date |
| Content-Type | `multipart/related` with boundary | Standard |

Body is `multipart/related` containing SMIL, images, text parts.

---

## 12. eSIM Management (Section 12)

### Query eSIM
**URL:** `GET /goip_get_esims.html`

| Param | Description | Default | Required |
|-------|-------------|---------|----------|
| version | API version | 1.1 | N |
| username | Device username | None | Y |
| password | Device password | None | Y |
| ports | Port selection: `all`, `2`, `1-2,4` | all | N |

**Response:**
```json
{
  "code": 200,
  "reason": "OK",
  "count": 1,
  "ports": [{
    "port": 1,
    "eid": "89001...",
    "esim_state": 1,
    "profiles": [{
      "slot": 1,
      "enabled": 1,
      "iccid": "8901...",
      "ac": "activation_code",
      "cc": "confirmation_code",
      "provider": "T-Mobile",
      "exust": 1,
      "op": 0,
      "status": 0,
      "reason": ""
    }]
  }]
}
```

| Profile Field | Description |
|---------------|-------------|
| slot | Slot number (from 1) |
| enabled | Profile enabled (0=no, 1=yes) |
| iccid | eSIM ICCID |
| ac | Activation code |
| cc | Confirmation code |
| provider | Service provider name |
| exust | Profile written to slot (0=no, 1=yes) |
| op | Current operation: 0=none, 1=writing, 2=deleting |
| status | 0=no op, 1=request submitted, 2=in progress, 3=error (see reason) |

### Write eSIM
**URL:** `POST /goip_write_esims.html?version=1.1&username=xx&password=xx`
**Body (JSON array):**
```json
[{"port": 1, "slot": 1, "ac": "activation_code", "cc": "confirmation_code"}]
```
**Response:** status 1=submitted, 2=port busy (fail), 3=other error (fail)

### Delete eSIM
**URL:** `POST /goip_delete_esims.html?version=1.1&username=xx&password=xx`
**Body (JSON array):**
```json
[{"port": 1, "slot": 1}]
```
**Response:** status 1=submitted, 2=port busy (fail), 3=other error (fail)

**Note:** Write/delete are async. Poll query endpoint to check status.

---

## 13. Interface Security (Section 3)

Optional encrypted session via `/crypt_sess.json`.

### Session Establishment
**URL:** `GET /crypt_sess.json?username=xx&cnonce=xx&auth=xx&crypt=xx&expires=180`

| Param | Description |
|-------|-------------|
| username | Device account |
| cnonce | Random string from client |
| auth | Client session ID = `MD5(username + password + cnonce + url-resource)` |
| crypt | Encryption method |
| expires | Session timeout (default 180s) |

### Session Response
```json
{"code": 0, "desc": "OK", "session": "server-session-id", "expires": 180}
```

### Subsequent Requests (after session)
No username/password needed. Instead use:
- `seq`: Incrementing sequence number
- `auth`: `MD5(username + password + session + seq + url-resource)`
- `session`: Server session ID from establishment
- `expires`: Optional timeout reset

### Encryption Key
`KEY = MD5(username + password + auth_initial + session + seq)`

---

## Environment Variables

```
SK_HOST=192.168.1.67
SK_USERNAME=root
SK_PASSWORD=your_password
SK_PORT=80
```
