#include "Client.h"
#include <unistd.h>
#include "SchedulerWebSocket.h"
#include "DaemonSocket.h"
#include "Preprocessed.h"
#include "Select.h"
#include "Config.h"
#include <unistd.h>
#include <climits>
#include <cstdlib>
#include <string.h>
#include <sys/file.h>
#include <dirent.h>
#include <algorithm>
#ifdef __linux__
#include <sys/inotify.h>
#endif
#include <sys/types.h>
#include <sys/wait.h>
#include <process.hpp>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#endif

#define ZLIB_CONST
#include <zlib.h>

#ifdef __APPLE__
static const char *systemName = "Darwin x86_64";
#elif defined(__linux__) && (defined(__i686) || defined(__i386))
static const char *systemName = "Linux i686"
#elif defined(__linux__) && defined(__x86_64)
static const char *systemName = "Linux x86_64";
#else
#error unsupported platform
#endif

Client::Data::Data()
{
#if OPENSSL_VERSION_NUMBER >= 0x10100000L
    sha1Context = EVP_MD_CTX_new();
    EVP_MD_CTX_init(sha1Context);
    const EVP_MD *hashptr = EVP_get_digestbyname("SHA1");
    EVP_DigestInit_ex(sha1Context, hashptr, nullptr);
#else
    SHA1_Init(&sha1);
#endif
}
Client::Data::~Data()
{
#if OPENSSL_VERSION_NUMBER >= 0x10100000L
    EVP_MD_CTX_free(sha1Context);
#endif
}

static Client::Data sData;
const unsigned long long Client::started = Client::mono();
const unsigned long long Client::milliseconds_since_epoch = std::chrono::system_clock::now().time_since_epoch() / std::chrono::milliseconds(1);
Client::Data &Client::data()
{
    return sData;
}

std::string Client::Data::CachedFile::line(size_t l)
{
    while (lines.size() < l && parsedIdx < contents.size()) {
        assert(parsedIdx == 0 || contents[parsedIdx - 1] == '\n');
        size_t newline = contents.find('\n', parsedIdx);
        std::string line;
        if (newline == std::string::npos) {
            line = contents.substr(parsedIdx);
            parsedIdx = newline = contents.size();
        } else {
            line = contents.substr(parsedIdx, newline - parsedIdx);
            parsedIdx = newline + 1;
        }
        // printf("Adding line %lu - %s\n", lines.size() + 1, line.c_str());
        lines.push_back(std::move(line));
    }
    assert(l > 0);
    --l; // 0 indexed here, 1-indexed in the diagnostics
    return l < lines.size() ? lines[l] : std::string();
}

static std::mutex sMutex;
std::mutex &Client::mutex()
{
    return sMutex;
}

enum CheckResult {
    Stop,
    Continue
};

