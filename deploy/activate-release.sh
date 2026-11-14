#!/usr/bin/env bash
# Run as an authorized operator. Never call this against another project path.
set -euo pipefail
release_id=${1:?Usage: activate-release.sh RELEASE_ID}
[[ "$release_id" =~ ^[0-9A-Za-z_-]+$ ]] || { echo 'Invalid release id' >&2; exit 1; }
project_root=/srv/favor
release_dir="$project_root/releases/$release_id"
[[ -f "$release_dir/dist/server/index.js" && -f "$release_dir/dist/server/migrate.js" && -f "$release_dir/dist/client/index.html" && -d "$release_dir/node_modules" ]] || { echo 'Incomplete release' >&2; exit 1; }
# Database backup is required before any schema work. Supply an existing protected dump.
backup_file=${FAVOR_BACKUP_FILE:?Set FAVOR_BACKUP_FILE to a verified database backup}
[[ -s "$backup_file" && -f "$backup_file" ]] || { echo 'Database backup missing' >&2; exit 1; }
previous_release=''
if [[ -L "$project_root/current" ]]; then
  systemctl is-active --quiet favor.service
  curl --fail --silent --max-time 3 http://127.0.0.1:3000/api/health >/dev/null
  previous_release=$(readlink -f "$project_root/current")
  [[ "$previous_release" == "$project_root/releases/"* && -f "$previous_release/dist/server/index.js" ]] || { echo 'Unknown current release; refusing to switch' >&2; exit 1; }
  [[ "$previous_release" != "$release_dir" ]] || { echo 'Release is already current; use a new immutable release id' >&2; exit 1; }
elif [[ -e "$project_root/current" ]]; then
  echo 'current must be a project-owned symlink' >&2; exit 1
fi
# Migrate from the candidate without changing the active release. Secrets stay server-only.
(cd "$release_dir" && sudo -u favor /usr/bin/node --env-file=/etc/favor/favor.env dist/server/migrate.js)
next_link="$project_root/.next-$release_id-$$"
trap 'rm -f "$next_link"' EXIT
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$project_root/current"
healthy=false
if systemctl restart favor.service; then
for attempt in {1..15}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then healthy=true; break; fi
  sleep 1
done
fi
if [[ "$healthy" == true ]] && systemctl is-active --quiet favor.service; then
  if [[ -n "$previous_release" && "$previous_release" != "$release_dir" ]]; then
    printf '%s\n' "$previous_release" > "$project_root/known-good"
  fi
  echo "Release active: $release_id"
  echo 'Check the public HTTPS URL and browser flow before pruning old releases.'
else
  if ! journalctl -u favor.service --no-pager -n 60 >&2; then
    echo 'Unable to read service journal; continuing rollback' >&2
  fi
  if [[ -n "$previous_release" && "$previous_release" != "$release_dir" ]]; then
    ln -s "$previous_release" "$next_link"
    mv -Tf "$next_link" "$project_root/current"
    systemctl restart favor.service
    curl --fail --silent --retry 5 --retry-delay 1 --retry-connrefused --max-time 3 http://127.0.0.1:3000/api/health >/dev/null
    echo "Rolled back code to: $previous_release" >&2
  else
    systemctl stop favor.service
    rm -f "$project_root/current"
    echo 'First release failed; no previous release to restore. Candidate retained for diagnosis.' >&2
  fi
  echo 'Activation failed. Schema is not automatically rolled back; restore only after assessing compatibility.' >&2
  exit 1
fi
