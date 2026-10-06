#!/bin/sh
# One snapshot of everything the instance is: ./data, which holds db.json (accounts,
# subscriptions, device bindings, plan requests, community posts), state-<uid>.json and
# plan-<uid>.json per client, uploads/ with their photos and videos, the session secret and the
# activity log. There is no database to dump — copying the folder is the backup.
#
# Meant for cron on the server that runs docker compose. Daily, at 3am:
#
#   0 3 * * * /srv/carefit/scripts/backup.sh >> /var/log/carefit-backup.log 2>&1
#
# Settings, all optional, as environment variables:
#
#   DATA_DIR       what to back up            (default: ./data beside this repo)
#   BACKUP_DIR     where snapshots land       (default: ./backups)
#   BACKUP_KEEP    how many to keep locally   (default: 14)
#   BACKUP_REMOTE  an rclone destination      (default: none — local only)
#
# BACKUP_REMOTE is the part that matters. A snapshot sitting on the same disk as the thing it
# is a snapshot of protects you against a bad deploy and nothing else; the whole point is the
# off-box copy. Any rclone remote works (S3, Backblaze B2, Google Drive, another box over SFTP):
#
#   rclone config                                  # once, interactively
#   BACKUP_REMOTE=b2:carefit-backups ./scripts/backup.sh
#
# Note what this archive is: every client's training history and photos, their sign-in times,
# and the HMAC key that signs session cookies. Encrypt it if it is going anywhere you do not
# own — rclone's `crypt` remote does that, and is the reason this script hands off to rclone
# rather than growing its own uploader.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${DATA_DIR:-"$ROOT/data"}
BACKUP_DIR=${BACKUP_DIR:-"$ROOT/backups"}
BACKUP_KEEP=${BACKUP_KEEP:-14}
BACKUP_REMOTE=${BACKUP_REMOTE:-}

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { say "FAILED: $*" >&2; exit 1; }

[ -d "$DATA_DIR" ] || die "no data directory at $DATA_DIR"
[ -f "$DATA_DIR/db.json" ] || die "$DATA_DIR has no db.json — is that really the data directory?"

mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"

STAMP=$(date +%Y-%m-%dT%H%M%S)
NAME="carefit-$STAMP.tar.gz"
OUT="$BACKUP_DIR/$NAME"

# Written under a temp name and moved into place, so a snapshot that only half happened is
# never left looking like a finished one. The server writes its own files the same way
# (atomicWrite in api/server.js), which is why taking this against a running instance is safe:
# a rename is atomic, so every file in the archive is some complete version of itself.
TMP="$BACKUP_DIR/.$NAME.part"
trap 'rm -f "$TMP"' EXIT INT TERM

say "backing up $DATA_DIR"
tar czf "$TMP" -C "$(dirname -- "$DATA_DIR")" "$(basename -- "$DATA_DIR")" \
  || die "tar could not read $DATA_DIR"

# Reading it back costs a few seconds and is the difference between having backups and
# believing you have backups.
tar tzf "$TMP" >/dev/null 2>&1 || die "the archive it just wrote does not read back"

mv "$TMP" "$OUT"
trap - EXIT INT TERM
say "wrote $OUT ($(du -h "$OUT" | cut -f1))"

if [ -n "$BACKUP_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || die "BACKUP_REMOTE is set but rclone is not installed"
  say "copying to $BACKUP_REMOTE"
  rclone copy "$OUT" "$BACKUP_REMOTE" || die "rclone could not reach $BACKUP_REMOTE"
  say "copied off-box"
else
  say "BACKUP_REMOTE not set — this copy is on the same disk as the original"
fi

# Pruning happens last and only locally: if the upload failed we exited above, and the old
# snapshots are still here. Remote retention is the remote's business (B2 and S3 both do
# lifecycle rules better than a shell loop would).
if [ "$BACKUP_KEEP" -gt 0 ] 2>/dev/null; then
  ls -1t "$BACKUP_DIR"/carefit-*.tar.gz 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r old; do
    say "pruning $(basename -- "$old")"
    rm -f "$old"
  done
fi

say "done"
