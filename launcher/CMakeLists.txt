cmake_minimum_required(VERSION 3.25)
project(failureprism_launcher LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(${CMAKE_CURRENT_SOURCE_DIR}/../gateway/cmake/StaticRuntime.cmake)

add_executable(FailurePrism WIN32
    src/main.cpp
    src/resource.rc
    src/app.manifest
)

set_target_properties(FailurePrism PROPERTIES
    OUTPUT_NAME "FailurePrism"
)

target_include_directories(FailurePrism PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_definitions(FailurePrism PRIVATE
    UNICODE
    _UNICODE
)

target_link_libraries(FailurePrism PRIVATE
    ws2_32
    bcrypt
    advapi32
    shell32
    user32
    gdi32
    comdlg32
    comctl32
)

if(COMMAND apply_gateway_target_flags)
    apply_gateway_target_flags(FailurePrism)
endif()

add_custom_target(verify_launcher_imports
    COMMAND ${CMAKE_COMMAND} -DTARGET_FILE=$<TARGET_FILE:FailurePrism> -P ${CMAKE_CURRENT_SOURCE_DIR}/../gateway/cmake/VerifyImports.cmake
    DEPENDS FailurePrism
)
