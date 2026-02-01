#!/bin/sh
# Builds the CodeNavigator Docker image (tests run inside the build).
# Usage: ./build.sh [image-tag]    default tag: codenavigator:latest
set -eu
cd "$(dirname "$0")"
tag="${1:-codenavigator:latest}"
docker build -t "$tag" .
echo "Built $tag. Run: docker run --rm -p 4177:4177 $tag"
