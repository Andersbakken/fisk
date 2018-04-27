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
private:
    std::vector<json11::Json> mJSON;
};
#endif /* CONFIG_H */
