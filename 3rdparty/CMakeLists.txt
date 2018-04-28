cmake_minimum_required(VERSION 2.8)
set(WSLAY_CONFIGURE_INSTALL NO)
add_subdirectory(wslay)
add_subdirectory(json11)
add_subdirectory(tiny-process-library)

add_library(LUrlParser LUrlParser/LUrlParser.cpp)
target_include_directories(LUrlParser PUBLIC LUrlParser)

