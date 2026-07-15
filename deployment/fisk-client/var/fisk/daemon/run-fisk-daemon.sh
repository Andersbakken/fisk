#!/bin/bash
# systemd owns the process lifecycle: Restart=always in fisk-daemon.service
# handles crashes/restarts, and each restart re-delivers the socket-activation
# fd with a fresh LISTEN_PID. This script must therefore be single-shot and
# END with `exec node` so node inherits bash's pid (== systemd's LISTEN_PID).
# Any loop, fork, or plain `node ...` here would break socket activation.
set -e

cd /var/fisk/daemon
sudo -H npm cache clear --force
sudo -H npm init --yes
sudo -H npm install --unsafe-perm @andersbakken/fisk@latest
cd /var/fisk/daemon/node_modules/@andersbakken/fisk/daemon
exec node ./fisk-daemon.js
