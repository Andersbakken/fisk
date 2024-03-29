cmake_minimum_required(VERSION 3.0)
file(WRITE ${OUTPUT} "")
execute_process(COMMAND bash ${CMAKE_CURRENT_LIST_DIR}/npm-version.sh
    OUTPUT_VARIABLE VERSION
    ERROR_VARIABLE ERROR
    RESULT_VARIABLE RESULT
    OUTPUT_STRIP_TRAILING_WHITESPACE)
message(STATUS "NPM Version ${VERSION}")
file(APPEND ${OUTPUT} "const char *npm_version = \"${VERSION}\";\n")
