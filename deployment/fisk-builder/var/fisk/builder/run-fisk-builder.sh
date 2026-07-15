#!/bin/bash

SCRIPT_DIR=$(dirname "${BASH_SOURCE[0]}")
export PATH="$SCRIPT_DIR/node/bin:$PATH"

MODE=start
while [ -n "$1" ]; do
    case "$1" in
        --start)
            MODE="start"
            ;;
        --stop)
            MODE="stop"
            ;;
        *)
            >&2 echo "Unknown argument $1"
            exit 1
            ;;
    esac
    shift
done

function option()
{
    local OPT=$1
    local RET=$2
    local VAR=
    for FILE in $HOME/.config/fisk/builder.conf /etc/xdg/fisk/builder.conf.override /etc/xdg/fisk/builder.conf ; do
        [ ! -e $FILE ] && continue
        VAR=$(cat $FILE | jq ".\"$OPT\"")
        if [ -n "$VAR" ] && [ ! "$VAR" = "null" ]; then
            RET=$(echo $VAR | sed -e 's,^",,' -e 's,"$,,')
            break
        fi
    done
    echo $RET
}

[ -x "$HOME/.config/fisk/init-builder.sh" ] && "$HOME/.config/fisk/init-builder.sh"

if [ "`option object-cache-dir-ramdrive false`" == "true" ]; then
    RAMDRIVE="`option object-cache-dir`"
    umount $RAMDRIVE
    rm -rf $RAMDRIVE
    if [ $MODE = "start" ]; then
        mkdir -p "$RAMDRIVE"
        mount -t tmpfs -o size=13g fisk_ram_drive $RAMDRIVE
    fi
fi

[ $MODE = "stop" ] && exit 0

PREFIX=`npm config get prefix`
NPM_VERSION_FILE=`mktemp`
FORCE_INSTALL=
VERSION=
while true; do
    npm cache clear --force --global
    VERSION=`cat $NPM_VERSION_FILE 2>/dev/null`
    echo -n > $NPM_VERSION_FILE
    if [ ! -x "$PREFIX/lib/node_modules/@andersbakken/fisk/builder/fisk-builder.js" ] || [ -n "$FORCE_INSTALL" ]; then
        npm install --unsafe-perm --global @andersbakken/fisk${VERSION}
    fi
    node "$PREFIX/lib/node_modules/@andersbakken/fisk/builder/fisk-builder.js" --max_old_space_size=8192 --npm-version-file=$NPM_VERSION_FILE | logger --tag fisk-builder
    if [ "$PIPESTATUS[0]" != "0" ]; then
        FORCE_INSTALL=1
    else
        FORCE_INSTALL=
    fi
done

if [ -n "$RAMDRIVE" ]; then
    umount $RAMDRIVE
    rm -rf $RAMDRIVE
fi
