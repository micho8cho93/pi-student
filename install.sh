#!/bin/sh

set -eu
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

NODE_VERSION="24.3.0"
PASEO_VERSION="0.8.0"
DESERTANT_VERSION="v0.1.1"
DEFAULT_RELEASE_BASE="__PI_STUDENT_RELEASE_BASE_URL__"
INSTALL_ROOT="${PI_STUDENT_HOME:-${HOME}/.pi-student}"
RELEASE_BASE="${PI_STUDENT_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE}"
LOG_DIR="$INSTALL_ROOT/logs"
LOG_FILE="$LOG_DIR/install.log"
TEMP_DIR=""
PLATFORM=""
NODE_PLATFORM=""
QEMU_SYSTEM=""
NODE_BACKUP=""
APP_BACKUP=""
PASEO_BACKUP=""
VOZ_BACKUP=""
INSTALL_GUI=1

say() { printf '%s\n' "$1"; }
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE"; }
fail() {
	restore_previous
  say ""
  say "Installation could not complete."
  say ""
  say "$1"
  say ""
  say "Run:"
  say "  pi-student doctor"
  say ""
  say "Diagnostic log:"
  say "  $LOG_FILE"
  exit 1
}
restore_previous() {
  if [ -n "$APP_BACKUP" ] && [ -d "$APP_BACKUP" ]; then
    rm -rf "$INSTALL_ROOT/app"
    mv "$APP_BACKUP" "$INSTALL_ROOT/app"
    APP_BACKUP=""
  fi
  if [ -n "$NODE_BACKUP" ] && [ -d "$NODE_BACKUP" ]; then
    rm -rf "$INSTALL_ROOT/runtime/node"
    mv "$NODE_BACKUP" "$INSTALL_ROOT/runtime/node"
    NODE_BACKUP=""
  fi
  if [ -n "$PASEO_BACKUP" ] && [ -d "$PASEO_BACKUP" ]; then
    rm -rf "$INSTALL_ROOT/runtime/paseo"
    mv "$PASEO_BACKUP" "$INSTALL_ROOT/runtime/paseo"
    PASEO_BACKUP=""
  fi
  if [ -n "$VOZ_BACKUP" ] && [ -f "$VOZ_BACKUP" ]; then
    rm -f "$INSTALL_ROOT/runtime/voz/desertant"
    mv "$VOZ_BACKUP" "$INSTALL_ROOT/runtime/voz/desertant"
    VOZ_BACKUP=""
  fi
}
cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then rm -rf "$TEMP_DIR"; fi
  if [ -n "${INSTALL_STAGE:-}" ] && [ -d "$INSTALL_STAGE" ]; then rm -rf "$INSTALL_STAGE"; fi
}
on_exit() {
  install_exit_code=$?
  if [ "$install_exit_code" -ne 0 ]; then restore_previous; fi
  cleanup
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

detect_platform() {
  os_name=$(uname -s 2>/dev/null || true)
  arch_name=$(uname -m 2>/dev/null || true)
  case "$os_name" in
    Darwin) os="darwin"; NODE_PLATFORM="darwin" ;;
    Linux) os="linux"; NODE_PLATFORM="linux" ;;
    *) fail "Pi Student supports macOS and Linux; this system reports '$os_name'." ;;
  esac
  case "$arch_name" in
    arm64|aarch64) arch="arm64"; QEMU_SYSTEM="qemu-system-aarch64" ;;
    x86_64|amd64) arch="x64"; QEMU_SYSTEM="qemu-system-x86_64" ;;
    *) fail "Pi Student supports arm64 and x64; this system reports '$arch_name'." ;;
  esac
  PLATFORM="$os-$arch"
}

download() {
  destination=$1
  url=$2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 20 "$url" -o "$destination" >>"$LOG_FILE" 2>&1 || fail "A required download could not be completed. Check your connection and rerun the installer."
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "A SHA-256 utility (sha256sum or shasum) is required to verify downloads."
  fi
}

verify_checksum() {
  file=$1
  expected=$2
  actual=$(sha256_file "$file")
  [ "$actual" = "$expected" ] || fail "A downloaded file failed its security check. No unverified files were installed."
}

