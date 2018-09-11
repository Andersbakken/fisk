#ifndef CONFIG_H
#define CONFIG_H

#include <json11.hpp>
#include <string>
#include <cstdint>
#include <vector>

namespace Config
{
enum { Version = 5 };
bool init();
std::string scheduler();
unsigned long long schedulerConnectTimeout();
unsigned long long acquiredSlaveTimeout();
unsigned long long slaveConnectTimeout();
unsigned long long uploadJobTimeout();
unsigned long long responseTimeout();
std::string clientName();
std::string cacheDir();
size_t compileSlots();
size_t desiredCompileSlots();
size_t cppSlots();
std::string envCache();
bool watchdog();
std::string nodePath();
std::string hostname();
std::string name();
std::vector<std::string> compatibleHashes(const std::string &hash);
std::string logFile();
bool logFileAppend();
std::string logLevel();
bool discardComments();
}
#endif /* CONFIG_H */
