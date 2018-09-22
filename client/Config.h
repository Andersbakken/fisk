#ifndef CONFIG_H
#define CONFIG_H

#include <json11.hpp>
#include <string>
#include <cstdint>
#include <vector>

#include <functional>

namespace Config {
class GetterBase
{
public:
    GetterBase(const char *arg);
    virtual ~GetterBase();
    enum Mode {
        JSON,
        EnvironmentVariable,
        CommandLine
    };
    bool match(Mode mode, const char *arg);
private:
    std::string mJsonKey, mEnvironmentVariable, mCommandLine;
};

template <typename T>
class Getter : public GetterBase
{
public:
    Getter(const char *arg, const T &defaultValue = T())
        : GetterBase(arg), value(defaultValue)
    {}
    T operator()() const { return value; }
private:
    T value;
};

enum { Version = 5 };
bool init(int &argc, char **&argv);
extern Getter<std::string> schedulerFoo;
std::string scheduler();
unsigned long long schedulerConnectTimeout();
unsigned long long acquiredSlaveTimeout();
unsigned long long slaveConnectTimeout();
unsigned long long preprocessTimeout();
unsigned long long uploadJobTimeout();
unsigned long long responseTimeout();
std::string cacheDir();
size_t compileSlots();
size_t desiredCompileSlots();
size_t cppSlots();
std::string envCache();
bool watchdog();
std::string nodePath();
std::string hostname();
std::string name();
std::string logFile();
bool logFileAppend();
std::string logLevel();
bool discardComments();
}
#endif /* CONFIG_H */
