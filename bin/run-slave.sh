#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
while true; do
    cd /
    npm cache clear --force
    npm install --unsafe-perm -g @andersbakken/fisk &> /var/log/fisk-slave.log
    cd $DIR/../slave
    node ./fisk-slave.js &>> /var/log/fisk-slave.log
done

