#include "SchedulerResponse.h"
#include "Log.h"
#include "Watchdog.h"

extern "C" const char *npm_version;

void SchedulerResponse::applyRaw(const std::string &raw)
{
    nlohmann::json msg = nlohmann::json::parse(raw, nullptr, false, true);
    if (msg.is_discarded() || !msg.is_object()) {
        ERROR("Failed to parse json from scheduler (raw message: %.200s%s)", raw.c_str(), raw.size() > 200 ? "..." : "");
        error = "scheduler json parse error";
        done = true;
        return;
    }
    apply(msg);
}

void SchedulerResponse::apply(const nlohmann::json &msg)
{
    DEBUG("Scheduler response: %s", msg.dump().c_str());
    Client::Data &data = Client::data();
    auto jstring = [](const nlohmann::json &v) -> std::string {
        return v.is_string() ? v.get<std::string>() : std::string();
    };

    const std::string schedulerError = msg.value("error", std::string());
    if (!schedulerError.empty()) {
        error = schedulerError;
        done = true;
        return;
    }

    const std::string t = msg.value("type", std::string());
    if (t == "needsEnvironment") {
        WARN("Scheduler needs environment %s to be uploaded", data.hash.c_str());
        needsEnvironment = true;
        done = true;
    } else if (t == "builder") {
        data.builderIp = msg.value("ip", std::string());
        data.builderHostname = msg.value("hostname", std::string());
        environment = msg.value("environment", std::string());
        const nlohmann::json &extraArgs = msg.value("extraArgs", nlohmann::json());
        if (extraArgs.is_array()) {
            extraArguments.reserve(extraArgs.size());
            for (const nlohmann::json &arg : extraArgs) {
                extraArguments.push_back(jstring(arg));
            }
        }
        data.builderPort = msg.value("port", 0);
        jobId = msg.value("id", -1);
        if (data.builderIp.empty() && data.builderHostname.empty()) {
            ERROR("Scheduler returned no builder for environment %s (source: %s). "
                  "No builders have a compatible environment available.",
                  data.hash.c_str(),
                  data.compilerArgs ? data.compilerArgs->sourceFile().c_str() : "unknown");
        } else if (!environment.empty() && environment != data.hash) {
            WARN("Scheduler assigned alternate environment %s (requested: %s) on builder %s:%d", environment.c_str(), data.hash.c_str(), data.builderHostname.empty() ? data.builderIp.c_str() : data.builderHostname.c_str(), data.builderPort);
        }
        DEBUG("Got builder %s:%d", data.builderIp.c_str(), data.builderPort);
        done = true;
    } else if (t == "version_mismatch") {
        FATAL("*** Fisk Version mismatch detected, client version: %s minimum client version required: %s. Please update your fisk "
              "client.",
              npm_version,
              msg.value("minimum_version", std::string()).c_str());
        _exit(108);
    } else if (t == "version_verified") {
        ERROR("Fisk Version verified, client version: %s minimum client version required: %s", npm_version, msg.value("minimum_version", std::string()).c_str());
        done = true;
    } else {
        ERROR("Unexpected message type from scheduler: '%s' (environment: %s, source: %s)", t.c_str(), data.hash.c_str(), data.compilerArgs ? data.compilerArgs->sourceFile().c_str() : "unknown");
    }
}
