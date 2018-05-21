#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $DIR/../slave
while true; do
    npm install --unsafe-perm -g dcfisk &> /var/log/dcfisk-slave.log
    cd "$PWD"
    node ./index.js &>> /var/log/dcfisk-slave.log
done

