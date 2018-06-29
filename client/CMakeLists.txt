cmake_minimum_required(VERSION 2.8)
include_directories(${CMAKE_CURRENT_LIST_DIR})
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++14 -Wformat -Wall")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS}")
set_source_files_properties(Client.cpp PROPERTIES COMPILE_FLAGS -Wno-unused-value)
set(OPENSSL_USE_STATIC_LIBS TRUE)
find_package(OpenSSL REQUIRED)
add_custom_target(create-create-fisk-env ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-fisk-env DEPENDS ${CMAKE_CURRENT_LIST_DIR}/create-create-fisk-env.cmake COMMENT "Generating create-fisk-env.c")
add_custom_command(OUTPUT create-fisk-env.c
                   DEPENDS create-fisk-env
                   COMMAND ${CMAKE_COMMAND} -DINPUT="${CMAKE_CURRENT_LIST_DIR}/create-fisk-env" -DOUTPUT="${CMAKE_BINARY_DIR}/client/create-fisk-env.c" -DVARIABLE=create_fisk_env  -P "${CMAKE_CURRENT_LIST_DIR}/create-create-fisk-env.cmake")

include_directories(${OPENSSL_INCLUDE_DIR})
add_executable(fiskc Client.cpp CompilerArgs.cpp Config.cpp Log.cpp Watchdog.cpp WebSocket.cpp main.cpp create-fisk-env.c)
add_dependencies(fiskc create-create-fisk-env)
target_link_libraries(fiskc json11 pthread wslay ${OPENSSL_CRYPTO_LIBRARY} LUrlParser tiny-process-library)
