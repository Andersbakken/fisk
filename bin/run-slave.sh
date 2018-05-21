#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $DIR/../slave
while true; do
    npm install --unsafe-perm -g dcfisk > log
    node ./index.js >> log
done