namespace {
enum class Color {
    None,
    Red,
    Purple
};
std::string colorize(const std::string &str, Color color,
                     size_t start = 0, size_t length = std::string::npos)
{
    if (color == Color::None || !Config::color)
        return str;
    if (length == std::string::npos)
        length = str.size() - start;
    return (str.substr(0, start)
            + (color == Color::Red ? "\033[1;31m" : "\033[1;35m")
            + str.substr(start, length)
            + "\033[0m"
            + str.substr(start + length));
}

const std::string lineFromFile(const std::string &file, int line)
{
    const bool exists = Client::data().fileCache.find(file) != Client::data().fileCache.end();
    Client::Data::CachedFile &ref = Client::data().fileCache[file];
    if (!exists) {
        Client::readFile(file, ref.contents);
    }
    return ref.line(line);
}

json11::Json resolve(json11::Json value, const std::vector<std::string> &children)
{
    for (size_t i=0; i<children.size(); ++i) {
        if (value.is_object()) {
            value = value[children[i]];
        } else {
            value = json11::Json();
            break;
        }
    }
    return value;
}

std::string string(json11::Json value, const std::vector<std::string> &children)
{
    value = resolve(value, children);
    if (value.is_string())
        return value.string_value();
    return std::string();
}

std::string string(const json11::Json &value, const std::string &child = std::string())
{
    return string(value, Client::split(child, "."));
}

int integer(json11::Json value, const std::vector<std::string> &children)
{
    value = resolve(value, children);
    if (value.is_number())
        return value.number_value();
    return 0;
}

int integer(const json11::Json &value, const std::string &child = std::string())
{
    return integer(value, Client::split(child, "."));
}

void filter(const std::string &needle, std::string &output)
{
    size_t i=0;
    while ((i = output.find(needle, i)) != std::string::npos) {
        if (!i || output[i - 1] == '\n') {
            size_t endLine = output.find("\n", i);
            if (endLine == std::string::npos) {
                output.erase(i);
            } else {
                output.erase(i, endLine - i + 1);
            }
        } else {
            ++i;
        }
    }
}

void filter(std::string &output)
{
    filter("COLLECT_", output);
    filter("InstalledDir: ", output);
    filter("Found candidate GCC installation: ", output);
    filter("Selected GCC installation: ", output);
}

std::string resolveSymlink(const std::string &link, const std::function<CheckResult(const std::string &)> &check)
{
    errno = 0;
    std::string l = link;
    while (true) {
        char buf[PATH_MAX + 1];
        const ssize_t ret = readlink(l.c_str(), buf, PATH_MAX);
        // printf("resolved %s to %s -> %zd %d %s\n", l.c_str(), ret > 0 ? std::string(buf, ret).c_str() : "<nut>", ret, errno, strerror(errno));
        if (ret == -1) {
            if (errno != EINVAL) {
                ERROR("Failed to resolve symlink %s (%d %s)", link.c_str(), errno, strerror(errno));
            }
            break;
        }
        if (buf[0] != '/') {
            std::string dirname;
            Client::parsePath(l, nullptr, &dirname);
            if (!dirname.empty() && dirname[dirname.size() - 1] != '/')
                dirname += '/';
            l = dirname + std::string(buf, ret);
        } else {
            l.assign(buf, ret);
        }
        if (check(l) == Stop) {
            break;
        }
    }
    return l;
}

Client::CompilerInfo createCompilerInfo(const std::string &exec, const std::string &version)
{
    Client::CompilerInfo info {};
    info.hash = Client::toHex(Client::sha1(version));
    size_t idx = std::string::npos;
    if (exec.find("clang") != std::string::npos
        || exec.find("CLANG") != std::string::npos
        || exec.find("Clang") != std::string::npos
        || version.find("clang") != std::string::npos
        || version.find("CLANG") != std::string::npos
        || version.find("Clang") != std::string::npos) {
        info.type = Client::CompilerType::Clang;
        idx = version.find("clang version ");
    } else if (exec.find("gcc") != std::string::npos
               || exec.find("GCC") != std::string::npos
               || version.find("gcc") != std::string::npos
               || version.find("GCC") != std::string::npos) {
        info.type = Client::CompilerType::GCC;
        idx = version.find("gcc version ");
    }

    if (idx != std::string::npos) {
        while (idx != version.size() && !std::isdigit(version[idx])) {
            ++idx;
        }
        const char *str = version.c_str() + idx;
        char *endPtr;
        info.version.major = static_cast<int>(strtoul(str, &endPtr, 10));
        if (*endPtr == '.') {
            str = endPtr + 1;
            info.version.minor = static_cast<int>(strtoul(str, &endPtr, 10));
            if (*endPtr == '.') {
                str = endPtr + 1;
                info.version.patch = static_cast<int>(strtoul(str, &endPtr, 10));
            }
        }
    }
    return info;
}
} // anonymous namespace

std::string Client::findInPath(const std::string &fn)
{
    assert(!fn.empty());
    assert(fn[0] != '/');
    const char *path = getenv("PATH");
    if (!path)
        return std::string();

    const char *begin = path, *end = nullptr;
    std::string exec;
    do {
        end = strchr(begin, ':');
        if (!end) {
            exec = begin;
        } else {
            exec.assign(begin, end - begin);
            begin = end + 1;
        }
        if (!exec.empty()) {
            if (exec[exec.size() - 1] != '/')
                exec += '/';
            exec += fn;
            if (!access(exec.c_str(), X_OK)) {
                std::string resolved = Client::realpath(exec);
                std::string basename;
                Client::parsePath(resolved, nullptr, &basename);
                if (basename != "fiskc") {
                    if (fileType(exec) == Symlink) {
                        char link[PATH_MAX + 1];
                        const ssize_t len = readlink(exec.c_str(), link, sizeof(link) - 1);
                        if (len < 0) {
                            ERROR("Can't follow symlink: %s (%d %s)", exec.c_str(), errno, strerror(errno));
                            exec.clear();
                            continue;
                        }
                        link[len] = '\0';
                        std::string linkedFile;
                        parsePath(link, &linkedFile, nullptr);
                        if (linkedFile == "icecc" || linkedFile == "fiskc") {
                            exec.clear();
                            continue;
                        }
                    }

                    break;
                }
            }
            exec.clear();
        }
    } while (end);
    return exec;
}

