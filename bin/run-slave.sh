#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $DIR/../slave
while true; do
    npm install --unsafe-perm -g @andersbakken/fisk &> /var/log/fisk-slave.log
    cd "$PWD"
    node ./index.js &>> /var/log/fisk-slave.log
done

