#!/bin/bash

COUNT=$1
[ -z "$1" ] && COUNT=1

echo "cmake_minimum_required(VERSION 3.0)" > CMakeLists.txt
echo "add_library(fisktest" >> CMakeLists.txt
for idx in `seq 1 $COUNT`; do
    echo "    ${idx}.cpp" >> CMakeLists.txt
    echo "int foo_${idx}() { return $idx; }" > "${idx}.cpp"
done
echo ")" >> CMakeLists.txt
