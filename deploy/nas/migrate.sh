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

mkdir -p "$data/config" "$data/auths" "$data/logs" "$project"
chmod 700 "$data" "$data/config" "$data/auths"
cp -p "$old"/runtime/auths/*.json "$data/auths/"

# Drop the old plugin and routing blocks, then add the fleet routing settings.
python3 - "$old/runtime/config/config.yaml" "$data/config/config.yaml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
drop = {"plugins", "routing"}
out, skipping = [], False
for line in open(src).read().splitlines():
    top = line[:1] not in ("", " ", "\t", "#", "-")
    if top:
        skipping = line.split(":", 1)[0].strip().strip("'\"") in drop
    if not skipping:
        out.append(line)
out += [
    "routing:",
    "  strategy: earliest-reset",
    "  session-affinity: true",
]
open(dst, "w").write("\n".join(out) + "\n")
PY
chmod 600 "$data/config/config.yaml"

curl -fsSL "$compose_url" -o "$project/compose.yaml"
chown -R ryan:users "$project"

echo "[migrate] Stopping the old controller (in-flight pool requests fail once)"
(cd "$old" && "$compose" -f compose.yaml -f compose.fleet.yaml stop controller) || "$docker" stop nas-fleet-controller-controller-1 || true

echo "[migrate] Done. In Container Manager: Project > Create > Path $project > use the existing compose.yaml."
echo "[migrate] Rollback: stop that project, then: cd $old && sudo $compose -f compose.yaml -f compose.fleet.yaml start controller"