install_node() {
  current="$INSTALL_ROOT/runtime/node/bin/node"
  if [ -x "$current" ] && [ "$($current --version 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
    log "Application-owned Node runtime is current"
    return
  fi
  node_archive="node-v$NODE_VERSION-$NODE_PLATFORM-${PLATFORM##*-}.tar.gz"
  node_url="https://nodejs.org/dist/v$NODE_VERSION/$node_archive"
  say "Installing application runtime..."
  download "$TEMP_DIR/$node_archive" "$node_url"
  download "$TEMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  node_checksum=$(awk -v file="$node_archive" '$2 == file || $2 == "*" file { print $1; exit }' "$TEMP_DIR/SHASUMS256.txt")
  [ -n "$node_checksum" ] || fail "Could not find the runtime checksum published by Node.js."
  verify_checksum "$TEMP_DIR/$node_archive" "$node_checksum"
  mkdir -p "$INSTALL_STAGE/node"
  tar -xzf "$TEMP_DIR/$node_archive" -C "$INSTALL_STAGE/node" --strip-components=1 >>"$LOG_FILE" 2>&1 || fail "The application runtime archive could not be unpacked."
  rm -rf "$INSTALL_ROOT/runtime/node.new"
  mv "$INSTALL_STAGE/node" "$INSTALL_ROOT/runtime/node.new"
  NODE_BACKUP="$INSTALL_ROOT/runtime/node.previous.$$"
  rm -rf "$NODE_BACKUP"
  if [ -d "$INSTALL_ROOT/runtime/node" ]; then mv "$INSTALL_ROOT/runtime/node" "$NODE_BACKUP"; fi
  mv "$INSTALL_ROOT/runtime/node.new" "$INSTALL_ROOT/runtime/node"
  say "✓ Runtime installed"
}

install_application() {
  artifact="pi-student-$PLATFORM.tar.gz"
  say "Installing Pi Student..."
  if [ "$RELEASE_BASE" = "__PI_STUDENT_""RELEASE_BASE_URL__" ]; then
    fail "This installer has not been attached to a Pi Student release. Set PI_STUDENT_RELEASE_BASE_URL to an HTTPS release directory."
  fi
  download "$TEMP_DIR/$artifact" "$RELEASE_BASE/$artifact"
  download "$TEMP_DIR/SHA256SUMS" "$RELEASE_BASE/SHA256SUMS"
  artifact_checksum=$(awk -v file="$artifact" '$2 == file || $2 == "*" file { print $1; exit }' "$TEMP_DIR/SHA256SUMS")
  [ -n "$artifact_checksum" ] || fail "The release did not publish a checksum for $artifact."
  verify_checksum "$TEMP_DIR/$artifact" "$artifact_checksum"
  mkdir -p "$INSTALL_STAGE/app"
  tar -xzf "$TEMP_DIR/$artifact" -C "$INSTALL_STAGE/app" >>"$LOG_FILE" 2>&1 || fail "The Pi Student archive could not be unpacked."
  [ -f "$INSTALL_STAGE/app/dist/cli.js" ] || fail "The Pi Student release artifact is incomplete."
  rm -rf "$INSTALL_ROOT/app.new"
  mv "$INSTALL_STAGE/app" "$INSTALL_ROOT/app.new"
  APP_BACKUP="$INSTALL_ROOT/app.previous.$$"
  rm -rf "$APP_BACKUP"
  if [ -d "$INSTALL_ROOT/app" ]; then mv "$INSTALL_ROOT/app" "$APP_BACKUP"; fi
  mv "$INSTALL_ROOT/app.new" "$INSTALL_ROOT/app"
  say "✓ Pi Student installed"
}

install_voz() {
  case "$PLATFORM" in
    darwin-arm64) voz_os="darwin"; voz_arch="arm64" ;;
    darwin-x64) voz_os="darwin"; voz_arch="x86_64" ;;
    linux-arm64) voz_os="linux"; voz_arch="arm64" ;;
    linux-x64) voz_os="linux"; voz_arch="x86_64" ;;
    *) fail "Voz is not available for $PLATFORM." ;;
  esac
  voz_asset="desertant-$voz_os-$voz_arch.tar.gz"
  voz_base="https://github.com/Desert-Ant-Labs/desert-ant-cli/releases/download/$DESERTANT_VERSION"
  say "Installing bundled Voz runtime..."
  download "$TEMP_DIR/$voz_asset" "$voz_base/$voz_asset"
  download "$TEMP_DIR/voz-checksums.txt" "$voz_base/checksums.txt"
  voz_checksum=$(grep " $voz_asset$" "$TEMP_DIR/voz-checksums.txt" | awk '{print $1; exit}')
  [ -n "$voz_checksum" ] || fail "Could not find the bundled Voz runtime checksum."
  verify_checksum "$TEMP_DIR/$voz_asset" "$voz_checksum"
  rm -rf "$INSTALL_STAGE/voz"
  mkdir -p "$INSTALL_STAGE/voz"
  tar -xzf "$TEMP_DIR/$voz_asset" -C "$INSTALL_STAGE/voz" >>"$LOG_FILE" 2>&1 || fail "The bundled Voz runtime could not be unpacked."
  [ -f "$INSTALL_STAGE/voz/desertant" ] || fail "The bundled Voz runtime is incomplete."
  mkdir -p "$INSTALL_ROOT/runtime/voz"
  VOZ_BACKUP="$INSTALL_ROOT/runtime/voz/desertant.previous.$$"
  rm -f "$VOZ_BACKUP"
  if [ -f "$INSTALL_ROOT/runtime/voz/desertant" ]; then mv "$INSTALL_ROOT/runtime/voz/desertant" "$VOZ_BACKUP"; fi
  mv "$INSTALL_STAGE/voz/desertant" "$INSTALL_ROOT/runtime/voz/desertant"
  chmod 755 "$INSTALL_ROOT/runtime/voz/desertant"
  say "✓ Bundled Voz runtime installed"
}