bool Client::findCompiler(const std::string &preresolved)
{
    Client::Data &data = Client::data();

    // printf("PATH %s\n", path);
    std::string exec;
    if (preresolved.empty()) {
        std::string fn;
        parsePath(data.argv[0], &fn, nullptr);
        exec = findInPath(fn);
    } else if (preresolved[0] != '/') {
        exec = findInPath(preresolved);
    } else {
        exec = preresolved;
    }

    if (exec.empty())
        return false;

    std::string base;
    parsePath(exec, &base, nullptr);
    if (base.find("g++") != std::string::npos || base.find("gcc") != std::string::npos) {
        data.resolvedCompiler = exec;
    } else {
        resolveSymlink(exec, [&data](const std::string &p) -> CheckResult {
            std::string b;
            parsePath(p, &b, nullptr);
            // Log::debug("GOT BASE %s", base.c_str());
            if (b.find("g++") != std::string::npos || b.find("gcc") != std::string::npos) {
                data.resolvedCompiler = p;
                return Stop;
            }
            return Continue;
        });
    }
    if (data.resolvedCompiler.empty())
        data.resolvedCompiler = exec;
    {
        auto findBuilderCompiler = [&data](const std::string &path) {
            size_t slash = path.rfind('/');
            if (slash == std::string::npos)
                slash = 0;
            const char *ch = &path[slash];
            while (*ch) {
                if (*ch == 'g') {
                    if (!strncmp(ch + 1, "++", 2)) {
                        data.builderCompiler =  "/usr/bin/g++";
                        return true;
                    } else if (!strncmp(ch + 1, "cc", 2)) {
                        data.builderCompiler =  "/usr/bin/gcc";
                        return true;
                    }
                } else if (*ch == 'c') {
                    if (!strncmp(ch + 1, "lang", 4)) {
                        if (!strncmp(ch + 5, "++", 2)) {
                            data.builderCompiler =  "/usr/bin/clang++";
                            return true;
                        } else {
                            data.builderCompiler =  "/usr/bin/clang";
                            return true;
                        }
                    }
                }
                ++ch;
            }
            return false;
        };
        if (!findBuilderCompiler(exec)
            && !findBuilderCompiler(data.resolvedCompiler)
            && !findBuilderCompiler(Client::realpath(exec))
            && !findBuilderCompiler(Client::realpath(data.resolvedCompiler))) {
            if (exec.find("++") != std::string::npos) {
                findBuilderCompiler("g++");
            } else {
                findBuilderCompiler("gcc");
            }
        }
    }
    {
        const size_t slash = data.resolvedCompiler.rfind('/');
        if (slash != std::string::npos) {
            for (size_t i=slash + 2; i<data.resolvedCompiler.size(); ++i) {
                if (data.resolvedCompiler[i] == '+' && data.resolvedCompiler[i - 1] == '+') {
                    if (data.resolvedCompiler[i - 2] == 'c') {
                        data.resolvedCompiler[i - 1] = 'c';
                        data.resolvedCompiler.erase(i);
                    } else if (data.resolvedCompiler[i - 2] == 'g') {
                        if (i > 6 && !strncmp(data.resolvedCompiler.c_str() + i - 6, "clang", 5)) {
                            data.resolvedCompiler.erase(data.resolvedCompiler.begin() + i - 1, data.resolvedCompiler.begin() + i + 1);
                        } else {
                            data.resolvedCompiler[i - 1] = 'c';
                            data.resolvedCompiler[i] = 'c';
                        }
                    }
                }
            }
        }
    }
    // printf("RESULT %s %s %s\n", data.resolvedCompiler.c_str(), data.builderCompiler.c_str(), exec.c_str());

    if (exec.size() >= 5 && !strcmp(exec.c_str() + exec.size() - 5, "fiskc")) { // resolved to ourselves
        // printf("WE'RE HERE %s %s %s\n", exec.c_str(), data.builderCompiler.c_str(), data.resolvedCompiler.c_str());
        data.builderCompiler.clear();
        data.resolvedCompiler.clear();
        return false;
    }
    data.compiler = std::move(exec);
    struct stat st;
    return !stat(data.compiler.c_str(), &st) && (S_ISREG(st.st_mode) || S_ISLNK(st.st_mode));
}

void Client::parsePath(const char *path, std::string *basename, std::string *dirname)
{
    size_t lastSlash = std::string::npos;
    for (size_t i=0; i<PATH_MAX && path[i]; ++i) {
        if (path[i] == '/' && path[i + 1])
            lastSlash = i;
    }
    if (basename) {
        *basename = lastSlash == std::string::npos ? path : path + lastSlash + 1;
    }
    if (dirname) {
        *dirname = lastSlash == std::string::npos ? std::string(".") : std::string(path, lastSlash + 1);
    }
}

const char *Client::trimSourceRoot(const std::string &str, size_t *len)
{
    const char *cstr = str.c_str();
    char buf[PATH_MAX];
    // strcpy
    size_t idx = 0;
    struct stat st;
    static const char *files[] = {
        ".git",
        "CMakeLists.txt",
        "configure"
    };
    while (true) {
        const size_t tmp = str.find('/', idx) + 1;
        if (!tmp)
            break;
        memcpy(buf + idx, cstr + idx, tmp - idx);
        for (const char *file : files) {
            strncpy(buf + tmp, file, sizeof(buf) - tmp - strlen(file));
            // ERROR("TESTING %s\n", buf);
            if (!::stat(buf, &st)) {
                // ERROR("Found it at %s -> %s", buf, cstr + tmp);
                *len = str.size() - tmp;
                return cstr + tmp;
            }
        }
        buf[tmp + 1] = '\0';
        idx = tmp;
    }
    *len = str.size();
    return str.c_str();
}

bool Client::setFlag(int fd, int flag)
{
    int flags, r;
    EINTRWRAP(flags, fcntl(fd, F_GETFL, 0));
    if (flags == -1) {
        ERROR("Failed to read flags from %d %d %s", fd, errno, strerror(errno));
        return false;
    }
    EINTRWRAP(r, fcntl(fd, F_SETFL, flags | flag));

    if (r == -1) {
        ERROR("Failed to set flag 0x%x on socket %d %d %s", flag, fd, errno, strerror(errno));
        return false;
    }
    return true;
}

