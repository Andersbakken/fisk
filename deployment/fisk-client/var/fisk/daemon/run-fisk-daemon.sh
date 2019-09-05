#!/bin/bash

cd /var/fisk/daemon

while true; do
    sudo -H npm cache clear --force
    sudo -H npm install --unsafe-perm @andersbakken/fisk &> /var/log/fisk-daemon.log
    pushd "$PWD/node_modules/@andersbakken/fisk/daemon"
    node ./fisk-daemon.js --debug
    popd
done
