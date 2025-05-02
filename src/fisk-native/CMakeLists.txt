cmake_minimum_required(VERSION 3.15)
project(fisk-native)

set(CMAKE_CXX_STANDARD 17)

add_library(fisk-native SHARED fisk-native.cpp)

target_include_directories(fisk-native
    PRIVATE
    ../../node_modules/node-api-headers/include
    ../../node_modules/node-addon-api/)

set_target_properties(fisk-native
    PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
)
