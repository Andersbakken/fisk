cmake_minimum_required(VERSION 3.5)
set(WSLAY_CONFIGURE_INSTALL NO)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++11 -Wformat -Wall")
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
add_subdirectory(wslay)
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install OFF CACHE INTERNAL "")
add_subdirectory(nlohmann_json)
add_subdirectory(tiny-process-library)

add_library(LUrlParser LUrlParser/LUrlParser.cpp)
target_include_directories(LUrlParser PUBLIC LUrlParser)

