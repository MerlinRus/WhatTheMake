#!/bin/sh
set -eu
source=${1:?Pass the release source directory}
tag=${2:?Pass the release tag}
case "$source" in /srv/whatthemake/work/*|/srv/whatthemake/releases/*) ;; *) exit 2 ;; esac
case "$tag" in *[!a-zA-Z0-9._-]*|'') exit 2 ;; esac
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
trap 'printf "%s\n" "$?" > "$source/verification.exit"' EXIT
docker build --target verification -t "whatthemake-verification:$tag" "$source"
sh "$script_root/verify-isolated.sh" "whatthemake-verification:$tag"
sh "$script_root/verify-browser.sh" "whatthemake-verification:$tag" "$source" whatthemake-e2e:compare-dev-6
