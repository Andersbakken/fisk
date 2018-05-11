#include "Client.h"

#include "Log.h"
#include "CompilerArgs.h"
#include "Config.h"
#include <unistd.h>
#include <climits>
#include <cstdlib>
#include <string.h>
#include <sys/file.h>
#include <dirent.h>
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

static std::mutex sMutex;
std::mutex &Client::mutex()
{
    return sMutex;
}

std::string Client::findCompiler(int argc, char **argv, std::string *resolvedCompiler)
{
    const char *path = getenv("PATH");
    // printf("PATH %s\n", path);
    std::string exec;
    if (path) {
        std::string self, basename;
        const char *begin = path, *end = 0;
        // printf("trying realpath [%s]\n", argv[0]);
        std::string rp = Client::realpath(argv[0]);
        printf("REALPATH %s %s\n", argv[0], rp.c_str());
        if (!rp.empty()) {
            std::string dirname;
            parsePath(rp, 0, &dirname);
            parsePath(argv[0], &basename, 0);
            self = dirname + basename;
        } else if (strchr(argv[0], '/')) {
            return std::string();
        } else {
            basename = argv[0];
        }
        // printf("realPath %s dirname %s argv[0] %s basename %s\n", realPath, dirname.c_str(), argv[0], basename.c_str());
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
                exec += basename;
                if (exec != self && !access(exec.c_str(), X_OK)) {
                    if (self.empty()) {
                        self = exec;
                    } else {
                        if (fileType(exec) == Symlink) {
                            char link[PATH_MAX + 1];
                            const ssize_t len = readlink(exec.c_str(), link, sizeof(link) - 1);
                            if (len < 0) {
                                Log::error("Can't follow symlink: %s (%d %s)", exec.c_str(), errno, strerror(errno));
                                exec.clear();
                                continue;
                            }
                            link[len] = '\0';
                            std::string linkedFile;
                            parsePath(link, &linkedFile, 0);
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
    }

    *resolvedCompiler = Client::realpath(exec);
    printf("SHIT %s|%s\n", exec.c_str(), resolvedCompiler->c_str());

    const size_t slash = resolvedCompiler->rfind('/');
    if (slash != std::string::npos) {
        for (size_t i=slash + 2; i<resolvedCompiler->size(); ++i) {
            if ((*resolvedCompiler)[i] == '+' && (*resolvedCompiler)[i - 1] == '+') {
                if ((*resolvedCompiler)[i - 2] == 'c') {
                    (*resolvedCompiler)[i - 1] = 'c';
                    resolvedCompiler->erase(i);
                } else if ((*resolvedCompiler)[i - 2] == 'g') {
                    (*resolvedCompiler)[i - 1] = 'c';
                    (*resolvedCompiler)[i] = 'c';
                }
            }
        }
    }
    printf("RESIULT %s\n", resolvedCompiler->c_str());

    return exec;
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

Client::Slot::Slot(int fd, std::string &&path)
    : mFD(fd), mPath(std::move(path))
{
}

Client::Slot::~Slot()
{
    if (mFD != -1) {
        Log::info("Dropping lock on %s", mPath.c_str());
        flock(mFD, LOCK_UN);
        unlink(mPath.c_str());
    }
}

bool Client::setFlag(int fd, int flag)
{
    int flags, r;
    while ((flags = fcntl(fd, F_GETFL, 0)) == -1 && errno == EINTR);
    if (flags == -1) {
        Log::error("Failed to read flags from %d %d %s", fd, errno, strerror(errno));
        return false;
    }
    while ((r = fcntl(fd, F_SETFL, flags | flag)) == -1 && errno == EINTR);

    if (r == -1) {
        Log::error("Failed to set flag 0x%x on socket %d %d %s", flag, fd, errno, strerror(errno));
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

std::unique_ptr<Client::Preprocessed> Client::preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args)
{
    Preprocessed *ptr = new Preprocessed;
    std::unique_ptr<Client::Preprocessed> ret(ptr);
    ret->mThread = std::thread([ptr, args, compiler] {
            assert(args->mode == CompilerArgs::Compile);
            std::string out, err;
            ptr->stdOut.reserve(1024 * 1024);
            std::string commandLine = compiler;
            const size_t count = args->commandLine.size();
            auto append = [&commandLine](const std::string &arg) {
                const size_t idx = arg.find('\'');
                if (idx != std::string::npos) {
                    // ### gotta escape quotes
                }
                commandLine += arg;

            };
            for (size_t i=1; i<count; ++i) {
                commandLine += " '";
                if (i == args->objectFileIndex) {
                    commandLine += '-';
                } else {
                    append(args->commandLine.at(i));
                }
                commandLine += '\'';
            }
            commandLine += " '-E'";
            TinyProcessLib::Process proc(commandLine, std::string(),
                                         [ptr](const char *bytes, size_t n) {
                                             ptr->stdOut.append(bytes, n);
                                         }, [ptr](const char *bytes, size_t n) {
                                             ptr->stdErr.append(bytes, n);
                                         });
            ptr->exitStatus = proc.get_exit_status();
            std::unique_lock<std::mutex> lock(ptr->mMutex);
            ptr->mDone = true;
            ptr->mCond.notify_one();
        });
    return ret;
}

Client::Preprocessed::~Preprocessed()
{
    wait();
}

void Client::Preprocessed::wait()
{
    {
        std::unique_lock<std::mutex> lock(mMutex);
        if (mJoined)
            return;
        while (!mDone) {
            mCond.wait(lock);
        }
        mJoined = true;
    }
    mThread.join();
}

std::unique_ptr<Client::Slot> Client::acquireSlot(Client::AcquireSlotMode mode)
{
    std::string dir;
    const size_t slots = Config::localSlots(&dir);
    if (dir.empty() || !slots) {
        return std::make_unique<Slot>(-1, std::string());
    }

    if (!recursiveMkdir(dir)) {
        return std::make_unique<Slot>(-1, std::string());
    }

    if (dir.at(dir.size() - 1) != '/')
        dir += '/';

    auto check = [&dir, slots]() -> std::unique_ptr<Client::Slot> {
        for (size_t i=0; i<slots; ++i) {
            std::string path = dir + std::to_string(i) + ".lock";
            int fd = open(path.c_str(), O_APPEND | O_CLOEXEC | O_CREAT, S_IRWXU);
            if (fd == -1) {
                Log::error("Failed to open file %s %d %s", path.c_str(), errno, strerror(errno));
                continue;
            }
            if (!flock(fd, LOCK_EX|LOCK_NB)) {
                Log::info("Acquired lock on %s", path.c_str());
                return std::make_unique<Slot>(fd, std::move(path));
            }
            ::close(fd);
        }
        return std::unique_ptr<Slot>();
    };
    std::unique_ptr<Slot> slot = check();
    if (slot || mode == Try) {
        return slot;
    }

#ifdef __linux__
    int inotifyFD = inotify_init1(IN_CLOEXEC);
    if (inotifyFD == -1) {
        Log::error("Failed to inotify_init1 %d %s", errno, strerror(errno));
        return std::make_unique<Slot>(-1, std::string());
    }

    const int watch = inotify_add_watch(inotifyFD, dir.c_str(), IN_DELETE|IN_DELETE_SELF|IN_CLOSE_WRITE|IN_CLOSE_NOWRITE);
    if (watch == -1) {
        Log::error("inotify_add_watch() '%s' (%d) %s",
                   dir.c_str(), errno, strerror(errno));
        ::close(inotifyFD);
        return std::make_unique<Slot>(-1, std::string());
    }
    do {
        fd_set r;
        FD_ZERO(&r);
        FD_SET(inotifyFD, &r);
        timeval timeout = { 1, 0 };
        select(inotifyFD + 1, &r, 0, 0, &timeout);
        slot = check();
    } while (!slot);

    ::close(inotifyFD);
#elif __APPLE__
    do {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        slot = check();
    } while (!slot);
#endif

    return slot;
}

void Client::runLocal(const std::string &exec, int argc, char **argv, std::unique_ptr<Slot> &&slot)
{
    auto run = [&exec, argc, argv]() {
        char **argvCopy = new char*[argc + 1];
        argvCopy[0] = strdup(exec.c_str());
        for (int i=1; i<argc; ++i) {
            argvCopy[i] = argv[i];
        }
        argvCopy[argc] = 0;
        ::execv(exec.c_str(), argvCopy);
        Log::error("fisk: Failed to exec %s (%d %s)", exec.c_str(), errno, strerror(errno));
    };

    const pid_t pid = fork();
    if (pid == -1) { // errpr
        Log::error("Failed to fork: %d %s", errno, strerror(errno));
        run();
        exit(101);
    } else if (pid == 0) { // child
        run();
        exit(101);
    } else { // paren
        int status;
        waitpid(pid, &status, 0);
        slot.reset();
        if (WIFEXITED(status))
            exit(WEXITSTATUS(status));
        exit(101);
    }
}

bool gettime(timeval *time)
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
    time->tv_sec = machtime / 1000000;
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

std::string Client::environmentHash(const std::string &compiler)
{
    struct stat st;
    if (::stat(compiler.c_str(), &st)) {
        return std::string();
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
            Log::error("Failed to run %s -v\n%s\n", compiler.c_str(), err.c_str());
            return std::string();
        }

        return Client::toHex(Client::sha1(out + err));
    };
    const std::string cache = Config::envCache();
    if (cache.empty())
        return readSignature();

    std::string key = Client::format("%s:%llu", compiler.c_str(), static_cast<unsigned long long>(st.st_mtime));
    json11::Json::object json;
    FILE *f = fopen(cache.c_str(), "r");
    if (f) {
        fseek(f, 0, SEEK_END);
        const long size = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (size) {
            std::string contents(size, ' ');
            const size_t read = fread(&contents[0], 1, size, f);
            fclose(f);
            if (read != static_cast<size_t>(size)) {
                Log::error("Failed to read from file: %s (%d %s)", cache.c_str(), errno, strerror(errno));
            } else {
                std::string err;
                json11::Json obj = json11::Json::parse(contents, err, json11::JsonParse::COMMENTS);
                if (!err.empty()) {
                    Log::error("Failed to parse json from %s: %s", cache.c_str(), err.c_str());
                }
                if (obj.is_object()) {
                    json11::Json value = obj[key];
                    if (value.is_string()) {
                        Log::debug("Cache hit for compiler %s", key.c_str());
                        return value.string_value();
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
    const std::string ret = readSignature();
    if (!ret.empty()) {
        json[key] = ret;
        std::string dirname;
        parsePath(cache.c_str(), 0, &dirname);
        recursiveMkdir(dirname);
        FILE *f = fopen(cache.c_str(), "w");
        if (f) {
            std::string str = json11::Json(json).dump();
            if (fwrite(str.c_str(), 1, str.size(), f) != str.size()) {
                Log::error("Failed to write to file %s - %d %s", cache.c_str(), errno, strerror(errno));
            }
            fclose(f);
        } else {
            Log::error("Failed to open %s for writing %d %s", cache.c_str(), errno, strerror(errno));
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

std::string Client::findExecutablePath(const char *argv0)
{
#if defined(__linux__)
    char buf[32];
    const int w = snprintf(buf, sizeof(buf), "/proc/%d/exe", getpid());
    std::string p(buf, w);
    if (fileType(p) == Symlink) {
        char buf[PATH_MAX];
        const ssize_t len = readlink(p.c_str(), buf, sizeof(buf));
        if (len > 0) {
            p.assign(buf, len);
            if (fileType(p) == File) {
                return p;
            }
        }
    }
#elif defined(__APPLE__)
    {
        char buf[PATH_MAX + 1];
        uint32_t size = PATH_MAX;
        if (_NSGetExecutablePath(buf, &size) == 0) {
            buf[PATH_MAX] = '\0';
            return Client::realpath(buf);
        }
    }
#else
#error Unknown platform
#endif

    return std::string();
}
