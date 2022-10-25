cmake_minimum_required(VERSION 3.0)
set(WSLAY_CONFIGURE_INSTALL NO)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++11 -Wformat -Wall")
add_subdirectory(wslay)
add_subdirectory(json11)
add_subdirectory(tiny-process-library)

add_library(LUrlParser LUrlParser/LUrlParser.cpp)
target_include_directories(LUrlParser PUBLIC LUrlParser)

