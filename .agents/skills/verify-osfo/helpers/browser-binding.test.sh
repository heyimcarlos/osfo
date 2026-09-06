#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -r "$scratch"' EXIT
printf '%s\n' '{"name":"osfo-verification-binding-test","vars":{"OSFO_STAGE":"test","KEEP":"unchanged"}}' >"$scratch/config.json"
printf '%s\n' '{"BROWSER_HOST_ENDPOINT":"http://127.0.0.1:39270/inventory","BROWSER_HOST_OWNER_USER_ID":"registered-owner","BROWSER_HOST_SESSION_ID":"exact-extension","BROWSER_HOST_TOKEN":"synthetic-token-with-more-than-32-characters","BROWSER_HOST_ALLOWED_ORIGINS":"[\"http://127.0.0.1:39271\"]"}' >"$scratch/binding.json"
cp "$scratch/config.json" "$scratch/before.json"
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" wrong-owner >/dev/null 2>&1; then exit 1; fi
cmp "$scratch/config.json" "$scratch/before.json"
jq '.BROWSER_HOST_ENDPOINT="https://remote.invalid/browser"' "$scratch/binding.json" >"$scratch/remote.json"
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/remote.json" registered-owner >/dev/null 2>&1; then exit 1; fi
cmp "$scratch/config.json" "$scratch/before.json"
bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" registered-owner
jq --exit-status '.vars.KEEP == "unchanged" and .vars.BROWSER_HOST_OWNER_USER_ID == "registered-owner" and .vars.BROWSER_HOST_TOKEN == null' "$scratch/config.json" >/dev/null
if bun "$script_dir/browser-binding.mjs" "$scratch/config.json" "$scratch/binding.json" registered-owner >/dev/null 2>&1; then exit 1; fi
[[ "$(stat -c '%a' "$scratch/.dev.vars")" == "600" ]]
grep -Fqx 'BROWSER_HOST_TOKEN=synthetic-token-with-more-than-32-characters' "$scratch/.dev.vars"
printf 'Browser binding owner, loopback, single-use, and preservation checks passed\n'

# Exercise the helper's actual selection query before its mutation boundary.
source <(sed -n '/^browser_bind() {$/,/^}$/p' "$script_dir/control-osfo")
doctor_run() { :; }
state_dir_for() { printf '%s\n' "$scratch"; }
state_value() { [[ "$2" == phone-e164 ]] && printf '+14165550100\n' || printf 'fixture\n'; }
docker() {
  local query
  while (( $# )); do
    if [[ "$1" == --command ]]; then query="$2"; break; fi
    shift
  done
  python3 - "$registration_stage" "$query" <<'PY'
import sqlite3, sys
stage = int(sys.argv[1])
db = sqlite3.connect(':memory:')
db.create_function('now', 0, lambda: '2026-09-06')
db.executescript('''create table users(id text, phone_number text, phone_number_verified boolean, registration_completed_at text);
create table sessions(user_id text, expires_at text);
create table agents(user_id text);
create table channel_links(user_id text);
insert into sessions values ('registered-owner','2099-01-01');''')
db.execute('insert into users values (?,?,?,?)', ('registered-owner', '+14165550100', stage >= 1, '2026-09-06' if stage >= 2 else None))
if stage >= 3: db.execute("insert into agents values ('registered-owner')")
if stage >= 4: db.execute("insert into channel_links values ('registered-owner')")
for row in db.execute(sys.argv[2]): print(row[0])
PY
}
bun() { touch "$scratch/binding-reached"; }
stop_process() { :; }
start_worker_process() { :; }
for registration_stage in 0 1 2 4; do
  if browser_bind fixture "$scratch/binding.json" >/dev/null 2>&1; then
    printf 'Incomplete or already linked account reached browser binding\n' >&2
    exit 1
  fi
  [[ ! -e "$scratch/binding-reached" ]]
done
registration_stage=3
# The runtime expects this existing run config; only the binding write is replaced above.
cp "$scratch/config.json" "$scratch/wrangler.json"
browser_bind fixture "$scratch/binding.json"
[[ -e "$scratch/binding-reached" ]]
printf 'Actual binding query requires verified phone, completed registration and provisioned Agent before mutation\n'
