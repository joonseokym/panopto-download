#!/bin/zsh
cd -- "${0:A:h}" || exit 1
exec /usr/bin/python3 panopto_download.py "$@"
