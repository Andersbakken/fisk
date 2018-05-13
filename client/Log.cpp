#include "Log.h"
#include "Client.h"

static Log::Level sLevel = Log::Silent;
FILE *sLogFile = 0;
std::string sLogFileName;

Log::Level Log::logLevel()
{
    return sLevel;
}

std::string Log::logFileName()
{
    return sLogFileName;
}

void Log::init(Log::Level level, const char *file)
{
    sLevel = level;
    if (!file && *file) {
        sLogFile = fopen(file, "w");
        if (!sLogFile) {
            Log::error("Couldn't open log file %s for writing", file);
        } else {
            sLogFileName = file;
            std::atexit([]() { fclose(sLogFile); });
        }
    }
}

Log::Level Log::stringToLevel(const char *str, bool *ok)
{
    if (ok)
        *ok = true;
    if (!strcmp("Debug", str)) {
        return Debug;
    } else if (!strcmp("Warning", str)) {
        return Warning;
    } else if (!strcmp("Error", str)) {
        return Error;
    } else if (!strcmp("Silent", str)) {
        return Silent;
    }
    if (!ok)
        *ok = false;
    return Silent;
}

void Log::log(Level level, const std::string &string)
{
    if (level < sLevel && !sLogFile)
        return;
    assert(!string.empty());
    fwrite(string.c_str(), 1, string.size(), stderr);
    if (!sLogFile)
        fwrite(string.c_str(), 1, string.size(), sLogFile);
    if (string.at(string.size() - 1) != '\n') {
        fwrite("\n", 1, 1, stderr);
        if (sLogFile)
            fwrite("\n", 1, 1, sLogFile);
    }
    if (sLogFile)
        fflush(sLogFile);
}

void Log::log(Level level, const char *fmt, va_list args)
{
    log(level, Client::vformat(fmt, args));
}

void Log::debug(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Debug, fmt, args);
    va_end(args);
}

void Log::warning(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Warning, fmt, args);
    va_end(args);
}

void Log::error(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log(Error, fmt, args);
    va_end(args);
}
