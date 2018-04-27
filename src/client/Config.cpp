#include "Config.h"
#include "Log.h"
#include <errno.h>
#include <string.h>

Config::Config()
{
    auto load = [this](const std::string &path) {
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
        mJSON.push_back(std::move(parsed));
    };
    if (const char *home = getenv("HOME")) {
        load(std::string(home) + "/.config/fisk.json");
    }
    load("/etc/fisk.json");
}

std::string Config::scheduler() const
{
    for (const json11::Json &json : mJSON) {
        const json11::Json &value = json["scheduler"];
        if (value.is_string()) {
            return value.string_value();
        }
    }

    return "localhost:9999";
}
