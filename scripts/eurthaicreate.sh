#!/usr/bin/env bash

set -Eeuo pipefail

readonly CONTAINER="eur-thai-backend"
readonly DEFAULT_DAYS="14"
readonly DEFAULT_DAILY_CREDITS="30"

usage() {
  cat <<'EOF'
Uso:
  eurthaicreate <nombre y apellidos>

Ejemplos:
  eurthaicreate Ana García López
  eurthaicreate "Ana García López"

Crea una invitación de EurThai válida durante 14 días y con 30 créditos diarios.
El enlace se muestra una sola vez. Guárdalo o envíalo al tester al terminar.
EOF
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

if ! docker inspect --type container "$CONTAINER" >/dev/null 2>&1; then
  echo "Error: no existe el contenedor $CONTAINER." >&2
  exit 1
fi

if [[ $(docker inspect -f '{{.State.Running}}' "$CONTAINER") != "true" ]]; then
  echo "Error: el contenedor $CONTAINER no está activo." >&2
  exit 1
fi

alias_name="$*"

echo "Creando acceso para: $alias_name"
docker exec "$CONTAINER" npm run invites -- create "$alias_name" "$DEFAULT_DAYS" "$DEFAULT_DAILY_CREDITS"