bool Client::recursiveMkdir(const std::string &dir, mode_t mode)
{
    struct stat statBuf;
    if (!::stat(dir.c_str(), &statBuf))
        return true;

    std::string subdir = dir;
    if (subdir.size() < PATH_MAX && subdir.length()) {
        if (subdir[subdir.length()-1] != '/')
            subdir += '/';
        for (size_t i = 1; i < subdir.length(); ++i) {
            if (subdir[i] == '/') {
                subdir[i] = 0;
                const int r = mkdir(subdir.c_str(), mode);
                if (r && errno != EEXIST && errno != EISDIR)
                    return false;
                subdir[i] = '/';
            }
        }
        return true;
    }
    return false;
}

bool Client::recursiveRmdir(const std::string &dir)
{
    DIR *d = opendir(dir.c_str());
    size_t path_len = dir.size();
    union {
        char buf[PATH_MAX];
        dirent dbuf;
    };

    if (!d) {
        return errno == ENOENT;
    }
    while (dirent *p = readdir(d)) {
        /* Skip the names "." and ".." as we don't want to recurse on them. */
        if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) {
            continue;
        }

        const size_t len = path_len + strlen(p->d_name) + 2;
        char buffer[PATH_MAX];

        struct stat statbuf;
        snprintf(buffer, len, "%s/%s", dir.c_str(), p->d_name);
        if (!::stat(buffer, &statbuf)) {
            if (S_ISDIR(statbuf.st_mode)) {
                Client::recursiveRmdir(buffer);
            } else {
                unlink(buffer);
            }
        }
    }
    closedir(d);
    return ::rmdir(dir.c_str()) == 0;
}

void Client::writeStatistics()
{
    const Client::Data &data = Client::data();
    if (data.localReason == CompilerArgs::Local_Preprocess)
        return;
    const std::string file = Config::statisticsLog;
    if (file.empty())
        return;

    json11::Json::object stats {
        { "start", static_cast<double>(Client::milliseconds_since_epoch / 1000.0) },
        { "end", static_cast<double>((Client::milliseconds_since_epoch + (Client::mono() - Client::started)) / 1000.0) }
    };
    if (data.compilerArgs) {
        const std::string sourceFile = data.compilerArgs->sourceFile();
        stats["sourceFile"] = sourceFile;
        struct stat st;
        if (!stat(sourceFile.c_str(), &st)) {
            stats["source_size"] = static_cast<int>(st.st_size);
        }
        int written = static_cast<int>(data.totalWritten);
        if (!written) {
            const std::string output = data.compilerArgs->output();
            if (!stat(output.c_str(), &st)) {
                written = static_cast<int>(st.st_size);
            }
        }
        if (written)
            stats["output_size"] = written;
    } else {
        stats["local"] = CompilerArgs::localReasonToString(data.localReason);
        stats["command_line"] = data.originalArgs;
    }
    stats["object_cache"] = data.objectCache;
    if (data.preprocessed) {
        stats["cpp_size"] = static_cast<int>(data.preprocessed->cppSize);
        stats["cpp_time"] = static_cast<int>(data.preprocessed->duration);
    }
    const std::string json = json11::Json(stats).dump();

    FILE *f = fopen(file.c_str(), "a+");
    if (!f) {
        ERROR("Failed to open %s for statistics log %d %s", file.c_str(), errno, strerror(errno));
        return;
    }
    int fd = fileno(f);

    errno = 0;
    ssize_t ret;
    EINTRWRAP(ret, flock(fd, LOCK_EX));
    if (ret) {
        ERROR("Failed to lock %s for writing %d %s", file.c_str(), errno, strerror(errno));
        EINTRWRAP(ret, fclose(f));
        return;
    }

    EINTRWRAP(ret, fwrite(json.c_str(), 1, json.size(), f));
    EINTRWRAP(ret, fwrite("\n", 1, 1, f));
    EINTRWRAP(ret, flock(fd, LOCK_UN));
    EINTRWRAP(ret, fclose(f));
}

static std::string argsAsString()
{
    const Client::Data &data = Client::data();
    std::string ret = data.compiler;
    for (int i=1; i<data.argc; ++i) {
        ret += ' ';
        ret += data.argv[i];
    }
    return ret;
}

