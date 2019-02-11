#include "Log.h"
#include "Client.h"
#include <unistd.h>
#include <sys/file.h>

static Log::Level sLevel = Log::Error;
static FILE *sLogFile = nullptr;
static Log::LogFileMode sLogFileMode = Log::Overwrite;
static const unsigned long long sPid = getpid();
static std::mutex sMutex;
std::string sLogFileName;

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
        fclose(sLogFile);
        sLogFile = nullptr;
    }
}

Log::Level Log::stringToLevel(const char *str, bool *ok)
{
    if (ok)
        *ok = true;
    if (!strcasecmp("Debug", str)) {
        return Debug;
    } else if (!strcasecmp("Warn", str)) {
        return Warn;
    } else if (!strcasecmp("Error", str)) {
        return Error;
    } else if (!strcasecmp("Silent", str)) {
        return Silent;
    }
    if (!ok)
        *ok = false;
    return Silent;
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
        if (Config::logTimePrefix)
            fprintf(f, "%llu: %llu.%03llu: ", sPid, elapsed ? elapsed / 1000 : 0, elapsed % 1000);
        fwrite(string.c_str(), 1, string.size(), f);
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
        if (Config::logTimePrefix)
            fprintf(sLogFile, "%llu: %llu.%03llu: ", sPid, elapsed ? elapsed / 1000 : 0, elapsed % 1000);
        fwrite(string.c_str(), 1, string.size(), sLogFile);
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
            fclose(sLogFile);
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
