#include <errno.h>
#include <napi.h>
#include <pwd.h>
#include <string>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>

struct name_to_int_t {
    const char *name;
    int resource;
};

Napi::Value getpwname_func(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    Napi::HandleScope scope(env);

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::Error::New(env, "getpwnam: requires exactly 1 string argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    errno = 0; // reset errno before the call
    std::string pwnam = info[0].As<Napi::String>().Utf8Value();
    struct passwd *pwd = getpwnam(pwnam.c_str());
    if (errno) {
        char errbuf[256];
        snprintf(errbuf, sizeof(errbuf), "getpwnam: %s (%d)", strerror(errno), errno);
        Napi::Error::New(env, errbuf).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!pwd) {
        Napi::Error::New(env, "user id does not exist").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("name", pwd->pw_name);
    obj.Set("passwd", pwd->pw_passwd);
    obj.Set("uid", pwd->pw_uid);
    obj.Set("gid", pwd->pw_gid);
#ifdef __ANDROID__
    obj.Set("gecos", Napi::Null());
#else
    obj.Set("gecos", pwd->pw_gecos);
#endif
    obj.Set("shell", pwd->pw_shell);
    obj.Set("dir", pwd->pw_dir);

    return obj;
}

Napi::Value chroot_func(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::Error::New(env, "chroot: requires exactly 1 string argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string dir = info[0].As<Napi::String>().Utf8Value();
    if (chdir(dir.c_str())) {
        char errbuf[256];
        snprintf(errbuf, sizeof(errbuf), "chroot: chdir: %s (%d)", strerror(errno), errno);
        Napi::Error::New(env, errbuf).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (chroot(dir.c_str())) {
        char errbuf[256];
        snprintf(errbuf, sizeof(errbuf), "chroot: chroot: %s (%d)", strerror(errno), errno);
        Napi::Error::New(env, errbuf).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined();
}

Napi::Value setrlimit_func(const Napi::CallbackInfo &info)
{
    static const name_to_int_t rlimit_name_to_res[] = { { "core", RLIMIT_CORE },
                                                        { "cpu", RLIMIT_CPU },
                                                        { "data", RLIMIT_DATA },
                                                        { "fsize", RLIMIT_FSIZE },
                                                        { "nofile", RLIMIT_NOFILE },
#ifdef RLIMIT_NPROC
                                                        { "nproc", RLIMIT_NPROC },
#endif
                                                        { "stack", RLIMIT_STACK },
#ifdef RLIMIT_AS
                                                        { "as", RLIMIT_AS },
#endif
                                                        { 0, 0 } };

    Napi::Env env = info.Env();

    // Check the number of arguments
    if (info.Length() != 2) {
        Napi::TypeError::New(env, "setrlimit: requires exactly two arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Argument 0 should be a string (resource name)
    if (!info[0].IsString()) {
        Napi::TypeError::New(env, "setrlimit: argument 0 must be a string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Argument 1 should be an object (limits)
    if (!info[1].IsObject()) {
        Napi::TypeError::New(env, "setrlimit: argument 1 must be an object").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Convert the string (resource name) to UTF8
    Napi::String rlimitName = info[0].As<Napi::String>();
    std::string resourceName = rlimitName.Utf8Value();
    int resource = -1;
    for (const name_to_int_t *item = rlimit_name_to_res; item->name; ++item) {
        if (resourceName == item->name) {
            resource = item->resource;
            break;
        }
    }

    if (resource < 0) {
        Napi::Error::New(env, "setrlimit: unknown resource name").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Get the "soft" and "hard" limits from the object
    Napi::Object limitIn = info[1].As<Napi::Object>();
    Napi::String softKey = Napi::String::New(env, "soft");
    Napi::String hardKey = Napi::String::New(env, "hard");

    struct rlimit limit;
    bool getSoft = false, getHard = false;

    if (limitIn.Has(softKey)) {
        Napi::Value softValue = limitIn.Get(softKey);
        if (softValue.IsNull()) {
            limit.rlim_cur = RLIM_INFINITY;
        } else {
            limit.rlim_cur = softValue.As<Napi::Number>().Int32Value();
        }
    } else {
        getSoft = true;
    }

    if (limitIn.Has(hardKey)) {
        Napi::Value hardValue = limitIn.Get(hardKey);
        if (hardValue.IsNull()) {
            limit.rlim_max = RLIM_INFINITY;
        } else {
            limit.rlim_max = hardValue.As<Napi::Number>().Int32Value();
        }
    } else {
        getHard = true;
    }

    // Get current values if needed
    if (getSoft || getHard) {
        struct rlimit current;
        if (getrlimit(resource, &current)) {
            Napi::Error::New(env, strerror(errno)).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        if (getSoft) {
            limit.rlim_cur = current.rlim_cur;
        }
        if (getHard) {
            limit.rlim_max = current.rlim_max;
        }
    }

    // Set the resource limit
    if (setrlimit(resource, &limit)) {
        Napi::Error::New(env, strerror(errno)).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined(); // Return undefined
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("getpwnam", Napi::Function::New(env, getpwname_func));
    exports.Set("chroot", Napi::Function::New(env, chroot_func));
    exports.Set("setrlimit", Napi::Function::New(env, setrlimit_func));
    return exports;
}
