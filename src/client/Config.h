#ifndef CONFIG_H
#define CONFIG_H

#include <assert.h>
#include <cstdint>
#include <limits>
#include <sstream>
#include <string>
#include <strings.h>
#include <type_traits>
#include <vector>
#include <functional>

#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wcovered-switch-default"
#endif

#include <nlohmann/json.hpp>

#ifdef __clang__
#pragma clang diagnostic pop
#endif

namespace Config {
enum
{
    Version = 5
};

bool init(int &argc, char **&argv);
void usage(FILE *f);

class GetterBase
{
public:
    GetterBase(const char *arg, const char *help);
    virtual ~GetterBase();

    std::string jsonKey() const
    {
        return mJsonKey;
    }

    std::string environmentVariable() const
    {
        return mEnvironmentVariable;
    }

    std::string commandLine() const
    {
        return mCommandLine;
    }

    bool isAmbiguous() const
    {
        return mAmbiguous;
    }

    virtual bool apply(const std::string &value) = 0;
    virtual bool apply(const nlohmann::json &input) = 0;
    virtual void flip() = 0;

    bool isBoolean() const
    {
        return !requiresArgument();
    }

    virtual bool requiresArgument() const = 0;
    virtual std::string toString() const = 0;

    const char *help() const
    {
        return mHelp;
    }

private:
    const char *mHelp;
    bool mDone { false };
    bool mAmbiguous { false };
    friend bool Config::init(int &argc, char **&argv);
    std::string mJsonKey, mEnvironmentVariable, mCommandLine;
};

class Separator : public GetterBase
{
public:
    Separator(const char *hlp = nullptr)
        : GetterBase(nullptr, hlp ? hlp : "")
    {
    }

    virtual ~Separator() override;

    virtual bool apply(const std::string &) override
    {
        return false;
    }

    virtual bool apply(const nlohmann::json &) override
    {
        return false;
    }

    virtual void flip() override
    {
        abort();
    }

    virtual bool requiresArgument() const override
    {
        return false;
    }

    virtual std::string toString() const override
    {
        return std::string();
    }
};

template <typename T>
T identity(const T &t)
{
    return t;
}

template <typename T>
class Getter : public GetterBase
{
public:
    Getter(const char *arg, const char *hlp, const T &defaultValue = T(), const std::function<T(const T &)> &getter = identity<T>)
        : GetterBase(arg, hlp)
        , mValue(defaultValue)
        , mGetter(getter)
    {
    }

    operator T() const
    {
        return mGetter(mValue);
    }

    virtual bool apply(const std::string &input) override
    {
        return applyValue(input, mValue);
    }

    virtual bool apply(const nlohmann::json &input) override
    {
        return applyJsonValue(input, mValue);
    }

    virtual bool requiresArgument() const override
    {
        return !std::is_same<T, bool>::value;
    }

    virtual std::string toString() const override
    {
        std::ostringstream str;
        str << std::boolalpha;
        if (std::is_same<T, std::string>::value)
            str << '"';
        str << static_cast<T>(*this);
        if (std::is_same<T, std::string>::value)
            str << '"';
        return str.str();
    }

    T get() const
    {
        return mGetter(mValue);
    }

    virtual void flip() override
    {
        assert(isBoolean());
        flip(mValue);
    }

private:
    template <typename TT>
    static void flip(TT &)
    {
        abort();
    }

    static void flip(bool &value)
    {
        value = !value;
    }

    static bool applyValue(const std::string &input, std::string &dest)
    {
        if (input.empty())
            return false;
        dest = input;
        return true;
    }

    static bool applyValue(const std::string &input, bool &dest)
    {
        if (input.empty()) {
            dest = true;
            return true;
        }
        if (!strcasecmp(input.c_str(), "true") || !strcasecmp(input.c_str(), "1") || !strcasecmp(input.c_str(), "on") || !strcasecmp(input.c_str(), "yes")) {
            dest = true;
        } else if (!strcasecmp(input.c_str(), "false") || !strcasecmp(input.c_str(), "0") || !strcasecmp(input.c_str(), "off") || !strcasecmp(input.c_str(), "no")) {
            dest = false;
        } else {
            return false;
        }
        return true;
    }

    template <typename Value>
    static bool applyValue(const std::string &input, Value &dest, typename std::enable_if<std::is_integral<Value>::value>::type * = nullptr,
                           typename std::enable_if<std::is_signed<Value>::value>::type * = nullptr)
    {
        if (input.empty())
            return false;
        char *end;
        const long long v = strtoll(input.c_str(), &end, 10);
        if (*end)
            return false;
        dest = static_cast<Value>(v);
        return true;
    }

