#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 RUN_ID" >&2
  exit 2
fi

run_id=$1
case "$run_id" in
  "" | *[!0-9]*)
    echo "RUN_ID must contain digits only" >&2
    exit 2
    ;;
esac

shared_dir=/srv/whatthemake/shared
env_file=$shared_dir/.env
private_key=$shared_dir/provider-secrets-decrypt.pem
encrypted_file=$shared_dir/provider-secrets-$run_id.env.enc
backup_file=$shared_dir/.env.before-provider-secrets-$run_id
umask 077
plain_file=$(mktemp "$shared_dir/.provider-secrets.XXXXXX")
merged_file=$(mktemp "$shared_dir/.env.merged.XXXXXX")

cleanup() {
  if [ -f "$plain_file" ]; then
    shred -u "$plain_file" 2>/dev/null || rm -f "$plain_file"
  fi
  rm -f "$merged_file"
}
trap cleanup EXIT HUP INT TERM

test -f "$env_file"
test -f "$private_key"
test -f "$encrypted_file"
test ! -e "$backup_file"
test "$(stat -c %a "$env_file")" = 600
test "$(stat -c %a "$private_key")" = 600
test "$(wc -c < "$encrypted_file")" -eq 384

openssl pkeyutl \
  -decrypt \
  -inkey "$private_key" \
  -pkeyopt rsa_padding_mode:oaep \
  -pkeyopt rsa_oaep_md:sha256 \
  -pkeyopt rsa_mgf1_md:sha256 \
  -in "$encrypted_file" \
  -out "$plain_file"

test "$(wc -l < "$plain_file")" -eq 2
test "$(grep -c '^GOOGLE_VISION_API_KEY=' "$plain_file")" -eq 1
test "$(grep -c '^DEEPSEEK_API_KEY=' "$plain_file")" -eq 1
LC_ALL=C grep -Eq '^GOOGLE_VISION_API_KEY=AIza[A-Za-z0-9_-]{20,}$' "$plain_file"
LC_ALL=C grep -Eq '^DEEPSEEK_API_KEY=sk-[A-Za-z0-9_-]{20,}$' "$plain_file"

sed \
  -e '/^GOOGLE_VISION_API_KEY=/d' \
  -e '/^DEEPSEEK_API_KEY=/d' \
  "$env_file" \
  > "$merged_file"
printf '\n' >> "$merged_file"
cat "$plain_file" >> "$merged_file"

cp -p -- "$env_file" "$backup_file"
chmod 600 "$backup_file"
chown root:root "$backup_file"
chmod 600 "$merged_file"
chown root:root "$merged_file"
mv -f -- "$merged_file" "$env_file"

test "$(grep -c '^GOOGLE_VISION_API_KEY=' "$env_file")" -eq 1
test "$(grep -c '^DEEPSEEK_API_KEY=' "$env_file")" -eq 1
test "$(stat -c %a "$env_file")" = 600

echo "provider-secrets-installed"
