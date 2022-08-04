cmake_minimum_required(VERSION 3.0)
project(FISK)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
if (SANITIZE_ADDRESS)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=address")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=address")
endif ()
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -g")
set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} -g")

add_subdirectory(3rdparty)
add_subdirectory(client)

add_custom_command(
    OUTPUT ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-builder.js
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/
    COMMENT "Building typescript"
    COMMAND npm run build)

add_custom_target(graph ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js)
