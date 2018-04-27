#ifndef LOG_H
#define LOG_H

#include <sstream>
#include <cstdarg>
#include <string>
#include <stdio.h>
#include <memory>

namespace Log
{

enum Level {
    Debug,
    Info,
    Warning,
    Error
};
void log(Level level, const std::string &string);
void log(Level level, const char *fmt, va_list args);
void debug(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void info(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void warning(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void error(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));

class Stream
{
public:
    Stream(Level level)
        : mData(new Data(level))
    {
    }

    Stream(Stream &&other)
    {
        mData = std::move(other.mData);
    }

    Stream &operator=(Stream &&other)
    {
        mData = std::move(other.mData);
    }

    template <typename T>
    Stream &operator<<(const T &t)
    {
        if (mData)
            mData->stream << t;
    }
private:
    Stream(const Stream &) = delete;
    struct Data {
        Data(Level l)
            : level(l)
        {}
        ~Data()
        {
            const std::string str = stream.str();
            if (!str.empty()) {
                log(level, str);
            }
        }
        const Level level;
        std::ostringstream stream;
    };
    std::unique_ptr<Data> mData;
};
}

#endif /* LOG_H */
