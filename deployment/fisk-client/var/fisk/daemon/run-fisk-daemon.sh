#!/bin/bash

cd /var/fisk/daemon

while true; do
    sudo -H npm cache clear --force
    sudo -H npm init --yes
    sudo -H npm install --unsafe-perm @andersbakken/fisk@latest
    pushd "$PWD/node_modules/@andersbakken/fisk/daemon"
    node ./fisk-daemon.js
    popd
done
