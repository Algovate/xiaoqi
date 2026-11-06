#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-/tmp/xiaoqi-clang-cache}"
export SWIFT_MODULECACHE_PATH="${SWIFT_MODULECACHE_PATH:-/tmp/xiaoqi-clang-cache}"
mkdir -p "$CLANG_MODULE_CACHE_PATH"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS only: Apple Vision OCR"
  exit 1
fi
swiftc -O tools/ocr.swift -o tools/ocr-bin \
  -framework AppKit -framework PDFKit -framework Vision
echo "built tools/ocr-bin"
