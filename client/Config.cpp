#include "Config.h"
#include "Client.h"
#include "Log.h"
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <thread>
#include <arpa/inet.h>
#include <sys/types.h>
#include <sys/file.h>

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
            ERROR("Failed to read from file: %s (%d %s)", path.c_str(), errno, strerror(errno));
            return;
        }

        std::string err;
        json11::Json parsed = json11::Json::parse(contents, err, json11::JsonParse::COMMENTS);
        if (!err.empty()) {
            ERROR("Failed to parse json from %s: %s", path.c_str(), err.c_str());
            return;
        }
        sJSON.push_back(std::move(parsed));
    };
    if (const char *home = getenv("HOME")) {
        load(std::string(home) + "/.config/fisk/client.conf");
    }
    load("/etc/fisk/client.conf");

    const std::string dir = cacheDir();
    std::string versionFile = dir + "version";
    int fd = open(versionFile.c_str(), O_RDONLY|O_CLOEXEC);
    if (fd != -1) {
        flock(fd, LOCK_SH); // what if it fails?
        uint32_t version;
        if (read(fd, &version, sizeof(version)) == sizeof(version)) {
            flock(fd, LOCK_UN); // what if it fails?
            ::close(fd);
            if (version == htonl(Version)) {
                return;
            }
        }
    }
    Client::recursiveRmdir(dir);
    Client::recursiveMkdir(dir);

    fd = open(versionFile.c_str(), O_CREAT|O_RDWR|O_CLOEXEC, S_IRUSR|S_IWUSR|S_IRGRP|S_IWGRP|S_IROTH);
    if (fd != -1) {
        flock(fd, LOCK_EX); // what if it fails?
        const uint32_t version = htonl(Version);
        if (write(fd, &version, sizeof(version)) != sizeof(version)) {
            ERROR("Failed to log");
        }
        flock(fd, LOCK_UN);
        ::close(fd);
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
    json11::Json val = value("scheduler-connect-timeout");
    if (val.is_number())
        return val.int_value();

    return 1000;
}

unsigned long long Config::acquiredSlaveTimeout()
{
    json11::Json val = value("acquired-slave-timeout");
    if (val.is_number())
        return val.int_value();

    return 2000;
}

unsigned long long Config::slaveConnectTimeout()
{
    json11::Json val = value("slave-connect-timeout");
    if (val.is_number())
        return val.int_value();

    return 1000;
}

unsigned long long Config::uploadJobTimeout()
{
    json11::Json val = value("upload-job-timeout");
    if (val.is_number())
        return val.int_value();

    return 5000;
}

unsigned long long Config::responseTimeout()
{
    json11::Json val = value("response-timeout");
    if (val.is_number())
        return val.int_value();

    return 20000;
}

std::string Config::clientName()
{
    json11::Json val = value("client-name");
    if (val.is_string())
        return val.string_value();

    char buf[1024];
    if (!gethostname(buf, sizeof(buf)))
        return buf;

    ERROR("Unable to retrieve client name %d %s", errno, strerror(errno));
    return "unknown";
}

std::string Config::cacheDir()
{
    json11::Json val = value("cache-dir");
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

std::pair<size_t, size_t> Config::localSlots(std::string *dir)
{
    if (dir) {
        *dir = cacheDir() + "slots";
    }
    {
        json11::Json val = value("slots");
        if (val.is_number())
            return std::make_pair<size_t, size_t>(val.int_value(), val.int_value());
    }
    std::pair<size_t, size_t> ret = { std::thread::hardware_concurrency(), std::thread::hardware_concurrency() };
    {
        json11::Json val = value("desired-slots");
        if (val.is_number()) {
            ret.first = val.int_value();
        }
    }

    {
        json11::Json val = value("allowed-slots");
        if (val.is_number()) {
            ret.second = val.int_value();
        }
    }
    return ret;
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
    json11::Json val = value("node-path");
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
    json11::Json val = value("compatible-hashes");
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
    json11::Json val = value("log-file");
    if (val.is_string())
        return val.string_value();

    return std::string();
}

bool Config::logFileAppend()
{
    json11::Json val = value("log-file-append");
    if (val.is_bool()) {
        return val.bool_value();
    }
    return false;
}

std::string Config::logLevel()
{
    json11::Json val = value("log-level");
    if (val.is_string())
        return val.string_value();

#ifdef NDEBUG
    return "silent";
#else
    return "warn";
#endif
}
