cmake_minimum_required(VERSION 3.0)
project(FISK)
if (SANITIZE_ADDRESS)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=address")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=address")
endif ()
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -g")
set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} -g")

add_subdirectory(3rdparty)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
add_subdirectory(client)

set(TS_DEPS
    scripts/hack-posix-rollup.js
    common-ts/index.ts
    scheduler/Database.ts
    scheduler/Environments.ts
    scheduler/ObjectCacheManagerMessage.ts
    scheduler/Peak.ts
    scheduler/CacheHitMessage.ts
    scheduler/File.ts
    scheduler/ObjectCacheManager.ts
    scheduler/ObjectCacheMessage.ts
    scheduler/Builder.ts
    scheduler/EnvironmentsMessage.ts
    scheduler/JobAbortedMessage.ts
    scheduler/Server.ts
    scheduler/Compile.ts
    scheduler/MonitorMessage.ts
    scheduler/untarFile.ts
    scheduler/LoadMessage.ts
    scheduler/JobScheduledMessage.ts
    scheduler/LogMessage.ts
    scheduler/SHA1Data.ts
    scheduler/NodeData.ts
    scheduler/ObjectCacheAddedOrRemovedMessage.ts
    scheduler/PeakData.ts
    scheduler/JobFinishedMessage.ts
    scheduler/Client.ts
    scheduler/Environment.ts
    scheduler/prettySize.ts
    scheduler/JobStartedMessage.ts
    scheduler/Links.ts
    scheduler/fisk-scheduler.ts
    scheduler/LinkProperties.ts
    daemon/ClientBuffer.ts
    daemon/Server.ts
    daemon/Compile.ts
    daemon/Client.ts
    daemon/Constants.ts
    daemon/Slots.ts
    daemon/fisk-daemon.ts
    common/FetchCacheObjectsMessage.ts
    common/DropEnvironmentsMessage.ts
    common/ObjectCacheMessage.ts
    builder/ObjectCache.ts
    builder/JobData.ts
    builder/fisk-builder.ts
    builder/load.ts
    builder/Response.ts
    builder/Server.ts
    builder/CompileJob.ts
    builder/Job.ts
    builder/quitOnError.ts
    builder/VM.ts
    builder/VM_runtime/VM_runtime.ts
    builder/VM_runtime/Compile.ts
    builder/VM_runtime/ExitEvent.ts
    builder/J.ts
    builder/CompileFinishedEvent.ts
    builder/VMMessage.ts
    builder/Client.ts
    builder/ObjectCacheItem.ts
    builder/ObjectCachePendingItem.ts
    package.json
    package-lock.json
    rollup.config.js
    tsconfig.json
    prettier.config.js
    .eslintrc)


add_custom_command(
    OUTPUT ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-builder.js ${CMAKE_CURRENT_LIST_DIR}/dist/VM_runtime.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-scheduler.js
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/
    DEPENDS ${TS_DEPS}
    COMMENT "Building typescript"
    COMMAND npm run build)

add_custom_target(graph ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js)
