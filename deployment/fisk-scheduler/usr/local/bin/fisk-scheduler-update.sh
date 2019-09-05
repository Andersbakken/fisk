#!/bin/bash

if [ "`ps aux | grep run-fisk-scheduler.js | grep -v grep | grep -v \"\<env\>\" | wc -l `" != "1" ]; then
    ps aux | grep run-fisk-scheduler.js | grep -v grep
    echo "Couldn't find single pid for run-fisk-scheduler.js"
    exit 1
fi

PID=`ps aux | grep run-fisk-scheduler.js | grep -v grep | grep -v "\<env\>" | awk '{print $2}'`
echo "Telling fisk-scheduler to reload itself"
kill -SIGHUP $PID