void Client::runLocal(const std::string &reason)
{
    const Client::Data &data = Client::data();

    enum { Increment = 75000 };
    auto run = [&reason, &data]() {
        char **argvCopy = new char*[data.argc + 1];
        argvCopy[0] = strdup(data.compiler.c_str());
        for (int i=1; i<data.argc; ++i) {
            argvCopy[i] = data.argv[i];
        }
        argvCopy[data.argc] = nullptr;
        size_t micros = 0;
        while (true) {
            WARN("Running local: %s because %s", argsAsString().c_str(), reason.c_str());
            ::execv(data.compiler.c_str(), argvCopy);
            if (micros < Increment * 10)
                micros += Increment;
            ERROR("Trying execv(%s) again in %zu ms errno: %d %s", data.compiler.c_str(), micros / 1000, errno, strerror(errno));
            usleep(75000);
        }
        ERROR("fisk: Failed to exec %s (%d %s)", data.compiler.c_str(), errno, strerror(errno));
    };

    pid_t pid;
    size_t micros = 0;
    while (true) {
        pid = fork();
        if (pid == -1 && errno == EAGAIN) {
            if (micros < Increment * 10)
                micros += Increment;
            ERROR("Fork failed (%s) again errno: %d %s. Trying again... in %zums",
                  data.compiler.c_str(), errno, strerror(errno), micros / 1000);
            usleep(static_cast<unsigned int >(micros));
        } else {
            break;
        }
    }
    if (pid == -1) { // errpr
        ERROR("Failed to fork: %d %s", errno, strerror(errno));
        run();
        exit(101);
    } else if (pid == 0) { // child
        run();
        exit(102);
    } else { // parent
        int ret, status;
        EINTRWRAP(ret, waitpid(pid, &status, 0));
        writeStatistics();
        if (WIFEXITED(status))
            _exit(WEXITSTATUS(status));
        _exit(103);
    }
}

static bool gettime(timeval *time)
{
#if defined(__APPLE__)
    static mach_timebase_info_data_t info;
    static bool first = true;
    unsigned long long machtime = mach_absolute_time();
    if (first) {
        first = false;
        mach_timebase_info(&info);
    }
    machtime = machtime * info.numer / (info.denom * 1000); // microseconds
    time->tv_sec = static_cast<long>(machtime / 1000000);
    time->tv_usec = machtime % 1000000;
#elif defined(__linux__)
    timespec spec;
    const clockid_t cid = CLOCK_MONOTONIC_RAW;
    const int ret = ::clock_gettime(cid, &spec);
    if (ret == -1) {
        memset(time, 0, sizeof(timeval));
        return false;
    }
    time->tv_sec = spec.tv_sec;
    time->tv_usec = spec.tv_nsec / 1000;
#else
#error No gettime() implementation
#endif
    return true;
}

unsigned long long Client::mono()
{
    timeval time;
    if (gettime(&time)) {
        return (time.tv_sec * static_cast<uint64_t>(1000)) + (time.tv_usec / static_cast<uint64_t>(1000));
    }
    return 0;
}

const char *Client::compilerTypeToString(CompilerType type)
{
    switch (type) {
    case CompilerType::Unknown: return "unknown";
    case CompilerType::GCC: return "gcc";
    case CompilerType::Clang: return "clang";
    }
    assert(0 && "Impossible impossibility");
    return "";
}

