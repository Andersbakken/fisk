#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
grep '"version":' "$SCRIPT_DIR/../../package.json" | awk -F'"' '{print $4}'
