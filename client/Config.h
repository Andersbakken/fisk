#ifndef CONFIG_H
#define CONFIG_H

#include <json11.hpp>
#include <string>
#include <cstdint>
#include <vector>

class Config
{
public:
    Config();
    std::string scheduler() const;
    unsigned long long schedulerConnectTimeout() const;
    unsigned long long acquiredSlaveTimeout() const;
    unsigned long long slaveConnectTimeout() const;
    unsigned long long responseTimeout() const;
    std::string clientName() const;
    size_t localSlots(std::string *dir = 0) const;
private:
    json11::Json operator[](const std::string &value) const;
    std::vector<json11::Json> mJSON;
};
#endif /* CONFIG_H */
