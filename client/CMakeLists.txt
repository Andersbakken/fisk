cmake_minimum_required(VERSION 3.0)
if (APPLE)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++11 -Wformat -Wall -Wshadow -Weverything -Wno-c++98-compat -Wno-switch-enum -Wno-c++98-compat-pedantic -Wno-padded -Wno-format-nonliteral -Wno-float-equal -Wno-reserved-id-macro -Wno-sign-conversion -Wno-global-constructors -Wno-exit-time-destructors -Wno-format-pedantic -Wno-old-style-cast")
else ()
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
endif ()
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS}")
set_source_files_properties(Client.cpp PROPERTIES COMPILE_FLAGS -Wno-unused-value)
set(OPENSSL_USE_STATIC_LIBS TRUE)
if (NOT OPENSSL_INCLUDE_DIR OR NOT OPENSSL_CRYPTO_LIBRARY)
    find_package(OpenSSL REQUIRED)
endif ()
add_custom_target(create-create-fisk-env ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-fisk-env DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-create-fisk-env.cmake COMMENT "Generating create-fisk-env.c")
add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/client/create-fisk-env.c
                   DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-fisk-env
                   DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-create-fisk-env.cmake
                   COMMAND ${CMAKE_COMMAND} -DINPUT="${CMAKE_CURRENT_LIST_DIR}/create-fisk-env" -DOUTPUT="${CMAKE_BINARY_DIR}/client/create-fisk-env.c" -DVARIABLE=create_fisk_env -P ${CMAKE_CURRENT_LIST_DIR}/create-create-fisk-env.cmake)

add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/client/npm-version.c
                   DEPENDS ${CMAKE_CURRENT_LIST_DIR}/../package.json
                   DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-npm-version.cmake
                   COMMAND ${CMAKE_COMMAND} -DOUTPUT="${CMAKE_BINARY_DIR}/client/npm-version.c" -P ${CMAKE_CURRENT_LIST_DIR}/create-npm-version.cmake)

message(STATUS "Found openssl includes ${OPENSSL_INCLUDE_DIR}")
include_directories(${OPENSSL_INCLUDE_DIR})
add_executable(fiskc
    ${CMAKE_BINARY_DIR}/client/create-fisk-env.c
    ${CMAKE_BINARY_DIR}/client/npm-version.c
    Client.cpp
    CompilerArgs.cpp
    Config.cpp
    DaemonSocket.cpp
    Log.cpp
    Preprocessed.cpp
    SchedulerWebSocket.cpp
    Select.cpp
    BuilderWebSocket.cpp
    Watchdog.cpp
    WebSocket.cpp
    main.cpp)
target_link_libraries(fiskc json11 pthread wslay ${OPENSSL_CRYPTO_LIBRARY} LUrlParser tiny-process-library dl zlib)

add_custom_target(link_c++ ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/c++)
add_custom_target(link_cc ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/cc)
if (APPLE)
    add_custom_target(link_clang++ ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/clang++)
    add_custom_target(link_clang ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/clang)
else ()
    add_custom_target(link_g++ ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/g++)
    add_custom_target(link_gcc ALL COMMAND ${CMAKE_COMMAND} -E create_symlink fiskc ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/gcc)
endif ()