    template <typename Value>
    static bool applyValue(const std::string &input, Value &dest, typename std::enable_if<std::is_integral<Value>::value>::type * = nullptr,
                           typename std::enable_if<!std::is_signed<Value>::value>::type * = nullptr)
    {
        if (input.empty())
            return false;
        char *end;
        const long long v = strtoll(input.c_str(), &end, 10);
        if (*end || v < 0)
            return false;
        dest = static_cast<Value>(v);
        return true;
    }

    static bool applyJsonValue(const nlohmann::json &input, std::string &dest)
    {
        if (input.is_string()) {
            dest = input.get<std::string>();
            return !dest.empty();
        }
        return false;
    }

    static bool applyJsonValue(const nlohmann::json &input, bool &dest)
    {
        if (input.is_boolean()) {
            dest = input.get<bool>();
            return true;
        }
        return false;
    }

    template <typename Value>
    static bool applyJsonValue(const nlohmann::json &input, Value &dest,
                               typename std::enable_if<std::is_integral<Value>::value>::type * = nullptr,
                               typename std::enable_if<std::is_signed<Value>::value>::type * = nullptr)
    {
        if (input.is_number_integer() || (input.is_number() && input.get<double>() == static_cast<double>(input.get<long long>()))) {
            dest = static_cast<Value>(input.get<long long>());
            return true;
        }
        return false;
    }

    template <typename Value>
    static bool applyJsonValue(const nlohmann::json &input, Value &dest,
                               typename std::enable_if<std::is_integral<Value>::value>::type * = nullptr,
                               typename std::enable_if<!std::is_signed<Value>::value>::type * = nullptr)
    {
        if (input.is_number_unsigned()) {
            dest = static_cast<Value>(input.get<unsigned long long>());
            return true;
        }
        if (input.is_number_integer()) {
            const long long v = input.get<long long>();
            if (v >= 0) {
                dest = static_cast<Value>(v);
                return true;
            }
        }
        return false;
    }

    T mValue;
    std::function<T(const T &)> mGetter;
};

extern Getter<std::string> scheduler;
extern Getter<std::string> socket;
extern Getter<bool> dumpSlots;
extern Getter<unsigned long long> daemonConnectTimeout;
extern Getter<unsigned long long> slotAcquisitionTimeout;
extern Getter<unsigned long long> schedulerConnectTimeout;
extern Getter<size_t> websocketConnectAttempts;
extern Getter<unsigned long long> websocketConnectBackoff;
extern Getter<unsigned long long> acquiredBuilderTimeout;
extern Getter<unsigned long long> builderConnectTimeout;
extern Getter<unsigned long long> preprocessTimeout;
extern Getter<unsigned long long> uploadJobTimeout;
extern Getter<unsigned long long> responseTimeout;
extern Getter<std::string> compiler;
extern Getter<std::string> cacheDir;
extern Getter<std::string> builder;
extern Getter<std::string> labels;
extern Getter<bool> color;
extern Getter<bool> jsonDiagnostics;
extern Getter<bool> jsonDiagnosticsRaw;
extern Getter<bool> objectCache;
extern Getter<std::string> objectCacheTag;
extern Getter<bool> storePreprocessedDataOnError;
extern Getter<bool> disabled;
extern Getter<int> priority;
extern Getter<bool> help;
extern Getter<bool> syncFileSystem;
extern Getter<bool> version;
extern Getter<bool> dumpSha1;
extern Getter<std::string> statisticsLog;

extern Getter<size_t> compileSlots;
extern Getter<size_t> cppSlots;
extern Getter<std::string> releaseCppSlotMode;
extern Getter<bool> watchdog;
extern Getter<bool> verify;
extern Getter<std::string> nodePath;
extern Getter<std::string> hostname;
extern Getter<std::string> name;
extern Getter<std::string> logFile;
extern Getter<bool> logFileAppend;
extern Getter<bool> logStdOut;
extern Getter<std::string> logLevel;
extern Getter<bool> logTimePrefix;
extern Getter<bool> verbose;
extern Getter<bool> debug;
extern Getter<bool> discardComments;
extern Getter<unsigned long long> delay;
extern Getter<bool> compress;
} // namespace Config
#endif /* CONFIG_H */