enum { EnvironmentCacheVersion = 3 };
Client::CompilerInfo Client::compilerInfo(const std::string &compiler)
{
    struct stat st;
    if (::stat(compiler.c_str(), &st)) {
        return {};
    }

    auto readSignature = [&compiler]() -> std::string {
        std::string out, err;
        TinyProcessLib::Process proc(compiler + " -v", std::string(),
                                     [&out](const char *bytes, size_t n) {
                                         out.append(bytes, n);
                                     }, [&err](const char *bytes, size_t n) {
                                         err.append(bytes, n);
                                     });
        const int exit_status = proc.get_exit_status();
        if (exit_status) {
            ERROR("Failed to run %s -v\n%s\n", compiler.c_str(), err.c_str());
            return std::string();
        }

        out += err;
        filter(out);
        VERBOSE("Signature created from %s", out.c_str());
        return out;
    };
    const std::string cache = Config::envCache();
    if (cache.empty()) {
        return createCompilerInfo(compiler, readSignature());
    }

    std::string key = Client::format("%s:%llu", compiler.c_str(), static_cast<unsigned long long>(st.st_mtime));
    json11::Json::object json;
    int fd;
    if ((fd = open(cache.c_str(), O_CLOEXEC|O_RDONLY)) != -1) {
        if (flock(fd, LOCK_SH)) {
            ERROR("Failed to flock shared %s (%d %s)", cache.c_str(), errno, strerror(errno));
            ::close(fd);
        } else if (fstat(fd, &st)) {
            ERROR("Failed to fstat %s (%d %s)", cache.c_str(), errno, strerror(errno));
            flock(fd, LOCK_UN);
            ::close(fd);
        } else {
            const size_t size = static_cast<size_t>(st.st_size);
            if (size) {
                std::string contents(size, ' ');
                const size_t read = ::read(fd, &contents[0], size);
                flock(fd, LOCK_UN);
                ::close(fd);
                if (read != static_cast<size_t>(size)) {
                    ERROR("Failed to read from file: %s (%d %s)", cache.c_str(), errno, strerror(errno));
                } else {
                    std::string err;
                    json11::Json obj = json11::Json::parse(contents, err, json11::JsonParse::COMMENTS);
                    if (!err.empty()) {
                        ERROR("Failed to parse json from %s: %s", cache.c_str(), err.c_str());
                    }
                    if (obj.is_object()) {
                        json11::Json version = obj["version"];
                        if (version.int_value() != EnvironmentCacheVersion) {
                            json = json11::Json::object();
                            json["version"] = json11::Json(EnvironmentCacheVersion);
                        } else {
                            json11::Json value = obj[key];
                            if (value.is_object()) {
                                DEBUG("Cache hit for compiler %s", key.c_str());
                                CompilerInfo cacheHit;
                                cacheHit.hash = string(value, "hash");
                                const std::string type = string(value, "type");
                                if (type == "clang") {
                                    cacheHit.type = CompilerType::Clang;
                                } else if (type == "gcc") {
                                    cacheHit.type = CompilerType::GCC;
                                }
                                const json11::Json version = value["version"];
                                if (version.is_object()) {
                                    cacheHit.version.major = integer(version, "major");
                                    cacheHit.version.minor = integer(version, "minor");
                                    cacheHit.version.patch = integer(version, "patch");
                                }
                                // return cacheHit;
                            }

                            json = obj.object_items();
                            auto it = json.begin();
                            while (it != json.end()) {
                                if (it->first.size() > compiler.size() && !strncmp(it->first.c_str(), compiler.c_str(), compiler.size()) && it->first[compiler.size()] == ':') {
                                    json.erase(it++);
                                } else {
                                    ++it;
                                }
                            }
                        }
                    }
                }
            }
        }
    } else {
        DEBUG("Can't open %s for reading (%d %s)", cache.c_str(), errno, strerror(errno));
    }
    const CompilerInfo ret = createCompilerInfo(compiler, readSignature());
    if (!ret.hash.empty()) {
        auto compilerJson = json11::Json::object();
        compilerJson["hash"] = ret.hash;
        compilerJson["type"] = compilerTypeToString(ret.type);
        auto versionJSON = json11::Json::object();
        versionJSON["major"] = ret.version.major;
        versionJSON["minor"] = ret.version.minor;
        versionJSON["patch"] = ret.version.patch;
        compilerJson["version"] = std::move(versionJSON);
        json["version"] = json11::Json(EnvironmentCacheVersion);
        json[key] = std::move(compilerJson);

        std::string dirname;
        parsePath(cache.c_str(), nullptr, &dirname);
        recursiveMkdir(dirname);
        if ((fd = open(cache.c_str(), O_CREAT|O_RDWR|O_CLOEXEC, S_IRUSR|S_IWUSR|S_IRGRP|S_IWGRP|S_IROTH)) != -1) {
            std::string str = json11::Json(json).dump() + '\n';
            if (flock(fd, LOCK_EX|LOCK_NB)) {
                DEBUG("Failed to flock exclusive %s (%d %s)", cache.c_str(), errno, strerror(errno));
                ::close(fd);
                return ret;
            }
            if (write(fd, str.c_str(), str.size()) != static_cast<ssize_t>(str.size())) {
                ERROR("Failed to write to file %s - %d %s", cache.c_str(), errno, strerror(errno));
                unlink(cache.c_str());
            } else {
                if (ftruncate(fd, str.size())) {
                    ERROR("Failed to truncate file %s (%d %s)", cache.c_str(), errno, strerror(errno));
                }
            }
            flock(fd, LOCK_UN);
            ::close(fd);
        } else {
            ERROR("Failed to open %s for writing %d %s", cache.c_str(), errno, strerror(errno));
        }
    }
    return ret;
}

std::string Client::realpath(const std::string &path)
{
    char buf[PATH_MAX + 1];
    if (::realpath(path.c_str(), buf)) {
        return buf;
    }
    return std::string();
}

std::string Client::cwd()
{
    char buf[PATH_MAX];
    const char *ret = getcwd(buf, sizeof(buf));
    return ret ? std::string(ret) : std::string();
}

bool Client::uncompressToFile(const std::string &fileName, FILE *f, const void *bytes, size_t len)
{
    DEBUG("Uncompressing %zu bytes to file %s", len, fileName.c_str());
    z_stream zctx;
    zctx.zalloc = nullptr;
    zctx.zfree = nullptr;
    zctx.opaque = nullptr;
    zctx.avail_in = 0;
    zctx.next_in = nullptr;
    int ret = inflateInit2(&zctx, MAX_WBITS + 16);
    if (ret != Z_OK) {
        ERROR("Failed to inflateInit2 -> %d", ret);
        return false;
    }

    zctx.next_in = static_cast<const Bytef *>(bytes);
    zctx.avail_in = static_cast<uint32_t>(len);

    // temporary buffer for deflated data
    unsigned char buffer[16384];

    int zerr = 0;
    do {
        // point context at the output buffer
        zctx.next_out = buffer;
        zctx.avail_out = sizeof(buffer);

        zerr = ::inflate(&zctx, Z_SYNC_FLUSH);
        if ((zerr != Z_OK) && (zerr != Z_STREAM_END)) {
            inflateEnd(&zctx); // don't leak the context memory
            ERROR("uncompress failed (input %zu bytes): %d %s", len, zerr, zError(zerr));
            return false;
        }

        // output processed data to dst std::string
        const size_t processed = sizeof(buffer) - zctx.avail_out;
        if (fwrite(buffer, 1, processed, f) != processed) {
            ERROR("Failed to write to file %d %s", errno, strerror(errno));
            inflateEnd(&zctx); // don't leak the context memory
            return false;
        }
    } while (zerr != Z_STREAM_END);

    // free context memory
    inflateEnd(&zctx);

    return true;
}

