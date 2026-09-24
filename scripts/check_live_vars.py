#!/usr/bin/env python3
"""Refuse a deploy that would silently drop a live plain-text var.

`wrangler deploy` replaces every plain-text var with what wrangler.toml
(plus any --var flags) says. A var set once with `--var` is gone after the
next plain deploy -- that is how the offline-lifecycle dry-run flags vanished
three times on 2026-09-22.

Usage: check_live_vars.py <worker-dir> <env-or-empty> [VAR ...]
  VAR: names passed with --var on this deploy (they count as kept).

Exit 0: nothing dropped, or the check could not run (warning printed).
Exit 3: live vars would be dropped (listed on stderr).
"""
import json
import os
import sys
import tomllib
import urllib.request


def warn(msg):
    print(f"WARNING: live-var check skipped: {msg}", file=sys.stderr)
    sys.exit(0)


def main():
    worker_dir, env_name, *extra = sys.argv[1:]
    with open(os.path.join(worker_dir, "wrangler.toml"), "rb") as f:
        cfg = tomllib.load(f)

    if env_name:
        env_cfg = cfg.get("env", {}).get(env_name, {})
        script = env_cfg.get("name", f"{cfg['name']}-{env_name}")
        toml_vars = env_cfg.get("vars", {})
    else:
        script = cfg["name"]
        toml_vars = cfg.get("vars", {})

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = cfg.get("account_id") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        warn("CLOUDFLARE_API_TOKEN or account id not set")

    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}/settings"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            body = json.load(res)
    except Exception as e:  # 404 for a brand-new worker lands here too
        warn(f"could not read live settings for {script} ({e})")

    live = {b["name"] for b in body.get("result", {}).get("bindings", []) if b.get("type") == "plain_text"}
    dropped = sorted(live - set(toml_vars) - set(extra))
    if not dropped:
        return

    print("", file=sys.stderr)
    print("!!! REFUSING TO DEPLOY: this deploy would DELETE live vars !!!", file=sys.stderr)
    print(f"  Worker {script} has these plain-text vars live that are not in", file=sys.stderr)
    print(f"  {worker_dir}/wrangler.toml [{'env.' + env_name + '.' if env_name else ''}vars]:", file=sys.stderr)
    for name in dropped:
        print(f"    - {name}", file=sys.stderr)
    print("  Fix: add them to wrangler.toml so every deploy keeps them.", file=sys.stderr)
    print("  If dropping them is intended, re-run with --allow-var-drop.", file=sys.stderr)
    sys.exit(3)


if __name__ == "__main__":
    main()
