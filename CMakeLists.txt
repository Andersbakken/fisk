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
add_subdirectory(src/client)

set(TS_DEPS
    .eslintrc
    builder/Client.ts
    builder/CompileFinishedEvent.ts
    builder/CompileJob.ts
    builder/J.ts
    builder/Job.ts
    builder/JobData.ts
    builder/ObjectCache.ts
    builder/ObjectCacheItem.ts
    builder/ObjectCachePendingItem.ts
    builder/Response.ts
    builder/Server.ts
    builder/VM.ts
    builder/VMMessage.ts
    builder/VM_runtime/Compile.ts
    builder/VM_runtime/ExitEvent.ts
    builder/VM_runtime/VM_runtime.ts
    builder/fisk-builder.ts
    builder/load.ts
    builder/quitOnError.ts
    common/BuilderAddedOrRemovedMessage.ts
    common/DropEnvironmentsMessage.ts
    common/FetchCacheObjectsMessage.ts
    common/JobMonitorMessage.ts
    common/ObjectCacheMessage.ts
    common/index.ts
    daemon/Client.ts
    daemon/ClientBuffer.ts
    daemon/Compile.ts
    daemon/Constants.ts
    daemon/Server.ts
    daemon/Slots.ts
    daemon/fisk-daemon.ts
    monitor/fisk-monitor.ts
    package-lock.json
    package.json
    prettier.config.js
    rollup.config.js
    scheduler/Builder.ts
    scheduler/CacheHitMessage.ts
    scheduler/Client.ts
    scheduler/Compile.ts
    scheduler/Database.ts
    scheduler/Environment.ts
    scheduler/Environments.ts
    scheduler/EnvironmentsMessage.ts
    scheduler/File.ts
    scheduler/JobAbortedMessage.ts
    scheduler/JobFinishedMessage.ts
    scheduler/JobScheduledMessage.ts
    scheduler/JobStartedMessage.ts
    scheduler/LinkProperties.ts
    scheduler/Links.ts
    scheduler/LoadMessage.ts
    scheduler/LogMessage.ts
    scheduler/MonitorMessage.ts
    scheduler/NodeData.ts
    scheduler/ObjectCacheAddedOrRemovedMessage.ts
    scheduler/ObjectCacheManager.ts
    scheduler/ObjectCacheManagerMessage.ts
    scheduler/ObjectCacheMessage.ts
    scheduler/Peak.ts
    scheduler/PeakData.ts
    scheduler/SHA1Data.ts
    scheduler/Server.ts
    scheduler/fisk-scheduler.ts
    scheduler/prettySize.ts
    scheduler/untarFile.ts
    tsconfig.json)


add_custom_command(
    OUTPUT ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-builder.js ${CMAKE_CURRENT_LIST_DIR}/dist/VM_runtime.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-scheduler.js
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/
    DEPENDS ${TS_DEPS}
    COMMENT "Building typescript"
    COMMAND npm run build)

add_custom_target(graph ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js)
