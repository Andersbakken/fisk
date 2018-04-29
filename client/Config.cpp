#include "Config.h"
#include "Log.h"
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <thread>

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
        if (read != size) {
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
        load(std::string(home) + "/.config/fisk.json");
    }
    load("/etc/fisk.json");
}

std::string Config::scheduler()
{
    json11::Json val = value("scheduler");
    if (val.is_string())
        return val.string_value();

    return "ws://localhost:8097/compile";
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
        val = value("local_slots_dir");
        if (val.is_string()) {
            *dir = val.string_value();
        } else if (const char *home = getenv("HOME")) {
            *dir = home + std::string("/.cache/fisk/slots");
        }
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
    json11::Json val = value("env_cache");
    if (val.is_string())
        return val.string_value();
    if (const char *home = getenv("HOME")) {
        return home + std::string("/.cache/fisk/env");
    }
    return std::string();
}

bool Config::watchdog()
{
    json11::Json val = value("watchdog");
    if (val.is_bool()) {
        return val.bool_value();
    }
    return true;
}
