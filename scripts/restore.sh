#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: DATABASE_URL=... %s <backup-directory> <file-storage-target> [--clean-db] [--replace-files]\n' "$0" >&2
}

die() {
  printf 'restore: %s\n' "$1" >&2
  exit 1
}

[ "$#" -ge 2 ] || { usage; exit 2; }
[ -n "${DATABASE_URL:-}" ] || die 'DATABASE_URL must be provided through the environment.'
[ -z "${BUCKET:-}" ] || die 'Railway Bucket recovery requires a separately exported object set; this helper is local-adapter-only.'
command -v pg_restore >/dev/null 2>&1 || die 'pg_restore is required.'
command -v tar >/dev/null 2>&1 || die 'tar is required.'

backup_dir=$1
storage_target=$2
shift 2
clean_db=false
replace_files=false
for option in "$@"; do
  case "$option" in
    --clean-db) clean_db=true ;;
    --replace-files) replace_files=true ;;
    *) usage; die "unknown option: $option" ;;
  esac
done

case "$backup_dir" in /*) ;; *) die 'backup directory must be an absolute path.' ;; esac
case "$storage_target" in /*) ;; *) die 'file-storage target must be an absolute path.' ;; esac
[ -d "$backup_dir" ] || die 'backup directory must exist.'
[ ! -L "$backup_dir" ] || die 'backup directory must not be a symlink.'
backup_dir=$(cd "$backup_dir" && pwd -P)

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
user_home=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)
if [ -z "$user_home" ] && command -v dscl >/dev/null 2>&1; then
  user_home=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
fi
reject_unsafe_path() {
  local candidate=$1
  [ "$candidate" != '/' ] || die "refusing root path: $candidate"
  [ -z "$user_home" ] || [ "$candidate" != "$user_home" ] || die "refusing home directory: $candidate"
  [ "$candidate" != "$repo_root" ] || die "refusing repository root: $candidate"
  case "/$candidate/" in
    */reference-project/*|*/context/*) die "refusing protected path: $candidate" ;;
  esac
}
reject_unsafe_path "$backup_dir"
reject_unsafe_path "$storage_target"

[ -f "$backup_dir/manifest.env" ] || die 'manifest.env is missing.'
[ -f "$backup_dir/database.dump" ] || die 'database.dump is missing.'
[ -f "$backup_dir/file-storage.tar" ] || die 'file-storage.tar is missing.'
grep -qx 'backup_version=1' "$backup_dir/manifest.env" || die 'unsupported backup version.'

archive_listing=$(tar -tf "$backup_dir/file-storage.tar")
[ -n "$archive_listing" ] || die 'file-storage.tar is empty.'
while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|..|*/..|*'\n'*) die "unsafe archive entry: $entry" ;;
  esac
done <<<"$archive_listing"
while IFS= read -r entry; do
  case "$entry" in
    l*) die 'file-storage archive must not contain symlinks.' ;;
  esac
done < <(tar -tvf "$backup_dir/file-storage.tar")

storage_parent=$(dirname "$storage_target")
mkdir -p "$storage_parent"
storage_parent=$(cd "$storage_parent" && pwd -P)
reject_unsafe_path "$storage_parent"
[ "$storage_target" != "$storage_parent" ] || die 'file-storage target must be a child path, not its parent.'
[ ! -e "$storage_target" ] || $replace_files || die 'file-storage target exists; use --replace-files for a disposable target.'

tmp_dir=$(mktemp -d "$storage_parent/.richtfest-restore.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
umask 077
tar -xf "$backup_dir/file-storage.tar" -C "$tmp_dir"

entries=()
while IFS= read -r -d '' entry; do entries+=("$entry"); done < <(find "$tmp_dir" -mindepth 1 -maxdepth 1 -print0)
[ "${#entries[@]}" -eq 1 ] || die 'file-storage archive must contain exactly one top-level directory.'
restored_storage=${entries[0]}
[ -d "$restored_storage" ] || die 'file-storage archive top-level entry is not a directory.'

restore_args=(--exit-on-error --no-owner --no-privileges)
$clean_db && restore_args+=(--clean --if-exists)
pg_restore "${restore_args[@]}" --dbname="$DATABASE_URL" "$backup_dir/database.dump"

previous_target=''
if [ -e "$storage_target" ]; then
  previous_target="$storage_target.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$previous_target" ] || die "restore archive collision: $previous_target"
  mv "$storage_target" "$previous_target"
fi
mv "$restored_storage" "$storage_target"
printf 'Restore completed into database and file storage.\n'
[ -z "$previous_target" ] || printf 'Previous file storage preserved at: %s\n' "$previous_target"
