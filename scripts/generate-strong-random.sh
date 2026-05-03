#!/usr/bin/env bash
set -euo pipefail

# Generate strong random strings for secrets/tokens.
# Default: URL-safe token, length 48 chars.

length=48
format="urlsafe" # urlsafe | hex | base64

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/generate-strong-random.sh [--length N] [--format urlsafe|hex|base64]

Examples:
  bash scripts/generate-strong-random.sh
  bash scripts/generate-strong-random.sh --length 64 --format hex
  bash scripts/generate-strong-random.sh --length 96 --format base64
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --length)
      shift
      length="${1:-}"
      ;;
    --format)
      shift
      format="${1:-}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift || true
done

if ! [[ "$length" =~ ^[0-9]+$ ]] || [[ "$length" -lt 16 ]] || [[ "$length" -gt 4096 ]]; then
  echo "--length must be an integer between 16 and 4096" >&2
  exit 1
fi

if [[ "$format" != "urlsafe" && "$format" != "hex" && "$format" != "base64" ]]; then
  echo "--format must be one of: urlsafe, hex, base64" >&2
  exit 1
fi

# Calculate raw byte size needed to satisfy output length.
# base64 expands by ~4/3, so raw bytes ~= ceil(length * 3 / 4)
raw_bytes=$(( (length * 3 + 3) / 4 ))

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

raw_b64="$(openssl rand -base64 "$raw_bytes" | tr -d '\n')"

case "$format" in
  hex)
    # hex output: use direct hex source with enough bytes
    hex_bytes=$(( (length + 1) / 2 ))
    openssl rand -hex "$hex_bytes" | cut -c1-"$length"
    ;;
  base64)
    printf '%s\n' "$raw_b64" | cut -c1-"$length"
    ;;
  urlsafe)
    # Convert base64 to URL-safe base64 and remove padding.
    token="$(printf '%s' "$raw_b64" | tr '+/' '-_' | tr -d '=')"
    if [[ "${#token}" -lt "$length" ]]; then
      # top up deterministically with extra random bytes if needed
      extra="$(openssl rand -base64 "$raw_bytes" | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
      token="${token}${extra}"
    fi
    printf '%s\n' "$token" | cut -c1-"$length"
    ;;
esac
