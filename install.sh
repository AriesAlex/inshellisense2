#!/bin/sh
set -eu

shell=${INSHELLISENSE2_SHELL:-${SHELL:-sh}}
shell=${shell##*/}
install_dir=${INSHELLISENSE2_INSTALL_DIR:-$HOME/.local/bin}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shell) [ "$#" -ge 2 ] || { printf 'Missing shell name.\n' >&2; exit 1; }; shell=$2; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
case "$shell" in
  sh|bash|zsh|pwsh) ;;
  *) printf 'Specify a shell: sh, bash, zsh, or pwsh (--shell NAME).\n' >&2; exit 1 ;;
esac
command -v "$shell" >/dev/null 2>&1 || { printf 'Shell not installed: %s\n' "$shell" >&2; exit 1; }
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Required command: %s\n' "$tool" >&2; exit 1; }
done
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) printf 'Use install.ps1 on Windows.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

repo=https://github.com/AriesAlex/inshellisense2
version=${INSHELLISENSE2_VERSION:-}
if [ -z "$version" ]; then
  release=$(curl -fLsS --retry 3 -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
  version=${release##*/}
fi
case "$version" in v[0-9]*) ;; *) printf 'Cannot resolve a release version.\n' >&2; exit 1 ;; esac
base=${INSHELLISENSE2_RELEASE_URL:-$repo/releases/download/$version}
asset=inshellisense2-$os-$arch.tar.gz
binary=inshellisense2-$os-$arch
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' 0
trap 'exit 1' 1 2 15
curl -fLsS --retry 3 "$base/$asset" -o "$temp_dir/$asset"
curl -fLsS --retry 3 "$base/SHA256SUMS" -o "$temp_dir/SHA256SUMS"
expected=$(awk -v file="$asset" '{ name=$2; sub(/^\*/, "", name); if (name == file) print $1 }' "$temp_dir/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temp_dir/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$temp_dir/$asset" | awk '{print $1}')
fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { printf 'Release checksum mismatch.\n' >&2; exit 1; }
tar -xzf "$temp_dir/$asset" -C "$temp_dir"
mkdir -p "$install_dir"
staged_binary="$install_dir/.inshellisense2-install-$$"
cp "$temp_dir/$binary" "$staged_binary"
chmod 755 "$staged_binary"
mv -f "$staged_binary" "$install_dir/inshellisense2"
"$install_dir/inshellisense2" init "$shell" --install
cp "$temp_dir/LICENSE" "$temp_dir/THIRD_PARTY_NOTICES.txt" "$HOME/.inshellisense2/"
printf '\nInstalled inshellisense2 %s. Open a new terminal.\n' "$version"
