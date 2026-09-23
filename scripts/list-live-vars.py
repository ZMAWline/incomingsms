#!/usr/bin/env python3
"""List every secret and var NAME the workers use, where it lives, and the gaps.

Read-only. Prints names only, never a value. Feeds agent/secrets-inventory.md.

For each src/<worker>/wrangler.toml, and for PROD and each [env.*] in it,
this reads the live worker settings from the Cloudflare API (the same
endpoint scripts/check_live_vars.py uses) and compares three sets:
  - code:   names the worker's source reads as env.NAME (plus src/shared/)
  - toml:   names in wrangler.toml [vars] for that env
  - live:   secret_text and plain_text bindings on the deployed worker

Then it reports:
  - live secrets no code reads          (candidates to delete)
  - code reads with no live binding     (will fail or fall back at runtime)
  - TEST missing a secret PROD has

Usage: python3 scripts/list-live-vars.py [--markdown]
Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (~/.config/cloudflare/env).
"""
import json
import os
import re
import sys
import tomllib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
ENV_REF = re.compile(r"env\??\.([A-Z][A-Z0-9_]+)")
SOURCE_EXT = {".js", ".mjs", ".ts"}
# Bindings that are not secrets or vars (KV, queues, services, assets).
BINDING_TYPES = {"secret_text", "plain_text"}


def code_refs(*dirs):
    names = set()
    for d in dirs:
        for p in d.rglob("*"):
            if p.suffix in SOURCE_EXT and "node_modules" not in p.parts and p.is_file():
                names |= set(ENV_REF.findall(p.read_text(errors="ignore")))
    return names


def live_bindings(script, account, token):
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}/settings"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            body = json.load(res)
    except Exception as e:
        return None, str(e)
    out = {}
    for b in body.get("result", {}).get("bindings", []):
        out[b["name"]] = b.get("type")
    return out, None


def targets(cfg):
    yield "prod", cfg["name"], cfg.get("vars", {}), cfg
    for env_name, env_cfg in cfg.get("env", {}).items():
        yield env_name, env_cfg.get("name", f"{cfg['name']}-{env_name}"), env_cfg.get("vars", {}), env_cfg


def binding_names(section):
    """Names of non-secret bindings declared in a toml section (KV, queues, services...)."""
    names = set()
    for key in ("kv_namespaces", "services", "d1_databases", "r2_buckets"):
        names |= {b.get("binding") for b in section.get(key, [])}
    for q in section.get("queues", {}).get("producers", []):
        names.add(q.get("binding"))
    if "assets" in section and section["assets"].get("binding"):
        names.add(section["assets"]["binding"])
    return {n for n in names if n}


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        sys.exit("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set; source ~/.config/cloudflare/env")

    rows = []        # (worker_dir, env, script, kind, name)
    unused, missing, test_gaps, errors = [], [], [], []

    for toml_path in sorted(SRC.glob("*/wrangler.toml")):
        wdir = toml_path.parent
        cfg = tomllib.loads(toml_path.read_text())
        own = code_refs(wdir)
        refs = own | code_refs(SRC / "shared")
        per_env = {}
        for env_name, script, toml_vars, section in targets(cfg):
            live, err = live_bindings(script, cfg.get("account_id") or account, token)
            if err:
                errors.append(f"{script}: {err}")
                continue
            secrets = {n for n, t in live.items() if t == "secret_text"}
            plain = {n for n, t in live.items() if t == "plain_text"}
            per_env[env_name] = secrets
            for n in sorted(secrets):
                rows.append((wdir.name, env_name, script, "secret", n))
            for n in sorted(plain):
                rows.append((wdir.name, env_name, script, "var(toml)" if n in toml_vars else "var(live only)", n))
            for n in sorted(set(toml_vars) - plain):
                rows.append((wdir.name, env_name, script, "var(toml, not live)", n))
            for n in sorted(secrets - refs):
                unused.append(f"{script}: {n}")
            known = set(live) | set(toml_vars) | binding_names(section) | binding_names(cfg)
            for n in sorted(own - known):
                missing.append(f"{script}: {n}")
        if "prod" in per_env:
            for env_name, secrets in per_env.items():
                if env_name != "prod":
                    for n in sorted(per_env["prod"] - secrets):
                        test_gaps.append(f"{wdir.name} ({env_name}): {n}")

    md = "--markdown" in sys.argv
    if md:
        print("| worker dir | env | deployed name | kind | name |\n|---|---|---|---|---|")
        for r in rows:
            print("| " + " | ".join(r) + " |")
    else:
        for r in rows:
            print("\t".join(r))

    def section(title, items):
        print(f"\n## {title} ({len(items)})")
        for i in items:
            print(f"- {i}")

    section("Live secrets no code reads (delete candidates)", unused)
    section("Code reads with no live secret/var/binding (fails or falls back)", missing)
    section("Non-PROD env missing a secret PROD has", test_gaps)
    section("Workers the API could not read", errors)
    print("\nNote: 'delete candidates' count src/shared/ as read by every worker (so a"
          " shared-only name is never flagged); 'no live' uses only the worker's own dir.")


if __name__ == "__main__":
    main()
