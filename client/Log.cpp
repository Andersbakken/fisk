#include "Log.h"
#include "Client.h"

static Log::Level sLevel = Log::Error;
static FILE *sLogFile = 0;
static const unsigned long long sStart = Client::mono();
std::string sLogFileName;

Log::Level Log::logLevel()
{
    return sLevel;
}

std::string Log::logFileName()
{
    return sLogFileName;
}

void Log::init(Log::Level level, std::string &&file)
{
    sLevel = level;
    if (!file.empty()) {
        sLogFile = fopen(file.c_str(), "w");
        if (!sLogFile) {
            Log::error("Couldn't open log file %s for writing", file.c_str());
        } else {
            sLogFileName = std::move(file);
            std::atexit([]() { fclose(sLogFile); });
        }
    }
}

Log::Level Log::stringToLevel(const char *str, bool *ok)
{
    if (ok)
        *ok = true;
    if (!strcasecmp("Debug", str)) {
        return Debug;
    } else if (!strcasecmp("Warning", str)) {
        return Warning;
    } else if (!strcasecmp("Error", str)) {
        return Error;
    } else if (!strcasecmp("Silent", str)) {
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
    const unsigned long long elapsed = Client::mono() - sStart;
    fprintf(stderr, "%llu.%03llu: ", elapsed / 1000, elapsed % 1000);
    fwrite(string.c_str(), 1, string.size(), stderr);
    if (sLogFile) {
        fprintf(sLogFile, "%llu.%03llu: ", elapsed / 1000, elapsed % 1000);
        fwrite(string.c_str(), 1, string.size(), sLogFile);
    }
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
