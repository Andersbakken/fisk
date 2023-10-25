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
    package-lock.json
    package.json
    prettier.config.js
    rollup.config.js
    src/builder/Client.ts
    src/builder/CompileFinishedEvent.ts
    src/builder/CompileJob.ts
    src/builder/J.ts
    src/builder/Job.ts
    src/builder/JobData.ts
    src/builder/ObjectCache.ts
    src/builder/ObjectCacheItem.ts
    src/builder/ObjectCachePendingItem.ts
    src/builder/Response.ts
    src/builder/Server.ts
    src/builder/VM.ts
    src/builder/VMMessage.ts
    src/builder/VM_runtime/Compile.ts
    src/builder/VM_runtime/ExitEvent.ts
    src/builder/VM_runtime/VM_runtime.ts
    src/builder/fisk-builder.ts
    src/builder/load.ts
    src/builder/quitOnError.ts
    src/clang-check/Options.ts
    src/clang-check/align.ts
    src/clang-check/clang-check.ts
    src/clang-check/matchContains.ts
    src/clang-check/matchExact.ts
    src/clang-check/matchRegex.ts
    src/clang-check/options.ts
    src/clang-check/parallelize.ts
    src/clang-check/post.ts
    src/clang-check/sha1.ts
    src/common/BuilderAddedOrRemovedMessage.ts
    src/common/DropEnvironmentsMessage.ts
    src/common/FetchCacheObjectsMessage.ts
    src/common/JobMonitorMessage.ts
    src/common/ObjectCacheMessage.ts
    src/common/index.ts
    src/daemon/Client.ts
    src/daemon/ClientBuffer.ts
    src/daemon/Compile.ts
    src/daemon/Constants.ts
    src/daemon/Server.ts
    src/daemon/Slots.ts
    src/daemon/fisk-daemon.ts
    src/monitor/fisk-monitor.ts
    src/scheduler/Builder.ts
    src/scheduler/CacheHitMessage.ts
    src/scheduler/Client.ts
    src/scheduler/Compile.ts
    src/scheduler/Database.ts
    src/scheduler/Environment.ts
    src/scheduler/Environments.ts
    src/scheduler/EnvironmentsMessage.ts
    src/scheduler/File.ts
    src/scheduler/JobAbortedMessage.ts
    src/scheduler/JobFinishedMessage.ts
    src/scheduler/JobScheduledMessage.ts
    src/scheduler/JobStartedMessage.ts
    src/scheduler/LinkProperties.ts
    src/scheduler/Links.ts
    src/scheduler/LoadMessage.ts
    src/scheduler/LogMessage.ts
    src/scheduler/MonitorMessage.ts
    src/scheduler/NodeData.ts
    src/scheduler/ObjectCacheAddedOrRemovedMessage.ts
    src/scheduler/ObjectCacheManager.ts
    src/scheduler/ObjectCacheManagerMessage.ts
    src/scheduler/ObjectCacheMessage.ts
    src/scheduler/Peak.ts
    src/scheduler/PeakData.ts
    src/scheduler/SHA1Data.ts
    src/scheduler/Server.ts
    src/scheduler/fisk-scheduler.ts
    src/scheduler/klung.ts
    src/scheduler/prettySize.ts
    src/scheduler/untarFile.ts
    tsconfig.json)

add_custom_command(
    OUTPUT ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-builder.js ${CMAKE_CURRENT_LIST_DIR}/dist/VM_runtime.js ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-scheduler.js
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/
    DEPENDS ${TS_DEPS}
    COMMENT "Building typescript"
    COMMAND npm run build)

add_custom_target(graph ALL DEPENDS ${CMAKE_CURRENT_LIST_DIR}/dist/fisk-daemon.js)
