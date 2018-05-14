#include "Config.h"
#include "Client.h"
#include "Log.h"
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <thread>
#include <arpa/inet.h>

static std::vector<json11::Json> sJSON;
static json11::Json value(const std::string &key)
{
    for (const json11::Json &json : sJSON) {
        const json11::Json &value = json[key];
        if (!value.is_null()) {
            return value;
        }
    }
    return json11::Json();
}

void Config::init()
{
    auto load = [](const std::string &path) {
        FILE *f = fopen(path.c_str(), "r");
        if (!f)
            return;
        fseek(f, 0, SEEK_END);
        const long size = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (!size) {
            fclose(f);
            return;
        }

        std::string contents(size, ' ');
        const size_t read = fread(&contents[0], 1, size, f);
        fclose(f);
        if (read != static_cast<size_t>(size)) {
            Log::error("Failed to read from file: %s (%d %s)", path.c_str(), errno, strerror(errno));
            return;
        }

        std::string err;
        json11::Json parsed = json11::Json::parse(contents, err, json11::JsonParse::COMMENTS);
        if (!err.empty()) {
            Log::error("Failed to parse json from %s: %s", path.c_str(), err.c_str());
            return;
        }
        sJSON.push_back(std::move(parsed));
    };
    if (const char *home = getenv("HOME")) {
        load(std::string(home) + "/.config/fisk/client.json");
    }
    load("/etc/fisk/client.json");

    const std::string dir = cacheDir();
    std::string versionFile = dir;
    if (!versionFile.empty()) {
        versionFile += "version";
        if (FILE *f = fopen(versionFile.c_str(), "r")) {
            uint32_t version;
            if (fread(&version, 1, sizeof(version) - 1, f) == 4) {
                if (htonl(version) == Version) {
                    fclose(f);
                    return;
                }
            }
            fclose(f);
        }
    }
    Client::recursiveRmdir(dir);
    Client::recursiveMkdir(dir);
    if (FILE *f = fopen(versionFile.c_str(), "w")) {
        const uint32_t version = htonl(Version);
        fwrite(&version, 1, sizeof(version), f);
        fclose(f);
    }
}

std::string Config::scheduler()
{
    json11::Json val = value("scheduler");
    if (val.is_string())
        return val.string_value();

    return "ws://localhost:8097";
}

unsigned long long Config::schedulerConnectTimeout()
{
    json11::Json val = value("scheduler_connect_timeout");
    if (val.is_number())
        return val.int_value();

    return 1000;
}

unsigned long long Config::acquiredSlaveTimeout()
{
    json11::Json val = value("acquired_slave_timeout");
    if (val.is_number())
        return val.int_value();

    return 1000;
}

unsigned long long Config::slaveConnectTimeout()
{
    json11::Json val = value("slave_connect_timeout");
    if (val.is_number())
        return val.int_value();

    return 1000;
}

unsigned long long Config::responseTimeout()
{
    json11::Json val = value("response_timeout");
    if (val.is_number())
        return val.int_value();

    return 20000;
}

std::string Config::clientName()
{
    json11::Json val = value("clientName");
    if (val.is_string())
        return val.string_value();

    char buf[1024];
    if (!gethostname(buf, sizeof(buf)))
        return buf;

    Log::error("Unable to retrieve client name %d %s", errno, strerror(errno));
    return "unknown";
}

std::string Config::cacheDir()
{
    json11::Json val = value("cache_dir");
    if (val.is_string()) {
        std::string ret = val.string_value();
        if (!ret.empty()) {
            if (ret[ret.size() - 1] != '/')
                ret += '/';
            return ret;
        }
    }
    if (const char *home = getenv("HOME")) {
        return home + std::string("/.cache/fisk/client/");
    }
    return std::string();
}

size_t Config::localSlots(std::string *dir)
{
    json11::Json val = value("local_slots");
    size_t ret;
    if (val.is_number()) {
        ret = val.int_value();
    } else {
        ret = std::thread::hardware_concurrency();
    }
    if (dir) {
        *dir = cacheDir() + "/slots";
    }
    return ret;
}

bool Config::noLocal()
{
    json11::Json val = value("no_local");
    if (val.is_bool()) {
        return val.bool_value();
    }
    return false;
}

std::string Config::envCache()
{
    std::string ret = cacheDir();
    if (!ret.empty())
        ret += "environment_cache.json";
    return ret;
}

bool Config::watchdog()
{
    json11::Json val = value("watchdog");
    if (val.is_bool()) {
        return val.bool_value();
    }
    return true;
}

std::string Config::nodePath()
{
    json11::Json val = value("node_path");
    if (val.is_string())
        return val.string_value();
    return "node";
}

std::string Config::hostname()
{
    json11::Json val = value("hostname");
    if (val.is_string())
        return val.string_value();
    return std::string();
}

std::string Config::name()
{
    json11::Json val = value("name");
    if (val.is_string())
        return val.string_value();
    std::string name = hostname();
    if (name.empty()) {
        name.resize(_POSIX_HOST_NAME_MAX + 1);
        ::gethostname(&name[0], name.size());
        name.resize(strlen(name.c_str()));
    }
    return name;
}

std::vector<std::string> Config::compatibleHashes(const std::string &hash)
{
    std::vector<std::string> ret;
    json11::Json val = value("compatible_hashes");
    if (val.is_object()) {
        const json11::Json &value = val[hash];
        if (value.is_string()) {
            ret.push_back(value.string_value());
        } else if (value.is_array()) {
            for (const json11::Json &array_val : value.array_items()) {
                ret.push_back(array_val.string_value());
            }
        }
    }
    return ret;
}

std::string Config::logFile()
{
    json11::Json val = value("log_file");
    if (val.is_string())
        return val.string_value();

    return std::string();
}

std::string Config::logLevel()
{
    json11::Json val = value("log_level");
    if (val.is_string())
        return val.string_value();

#ifdef NDEBUG
    return "silent";
#else
    return "warning";
#endif
}
