#!/usr/bin/env bash
# One-time move from /volume1/docker/cli-proxy-api to the fleet-controller project.
# Run on the NAS: sudo bash migrate.sh
# It copies config and logins, switches routing to earliest-reset, writes the
# Container Manager compose file and stops the old container. It never deletes
# the old folder, so rollback is: stop the new project, start the old one.
set -euo pipefail

old=/volume1/docker/cli-proxy-api
data=/volume1/docker/fleet-controller
project=/volume1/docker/projects/fleet-controller
compose_url=https://raw.githubusercontent.com/ryanzigler/CLIProxyAPI/main/deploy/nas/compose.yaml
docker=/var/packages/ContainerManager/target/usr/bin/docker
compose=/var/packages/ContainerManager/target/usr/bin/docker-compose

if [ "$(id -u)" != 0 ]; then
	echo "Run with sudo bash $0" >&2
	exit 1
fi
if [ -e "$data/config/config.yaml" ]; then
	echo "[migrate] $data/config/config.yaml already exists; nothing changed" >&2
	exit 1
fi

mkdir -p "$data/config" "$data/auths" "$data/logs" "$data/keys" "$project"
# Same layout as the old runtime folder: ryan owns the folders (so the client
# key stays readable over SSH), root owns the config and logins inside them.
chown ryan:users "$data" "$data/config" "$data/auths" "$data/logs" "$data/keys"
chmod 700 "$data" "$data/config" "$data/auths" "$data/keys"
cp -p "$old"/runtime/auths/*.json "$data/auths/"
cp -p "$old"/runtime/keys/* "$data/keys/" 2>/dev/null || true

# Drop the old plugin block and switch routing to earliest-reset, keeping the
# rest of the routing block (retry, cooldown, affinity TTL) as it is.
python3 - "$old/runtime/config/config.yaml" "$data/config/config.yaml" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
out, block = [], None
strategy = affinity = False
for line in open(src).read().splitlines():
    if line[:1] not in ("", " ", "\t", "#", "-"):
        block = line.split(":", 1)[0].strip().strip("'\"")
        if block == "routing" and line.split(":", 1)[1].strip():
            sys.exit("[migrate] routing is not a block mapping; edit config.yaml by hand")
    if block == "plugins":
        continue
    if block == "routing":
        if re.match(r"^  strategy:", line):
            line, strategy = "  strategy: earliest-reset", True
        elif re.match(r"^  session-affinity:", line):
            line, affinity = "  session-affinity: true", True
    out.append(line)
if not strategy:
    if "routing:" in out:
        out.insert(out.index("routing:") + 1, "  strategy: earliest-reset")
    else:
        out += ["routing:", "  strategy: earliest-reset"]
if not affinity:
    out.insert(out.index("  strategy: earliest-reset") + 1, "  session-affinity: true")
open(dst, "w").write("\n".join(out) + "\n")
PY
chmod 600 "$data/config/config.yaml"

curl -fsSL "$compose_url" -o "$project/compose.yaml"
chown -R ryan:users "$project"

echo "[migrate] Stopping the old controller (in-flight pool requests fail once)"
(cd "$old" && "$compose" -f compose.yaml -f compose.fleet.yaml stop controller) || "$docker" stop nas-fleet-controller-controller-1 || true

echo "[migrate] Done. In Container Manager: Project > Create > Path $project > use the existing compose.yaml."
echo "[migrate] Rollback: stop that project, then: cd $old && sudo $compose -f compose.yaml -f compose.fleet.yaml start controller"
