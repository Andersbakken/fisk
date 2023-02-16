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
    Verbose,
    Debug,
    Warn,
    Error,
    Fatal,
    Silent
};
Level logLevel();
std::string logFileName();
enum LogFileMode {
    Overwrite,
    Append
};
void init(Level level, std::string &&logFile, LogFileMode mode);
void shutdown();
extern Level minLogLevel;
Level stringToLevel(const char *str, bool *ok);

enum Flag {
    None = 0x0,
    NoTrailingNewLine = 0x1
};

void log(Level level, const std::string &string, unsigned int flags = None);
void log(Level level, const char *fmt, va_list args);
void verbose(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void debug(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void warn(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void error(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));
void fatal(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));

#define VERBOSE(...)                            \
    if (Log::minLogLevel <= Log::Verbose)       \
        Log::verbose(__VA_ARGS__)
#define DEBUG(...)                              \
    if (Log::minLogLevel <= Log::Debug)         \
        Log::debug(__VA_ARGS__)
#define WARN(...)                               \
    if (Log::minLogLevel <= Log::Warn)          \
        Log::warn(__VA_ARGS__)
#define ERROR(...)                              \
    if (Log::minLogLevel <= Log::Error)         \
        Log::error(__VA_ARGS__)
#define FATAL(...)                              \
    if (Log::minLogLevel <= Log::Fatal)         \
        Log::fatal(__VA_ARGS__)

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
        return *this;
    }

    template <typename T>
    Stream &operator<<(const T &t)
    {
        if (mData)
            mData->stream << t;
        return *this;
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
        std::ostringstream stream;
        const Level level;
    };
    std::unique_ptr<Data> mData;
};
}

#endif /* LOG_H */
