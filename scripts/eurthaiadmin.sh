#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONTAINER="eur-thai-backend"
readonly DEFAULT_DAYS="14"
readonly DEFAULT_DAILY_CREDITS="30"
cyan='\033[1;36m'; green='\033[1;32m'; yellow='\033[1;33m'
red='\033[1;31m'; dim='\033[2m'; reset='\033[0m'

pause() { printf '\n'; read -r -p "Pulsa Enter para continuar..." _; }

header() {
  clear
  printf "${cyan}"
  printf '%s\n' "╔══════════════════════════════════════════════════╗"
  printf '%s\n' "║        EURTHAI · GESTOR DE INVITACIONES          ║"
  printf '%s\n' "╚══════════════════════════════════════════════════╝"
  printf "${reset}${dim}Accesos beta · 14 días · 30 créditos diarios${reset}\n\n"
}

container_ready() {
  if ! docker inspect --type container "$CONTAINER" >/dev/null 2>&1; then
    printf "${red}No existe el contenedor %s.${reset}\n" "$CONTAINER" >&2
    return 1
  fi
  if [[ $(docker inspect -f '{{.State.Running}}' "$CONTAINER") != "true" ]]; then
    printf "${red}El servicio EurThai no está activo.${reset}\n" >&2
    return 1
  fi
}

create_invite() {
  header
  printf "${green}ALTA DE TESTER${reset}\n\n"
  read -r -p "Nombre y apellidos: " alias_name
  alias_name="${alias_name#"${alias_name%%[![:space:]]*}"}"
  alias_name="${alias_name%"${alias_name##*[![:space:]]}"}"
  if [[ -z $alias_name ]]; then
    printf "\n${red}El nombre no puede estar vacío.${reset}\n"; pause; return
  fi
  printf '\nCreando invitación para %s...\n\n' "$alias_name"
  docker exec "$CONTAINER" npm run invites -- create "$alias_name" "$DEFAULT_DAYS" "$DEFAULT_DAILY_CREDITS"
  printf "\n${yellow}Copia ahora el enlace: el token no podrá consultarse después.${reset}\n"
  pause
}

list_invites() {
  header
  printf "${green}LISTADO Y CONSUMO${reset}\n\n"
  docker exec "$CONTAINER" npm run invites -- list
  printf "\n${dim}Los tokens completos no se almacenan; solo se conserva su hash.${reset}\n"
  pause
}

revoke_invite() {
  header
  printf "${green}REVOCAR INVITACIÓN${reset}\n\n"
  docker exec "$CONTAINER" npm run invites -- list
  printf '\n'
  read -r -p "ID que quieres revocar (vacío para cancelar): " invite_id
  [[ -z $invite_id ]] && return
  read -r -p "¿Revocar $invite_id? Escribe SI para confirmar: " confirmation
  if [[ $confirmation != "SI" ]]; then
    printf "\nOperación cancelada.\n"; pause; return
  fi
  printf '\n'
  if docker exec "$CONTAINER" npm run invites -- revoke "$invite_id"; then
    printf "\n${green}Invitación revocada.${reset}\n"
  else
    printf "\n${red}No se pudo revocar la invitación.${reset}\n"
  fi
  pause
}

show_help() {
  header
  printf "${green}AYUDA${reset}\n\n"
  cat <<'EOF'
ALTA     Genera un enlace individual. Debes copiarlo al crearlo.
LISTA    Muestra ID, alias, caducidad, estado y consumo.
REVOCAR  Invalida una invitación por ID tras pedir confirmación.

El token no se almacena en claro. Si se pierde, revoca el acceso
anterior y crea uno nuevo.
EOF
  pause
}

main() {
  container_ready || exit 1
  while true; do
    header
    printf '%s\n' "  1) Alta de tester" "  2) Listar invitaciones"
    printf '%s\n' "  3) Revocar invitación" "  4) Ayuda" "  5) Salir"
    printf '\n'
    read -r -p "Selecciona una opción [1-5]: " option
    case $option in
      1) create_invite ;;
      2) list_invites ;;
      3) revoke_invite ;;
      4) show_help ;;
      5) printf '\nHasta luego.\n'; exit 0 ;;
      *) printf "\n${red}Opción no válida.${reset}\n"; sleep 1 ;;
    esac
  done
}

main "$@"
