#include "Log.h"
#include "Client.h"
#include <unistd.h>
#include <sys/file.h>
#include <sys/time.h>

static Log::Level sLevel = Log::Fatal;
static FILE *sLogFile = nullptr;
static Log::LogFileMode sLogFileMode = Log::Overwrite;
static const unsigned long long sPid = getpid();
static std::mutex sMutex;
static std::string sLogFileName;

namespace Log {
Level minLogLevel = Log::Silent;
}
Log::Level Log::logLevel()
{
    return sLevel;
}

std::string Log::logFileName()
{
    return sLogFileName;
}

void Log::init(Log::Level level, std::string &&file, LogFileMode mode)
{
    sLevel = level;
    sLogFileMode = mode;
    if (!file.empty() && sLogFileMode == Overwrite) {
        sLogFile = fopen(file.c_str(), "w");
        if (!sLogFile) {
            ERROR("Couldn't open log file %s for writing", file.c_str());
        } else {
            sLogFileName = std::move(file);
        }
    } else if (!file.empty()) {
        sLogFileName = std::move(file);
    }
    if (!sLogFileName.empty()) {
        minLogLevel = Debug;
    } else {
        minLogLevel = level;
    }
}

void Log::shutdown()
{
    if (sLogFile) {
        int ret;
        EINTRWRAP(ret, fclose(sLogFile));
        sLogFile = nullptr;
    }
}

Log::Level Log::stringToLevel(const char *str, bool *ok)
{
    if (ok)
        *ok = true;
    if (!strcasecmp("Verbose", str)) {
        return Verbose;
    } else if (!strcasecmp("Debug", str)) {
        return Debug;
    } else if (!strcasecmp("Warn", str)) {
        return Warn;
    } else if (!strcasecmp("Error", str)) {
        return Error;
    } else if (!strcasecmp("Fatal", str)) {
        return Fatal;
    } else if (!strcasecmp("Silent", str)) {
        return Silent;
    }
    if (!ok)
        *ok = false;
    return Silent;
}

static void logTime(FILE *f, unsigned long long elapsed)
{
    const time_t t = time(nullptr);
    struct tm *teeem = localtime(&t);
    char buf[256];
    // Oct 29 16:54:19
    strftime(buf, sizeof(buf), "%b %d %T", teeem);
    fprintf(f, "%s pid: %llu: elapsed: %llu.%03llu: ", buf, sPid, elapsed ? elapsed / 1000 : 0, elapsed % 1000);
}

static void writeWithPrefix(FILE *f, const std::string &string, bool addPrefix, unsigned long long elapsed)
{
    if (!addPrefix) {
        fwrite(string.c_str(), 1, string.size(), f);
        return;
    }

    size_t start = 0;
    size_t pos = 0;
    while (pos < string.size()) {
        if (string[pos] == '\n') {
            logTime(f, elapsed);
            fwrite(string.c_str() + start, 1, pos - start + 1, f);
            start = pos + 1;
        }
        pos++;
    }
    if (start < string.size()) {
        logTime(f, elapsed);
        fwrite(string.c_str() + start, 1, string.size() - start, f);
    }
}

void Log::log(Level level, const std::string &string, unsigned int flags)
{
    if (level < sLevel && !sLogFile)
        return;

    static FILE *f = Config::logStdOut ? stdout : stderr;
    std::unique_lock<std::mutex> lock(sMutex);
    assert(!string.empty());
    const unsigned long long elapsed = Client::mono() - Client::started;
    if (level >= sLevel) {
        writeWithPrefix(f, string, Config::logTimePrefix, elapsed);
    }
    int fd = -1;
    if (!sLogFileName.empty() && sLogFileMode == Append) {
        sLogFile = fopen(sLogFileName.c_str(), "a");
        fd = fileno(sLogFile);
        if (fd != -1) {
            flock(LOCK_EX, fd);
        }
    }

    if (sLogFile) {
        writeWithPrefix(sLogFile, string, Config::logTimePrefix, elapsed);
    }
    if (!(flags & NoTrailingNewLine) && string.at(string.size() - 1) != '\n') {
        if (level >= sLevel)
            fwrite("\n", 1, 1, f);
        if (sLogFile)
            fwrite("\n", 1, 1, sLogFile);
    }
    if (sLogFile) {
        fflush(sLogFile);
        if (fd != -1) {
            flock(LOCK_UN, fd);
            int ret;
            EINTRWRAP(ret, fclose(sLogFile));
            sLogFile = nullptr;
        }
    }
}

void Log::log(Level level, const char *fmt, va_list args)
{
    log(level, Client::vformat(fmt, args));
}

void Log::verbose(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Verbose, fmt, args);
    va_end(args);
}

void Log::debug(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Debug, fmt, args);
    va_end(args);
}

void Log::warn(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Warn, fmt, args);
    va_end(args);
}

void Log::error(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Error, fmt, args);
    va_end(args);
}

void Log::fatal(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Fatal, fmt, args);
    va_end(args);
}