install_paseo() {
  [ "$INSTALL_GUI" -eq 1 ] || { log "Terminal-only install requested; Paseo was not changed"; return; }
  say "Installing Paseo GUI..."
  node_bin="$INSTALL_ROOT/runtime/node/bin/node"
  npm_cli="$INSTALL_ROOT/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
  [ -x "$node_bin" ] && [ -f "$npm_cli" ] || fail "The application runtime does not include npm, so Paseo could not be installed."
  rm -rf "$INSTALL_STAGE/paseo"
  mkdir -p "$INSTALL_STAGE/paseo"
  "$node_bin" "$npm_cli" install --prefix "$INSTALL_STAGE/paseo" --omit=dev --no-audit --no-fund "@getpaseo/cli@$PASEO_VERSION" >>"$LOG_FILE" 2>&1 || fail "Paseo could not be installed. Check your connection and rerun the installer."
  [ -x "$INSTALL_STAGE/paseo/node_modules/.bin/paseo" ] || fail "The Paseo installation is incomplete."
  PASEO_BACKUP="$INSTALL_ROOT/runtime/paseo.previous.$$"
  rm -rf "$PASEO_BACKUP"
  if [ -d "$INSTALL_ROOT/runtime/paseo" ]; then mv "$INSTALL_ROOT/runtime/paseo" "$PASEO_BACKUP"; fi
  mv "$INSTALL_STAGE/paseo" "$INSTALL_ROOT/runtime/paseo"
  say "✓ Paseo GUI installed"
}

qemu_ready() {
  command -v "$QEMU_SYSTEM" >/dev/null 2>&1 && command -v qemu-img >/dev/null 2>&1
}

provision_qemu() {
  if qemu_ready; then return; fi
  say "Preparing secure coding runtime fallback..."
  case "$PLATFORM" in
    darwin-*)
      if command -v brew >/dev/null 2>&1; then
        brew install qemu >>"$LOG_FILE" 2>&1 || fail "The secure coding runtime could not be installed with Homebrew."
      else
        fail "The packaged runtime could not start and QEMU is unavailable. On Intel macOS, install Homebrew and rerun this installer."
      fi
      ;;
    linux-*)
      command -v apt-get >/dev/null 2>&1 || fail "Automatic runtime repair currently supports Debian and Ubuntu Linux."
      if [ "$(id -u)" -eq 0 ]; then
        apt-get update >>"$LOG_FILE" 2>&1 || fail "The Linux package list could not be updated."
        if [ "$QEMU_SYSTEM" = "qemu-system-aarch64" ]; then apt-get install -y qemu-system-arm qemu-utils >>"$LOG_FILE" 2>&1 || fail "The secure coding runtime packages could not be installed."; else apt-get install -y qemu-system-x86 qemu-utils >>"$LOG_FILE" 2>&1 || fail "The secure coding runtime packages could not be installed."; fi
      elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get update >>"$LOG_FILE" 2>&1 || fail "The Linux package list could not be updated."
        if [ "$QEMU_SYSTEM" = "qemu-system-aarch64" ]; then sudo apt-get install -y qemu-system-arm qemu-utils >>"$LOG_FILE" 2>&1 || fail "The secure coding runtime packages could not be installed."; else sudo apt-get install -y qemu-system-x86 qemu-utils >>"$LOG_FILE" 2>&1 || fail "The secure coding runtime packages could not be installed."; fi
      else
        fail "Installing the secure coding runtime requires administrator access on this Linux system."
      fi
      ;;
  esac
  qemu_ready || fail "The secure coding runtime installation completed, but required executables are still unavailable."
}