std::string Client::base64(const std::string &src)
{
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO *sink = BIO_new(BIO_s_mem());
    BIO_push(b64, sink);
    BIO_write(b64, &src[0], static_cast<int>(src.size()));
    BIO_flush(b64);
    const char *encoded;
    const long len = BIO_get_mem_data(sink, &encoded);
    std::string ret(encoded, len);
    BIO_free(b64);
    BIO_free(sink);
    return ret;
}

std::string Client::uncolor(std::string str)
{
    size_t last = 0;
    while (true) {
        last = str.find("\x1b", last);
        // printf("Found one at %zu (%zu)\n", last, str.size());
        if (last == std::string::npos)
            break;
        const size_t end = std::min(str.find("m", last), str.find("K", last));
        if (end == std::string::npos)
            break;
        str.erase(last, end - last + 1);
    }
    return str;
}

bool Client::uploadEnvironment(SchedulerWebSocket *schedulerWebSocket, const std::string &tarball)
{
    const Client::Data &data = Client::data();

    FILE *f = fopen(tarball.c_str(), "r");
    if (!f) {
        ERROR("Failed to open %s for reading: %d %s", tarball.c_str(), errno, strerror(errno));
        return false;
    }
    struct stat st;
    if (stat(tarball.c_str(), &st)) {
        ERROR("Failed to stat %s: %d %s", tarball.c_str(), errno, strerror(errno));
        int ret;
        EINTRWRAP(ret, fclose(f));
        return false;
    }
    {
        json11::Json::object msg {
            { "type", "uploadEnvironment" },
            { "hash", data.hash },
            { "bytes", static_cast<int>(st.st_size) }
        };

        std::string json = json11::Json(msg).dump();
        schedulerWebSocket->send(WebSocket::Text, json.c_str(), json.size());
        Select select;
        select.add(schedulerWebSocket);
        char buf[1024 * 256];
        size_t sent = 0;
        do {
            const size_t chunkSize = std::min(static_cast<size_t>(st.st_size - sent), sizeof(buf));
            if (fread(buf, 1, chunkSize, f) != chunkSize) {
                ERROR("Failed to read from %s: %d %s", tarball.c_str(), errno, strerror(errno));
                int ret;
                EINTRWRAP(ret, fclose(f));
                return false;
            }
            schedulerWebSocket->send(WebSocket::Binary, buf, chunkSize);
            DEBUG("Sending %zu bytes %zu/%zu sent", chunkSize, sent, static_cast<size_t>(st.st_size));
            while (schedulerWebSocket->hasPendingSendData() && schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket)
                select.exec();
            sent += chunkSize;
        } while (sent < static_cast<size_t>(st.st_size) && schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket);
    }
    int ret;
    EINTRWRAP(ret, fclose(f));
    return schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket;
}

extern "C" const unsigned char create_fisk_env[];
extern "C" const unsigned create_fisk_env_size;
std::string Client::prepareEnvironmentForUpload(std::string *directory)
{
    const Client::Data &data = Client::data();

    char dir[PATH_MAX];
    strcpy(dir, "/tmp/fisk-env-XXXXXX");
    if (!mkdtemp(dir)) {
        ERROR("Failed to mkdtemp %d %s", errno, strerror(errno));
        return std::string();
    }
    *directory = dir;

    // printf("GOT DIR %s\n", dir);

    const std::string info = Client::format("%s/compiler-info_%s", dir, data.hash.c_str());
    FILE *f = fopen(info.c_str(), "w");
    if (!f) {
        ERROR("Failed to create info file: %s %d %s", info.c_str(), errno, strerror(errno));
        return std::string();
    }

    fprintf(f, "{ \"hash\": \"%s\", \"system\": \"%s\", \"originalPath\": \"%s\" }\n",
            data.hash.c_str(), systemName, data.resolvedCompiler.c_str());

    {
        std::string stdOut, stdErr;
        TinyProcessLib::Process proc(data.resolvedCompiler + " -v", dir,
                                     [&stdOut](const char *bytes, size_t n) { stdOut.append(bytes, n); },
                                     [&stdErr](const char *bytes, size_t n) { stdErr.append(bytes, n); });
        const int exit_status = proc.get_exit_status();
        if (exit_status) {
            ERROR("Failed to run %s -v\n%s", data.resolvedCompiler.c_str(), stdErr.c_str());
            int ret;
            EINTRWRAP(ret, fclose(f));
            return std::string();
        }
        stdOut += stdErr;
        filter(stdOut);
        int ret;
        ssize_t w;
        EINTRWRAP(w, fwrite(stdOut.c_str(), 1, stdOut.size(), f));
        if (w != static_cast<int>(stdOut.size())) {
            ERROR("Failed to write to %s: %d %s", info.c_str(), errno, strerror(errno));
            EINTRWRAP(ret, fclose(f));
            return std::string();
        }
        EINTRWRAP(ret, fclose(f));
    }


    std::string stdOut, stdErr;
    TinyProcessLib::Process proc("bash", dir,
                                 [&stdOut](const char *bytes, size_t n) {
                                     stdOut.append(bytes, n);
                                     // printf("%s", std::string(bytes, n).c_str());
                                     if (Log::minLogLevel <= Log::Debug)
                                         Log::log(Log::Debug, std::string(bytes, n), Log::NoTrailingNewLine);
                                 }, [&stdErr](const char *bytes, size_t n) {
                                     stdErr.append(bytes, n);
                                     // fprintf(stderr, "%s", std::string(bytes, n).c_str());
                                     if (Log::minLogLevel <= Log::Debug)
                                         Log::log(Log::Debug, std::string(bytes, n), Log::NoTrailingNewLine);
                                 }, true);

    proc.write(Client::format("export ARG1=%s\n"
                              "export ARG2=--addfile\n"
                              "export ARG3=%s:/etc/compiler_info\n",
                              data.resolvedCompiler.c_str(),
                              info.c_str()));
    proc.write(reinterpret_cast<const char *>(create_fisk_env), create_fisk_env_size);
    DEBUG("Running create-fisk-env %s --addfile %s:/etc/compiler_info", data.resolvedCompiler.c_str(), info.c_str());
    proc.close_stdin();
    const int exit_status = proc.get_exit_status();
    if (exit_status) {
        ERROR("Failed to run create-fisk-env: %s", stdErr.c_str());
        return std::string();
    }
    if (stdOut.size() > 1 && stdOut[stdOut.size() - 1] == '\n')
        stdOut.resize(stdOut.size() - 1);
    const size_t idx = stdOut.rfind("\ncreating ");
    if (idx == std::string::npos) {
        ERROR("Failed to parse stdout of create-fisk-env:\n%s", stdOut.c_str());
        return std::string();
    }
    std::string tarball = Client::format("%s/%s", dir, stdOut.substr(idx + 10).c_str());
    return tarball;
}

