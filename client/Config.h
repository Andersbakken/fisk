#ifndef CONFIG_H
#define CONFIG_H

#include <json11.hpp>
#include <string>
#include <cstdint>
#include <vector>

namespace Config
{
enum { Version = 2 };
void init();
std::string scheduler();
unsigned long long schedulerConnectTimeout();
unsigned long long acquiredSlaveTimeout();
unsigned long long slaveConnectTimeout();
unsigned long long responseTimeout();
std::string clientName();
std::string cacheDir();
size_t localSlots(std::string *dir = 0);
std::string envCache();
bool noLocal();
bool watchdog();
std::string node();
}
#endif /* CONFIG_H */
