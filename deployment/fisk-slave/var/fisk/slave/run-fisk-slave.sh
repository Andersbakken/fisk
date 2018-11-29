#!/bin/bash

PREFIX=`npm config get prefix`
while true; do
    npm cache clear --force --global
    npm install --unsafe-perm --global @andersbakken/fisk &> /var/log/fisk-slave.log
    cd "$PREFIX/lib/node_modules/@andersbakken/fisk/slave"
    node ./fisk-slave.js | logger --tag fisk-slave
done