bool Client::isAtty()
{
    if (!isatty(STDOUT_FILENO)) {
        return false;
    }
    const char *term = getenv("TERM");
    if (!term || strcasecmp(term, "dumb")) {
        return true;
    }
    return false;
}

std::string Client::Data::commandLineAsString() const
{
    std::string ret;
    if (compilerArgs) {
        for (const std::string &arg : compilerArgs->commandLine) {
            if (ret.size())
                ret += ' ';
            ret += arg;
        }
    } else {
        ret = "none";
    }
    return ret;
}

std::string Client::formatJSONDiagnostics(const std::string &str)
{
    std::string err;
    const json11::Json parsed = json11::Json::parse(str, err);
    if (!parsed.is_array()) {
        return str;
    }

    const std::vector<json11::Json> array = parsed.array_items();
    if (array.empty())
        return std::string();

    std::string ret;
    ret.reserve(array.size() * 256);

    for (const json11::Json &item : array) {
        const std::string kind = string(item, "kind");
        Color color;
        if (Config::color) {
            color = kind == "error" ? Color::Red : Color::Purple;
        }
        std::vector<json11::Json> locations, fixits;
        {
            json11::Json tmp = item["locations"];
            if (tmp.is_array())
                locations = tmp.array_items();
            tmp = item["fixits"];
            if (tmp.is_array())
                fixits = tmp.array_items();
        }
        if (!locations.empty()) {
            const json11::Json loc = locations[0];
            const std::string file = string(loc, "caret.file");
            const int caretLine = integer(loc, "caret.line");
            const int caretColumn = integer(loc, "caret.column");
            int finishCol = integer(loc, "finish.column");
            int startCol = 0;
            if (loc["start"].is_object()) {
                startCol = integer(loc, "start.column");
            }
            if (!startCol) {
                startCol = caretColumn;
            }
            if (!finishCol) {
                finishCol = startCol;
            }
            const std::string message = string(item, "message");
            std::string option = string(item, "option");
            if (!option.empty()) {
                option = " [" + option + ']';
            }

            ret += Client::format("%s:%d:%d: %s: %s%s\n", file.c_str(), caretLine, caretColumn,
                                  colorize(kind, color).c_str(), message.c_str(), option.c_str());
            std::string srcLine = lineFromFile(file, caretLine);
            ret += colorize(srcLine, color, startCol - 1, finishCol - startCol + 1) + '\n';
            std::string caret(startCol - 1, ' ');
            std::string tmp;
            for (int i=startCol; i<finishCol + 1; ++i) {
                tmp += i == caretColumn ? '^' : '~';
            }
            caret += colorize(tmp, color);
            caret += "\n";
            ret += caret;
            if (!fixits.empty()) {
                const int fixitStart = integer(fixits[0], "start.column");
                const int fixitEnd = integer(fixits[0], "next.column"); // weird
                const std::string replacement = string(fixits[0], "string");
                if (!replacement.empty() && fixitStart != 0 && fixitEnd != 0) {
                    ret += std::string(fixitStart - 1, ' ') + colorize(replacement, color) + '\n';
                }
            }
        }
    }

    return ret;
}
