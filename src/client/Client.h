#ifndef CLIENT_H
#define CLIENT_H

#include <string>
#include <cstdarg>
#include <assert.h>

namespace Client {
std::string findCompiler(int argc, char **argv);
void parsePath(const char *path, std::string *basename, std::string *dirname);
[[ noreturn ]] void runLocal(const std::string &compiler, int argc, char **argv);
unsigned long long mono();

template <size_t StaticBufSize = 4096>
static std::string format(const char *format, va_list args)
{
    va_list copy;
    va_copy(copy, args);

    char buffer[StaticBufSize];
    const size_t size = ::vsnprintf(buffer, StaticBufSize, format, args);
    assert(size >= 0);
    std::string ret;
    if (size < StaticBufSize) {
        ret.assign(buffer, size);
    } else {
        ret.resize(size);
        ::vsnprintf(&ret[0], size+1, format, copy);
    }
    va_end(copy);
    return ret;
}
}

#endif /* CLIENT_H */
