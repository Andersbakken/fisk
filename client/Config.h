#ifndef CONFIG_H
#define CONFIG_H

#include <json11.hpp>
#include <string>
#include <vector>

class Config
{
public:
    Config();
    std::string scheduler() const;
    unsigned long long schedulerConnectTimeout();
    unsigned long long acquiredSlaveTimeout();
    unsigned long long slaveConnectTimeout();
    unsigned long long responseTimeout();
    std::string clientName() const;
private:
    json11::Json operator[](const std::string &value) const;
    std::vector<json11::Json> mJSON;
};
#endif /* CONFIG_H */