ensure_path() {
  path_line="export PATH=\"$INSTALL_ROOT/bin:\$PATH\""
  case "${SHELL:-}" in
    */zsh) profile="${ZDOTDIR:-$HOME}/.zprofile" ;;
    */bash) profile="$HOME/.bash_profile"; [ -f "$profile" ] || profile="$HOME/.profile" ;;
    *) profile="$HOME/.profile" ;;
  esac
  touch "$profile"
  if ! grep -Fqx "$path_line" "$profile"; then
    printf '\n# Pi Student\n%s\n' "$path_line" >>"$profile"
    log "Added Pi Student bin directory to $profile"
  fi
  export PATH="$INSTALL_ROOT/runtime/native/bin:$INSTALL_ROOT/bin:$PATH"
}

verify_installation() {
  export PI_STUDENT_HOME="$INSTALL_ROOT"
  export XDG_CACHE_HOME="$INSTALL_ROOT/cache"
  say "Setting up secure coding environment..."
  say "Downloading sandbox image if needed..."
  if "$INSTALL_ROOT/runtime/node/bin/node" "$INSTALL_ROOT/app/dist/cli.js" repair >>"$LOG_FILE" 2>&1; then return; fi
  log "Primary runtime verification failed; attempting QEMU fallback provisioning"
  provision_qemu
  "$INSTALL_ROOT/runtime/node/bin/node" "$INSTALL_ROOT/app/dist/cli.js" repair >>"$LOG_FILE" 2>&1 || fail "The secure coding environment did not pass its startup test."
}

main() {
  umask 077
  for option in "$@"; do
    case "$option" in
      --terminal-only) INSTALL_GUI=0 ;;
      --with-gui) INSTALL_GUI=1 ;;
      *) fail "Unknown installer option: $option" ;;
    esac
  done
  case "$INSTALL_ROOT" in ""|/|"$HOME") fail "Refusing to use an unsafe installation directory." ;; esac
  mkdir -p "$INSTALL_ROOT" "$LOG_DIR" "$INSTALL_ROOT/runtime" "$INSTALL_ROOT/cache" "$INSTALL_ROOT/images" "$INSTALL_ROOT/config" "$INSTALL_ROOT/bin"
  : >"$LOG_FILE"
  chmod 700 "$INSTALL_ROOT" "$LOG_DIR" "$INSTALL_ROOT/runtime" "$INSTALL_ROOT/cache" "$INSTALL_ROOT/images" "$INSTALL_ROOT/config" "$INSTALL_ROOT/bin"
  TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-student-install.XXXXXX")
  INSTALL_STAGE="$INSTALL_ROOT/.install.$$"
  mkdir -p "$INSTALL_STAGE"
  say "Installing Pi Student..."
  say ""
  detect_platform
  say "✓ Platform detected"
  log "Detected $PLATFORM"
  if [ "$RELEASE_BASE" = "__PI_STUDENT_""RELEASE_BASE_URL__" ]; then
    fail "This source installer has not been attached to a release yet. Use the install.sh asset published by the release workflow."
  fi
  install_node
  install_voz
  install_application
  install_paseo
  ensure_path
  verify_installation
  if [ -n "$APP_BACKUP" ]; then rm -rf "$APP_BACKUP"; APP_BACKUP=""; fi
  if [ -n "$NODE_BACKUP" ]; then rm -rf "$NODE_BACKUP"; NODE_BACKUP=""; fi
  if [ -n "$PASEO_BACKUP" ]; then rm -rf "$PASEO_BACKUP"; PASEO_BACKUP=""; fi
  if [ -n "$VOZ_BACKUP" ]; then rm -f "$VOZ_BACKUP"; VOZ_BACKUP=""; fi
  say "✓ Secure coding environment prepared"
  say "✓ Sandbox verified"
  say "✓ Command installed"
	if [ "$INSTALL_GUI" -eq 1 ]; then say "✓ Terminal and GUI interfaces installed"; else say "✓ Terminal interface installed"; fi
  say ""
  say "Pi Student is ready."
  say ""
  say "Run:"
  say ""
  say "  pi-student"
}

main "$@"
