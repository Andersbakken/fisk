#include "SchedulerWebSocket.h"

void SchedulerWebSocket::onConnected()
{
    Client::data().watchdog->transition(Watchdog::ConnectedToScheduler);
}

void SchedulerWebSocket::onMessage(MessageType type, const void *bytes, size_t len)
{
    if (type == WebSocket::Text) {
        Client::Data &data = Client::data();
        const std::string rawMsg(reinterpret_cast<const char *>(bytes), len);
        nlohmann::json msg = nlohmann::json::parse(rawMsg, nullptr, false, true);
        if (msg.is_discarded() || !msg.is_object()) {
            ERROR("Failed to parse json from scheduler (raw message: %.200s%s)", rawMsg.c_str(), rawMsg.size() > 200 ? "..." : "");
            data.watchdog->stop();
            setError("scheduler json parse error");
            done = true;
            return;
        }
        auto jstring = [](const nlohmann::json &v) -> std::string {
            return v.is_string() ? v.get<std::string>() : std::string();
        };
        auto jint = [](const nlohmann::json &v) -> int {
            return v.is_number() ? v.get<int>() : 0;
        };
        const std::string t = jstring(msg["type"]);
        if (t == "needsEnvironment") {
            WARN("Scheduler needs environment %s to be uploaded", data.hash.c_str());
            needsEnvironment = true;
            done = true;
        } else if (t == "builder") {
            data.builderIp = jstring(msg["ip"]);
            Client::data().builderHostname = jstring(msg["hostname"]);
            environment = jstring(msg["environment"]);
            const nlohmann::json &extraArgs = msg["extraArgs"];
            if (extraArgs.is_array()) {
                extraArguments.reserve(extraArgs.size());
                for (const nlohmann::json &arg : extraArgs) {
                    extraArguments.push_back(jstring(arg));
                }
            }
            data.builderPort = static_cast<uint16_t>(jint(msg["port"]));
            jobId = jint(msg["id"]);
            if (data.builderIp.empty() && data.builderHostname.empty()) {
                ERROR("Scheduler returned no builder for environment %s (source: %s). "
                      "No builders have a compatible environment available.",
                      data.hash.c_str(),
                      data.compilerArgs ? data.compilerArgs->sourceFile().c_str() : "unknown");
            } else if (!environment.empty() && environment != data.hash) {
                WARN("Scheduler assigned alternate environment %s (requested: %s) on builder %s:%d", environment.c_str(), data.hash.c_str(), data.builderHostname.empty() ? data.builderIp.c_str() : data.builderHostname.c_str(), data.builderPort);
            }
            DEBUG("type %d", static_cast<int>(msg["port"].type()));
            DEBUG("Got here %s:%d", data.builderIp.c_str(), data.builderPort);
            done = true;
        } else if (t == "version_mismatch") {
            FATAL("*** Fisk Version mismatch detected, client version: %s minimum client version required: %s. Please update your fisk "
                  "client.",
                  npm_version,
                  jstring(msg["minimum_version"]).c_str());
            _exit(108);
        } else if (t == "version_verified") {
            ERROR("Fisk Version verified, client version: %s minimum client version required: %s", npm_version, jstring(msg["minimum_version"]).c_str());
            done = true;
        } else {
            ERROR("Unexpected message type from scheduler: '%s' (environment: %s, source: %s)", t.c_str(), data.hash.c_str(), data.compilerArgs ? data.compilerArgs->sourceFile().c_str() : "unknown");
        }
        // } else {
        //     printf("Got binary message: %zu bytes\n", len);
    }
}

bool SchedulerWebSocket::connectFinished()
{
    return done;
}
