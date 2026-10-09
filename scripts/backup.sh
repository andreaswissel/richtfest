#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: DATABASE_URL=... %s <backup-root> <file-storage-path>\n' "$0" >&2
}

die() {
  printf 'backup: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || { usage; exit 2; }
[ -n "${DATABASE_URL:-}" ] || die 'DATABASE_URL must be provided through the environment.'
[ -z "${BUCKET:-}" ] || die 'Railway Bucket backups require a separate S3-compatible object export; this helper is local-adapter-only.'
command -v pg_dump >/dev/null 2>&1 || die 'pg_dump is required.'
command -v tar >/dev/null 2>&1 || die 'tar is required.'

backup_root=$1
storage_path=$2
case "$backup_root" in /*) ;; *) die 'backup root must be an absolute path.' ;; esac
case "$storage_path" in /*) ;; *) die 'file-storage path must be an absolute path.' ;; esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
user_home=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)
if [ -z "$user_home" ] && command -v dscl >/dev/null 2>&1; then
  user_home=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
fi

canonical_existing_dir() {
  [ -d "$1" ] || return 1
  [ ! -L "$1" ] || return 1
  (cd "$1" && pwd -P)
}

reject_unsafe_path() {
  local candidate=$1
  [ "$candidate" != '/' ] || die "refusing root path: $candidate"
  [ -z "$user_home" ] || [ "$candidate" != "$user_home" ] || die "refusing home directory: $candidate"
  [ "$candidate" != "$repo_root" ] || die "refusing repository root: $candidate"
  case "/$candidate/" in
    */reference-project/*|*/context/*) die "refusing protected path: $candidate" ;;
  esac
}

mkdir -p "$backup_root"
backup_root=$(cd "$backup_root" && pwd -P)
storage_path=$(canonical_existing_dir "$storage_path") || die 'file-storage path must be an existing, non-symlink directory.'
reject_unsafe_path "$backup_root"
reject_unsafe_path "$storage_path"
[ -z "$(find "$storage_path" -type l -print -quit)" ] || die 'file-storage directory must not contain symlinks.'
case "$storage_path/" in "$backup_root"/*) die 'backup root cannot contain the file-storage directory.' ;; esac
case "$backup_root/" in "$storage_path"/*) die 'file-storage directory cannot contain the backup root.' ;; esac

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final_dir="$backup_root/richtfest-$timestamp"
[ ! -e "$final_dir" ] || die "backup already exists: $final_dir"
tmp_dir=$(mktemp -d "$backup_root/.richtfest-backup.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
umask 077

pg_dump --format=custom --no-owner --no-privileges --file="$tmp_dir/database.dump" "$DATABASE_URL"
tar -C "$(dirname "$storage_path")" -cf "$tmp_dir/file-storage.tar" "$(basename "$storage_path")"
{
  printf 'backup_version=1\n'
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'database_dump=database.dump\n'
  printf 'file_storage_archive=file-storage.tar\n'
  printf 'storage_backend=local\n'
  printf 'object_metadata=database.dump\n'
} >"$tmp_dir/manifest.env"

mv "$tmp_dir" "$final_dir"
trap - EXIT
printf 'Backup created: %s\n' "$final_dir"
