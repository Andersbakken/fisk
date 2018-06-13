#include "Client.h"

#include "Log.h"
#include "CompilerArgs.h"
#include "Select.h"
#include "SlotAcquirer.h"
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

static Client::Data sData;
const unsigned long long Client::started = Client::mono();
Client::Data &Client::data()
{
    return sData;
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

static std::string resolveSymlink(const std::string &link, const std::function<CheckResult(const std::string &)> &check)
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
            Client::parsePath(l, 0, &dirname);
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

bool Client::findCompiler(const char *preresolved)
{
    // printf("PATH %s\n", path);
    std::string exec;
    if (!preresolved) {
        const char *path = getenv("PATH");
        if (path) {
            std::string self, basename;
            const char *begin = path, *end = 0;
            // printf("trying realpath [%s]\n", argv[0]);
            std::string rp = Client::realpath(sData.argv[0]);
            // printf("REALPATH %s %s\n", argv[0], rp.c_str());
            if (!rp.empty()) {
                std::string dirname;
                parsePath(rp, 0, &dirname);
                parsePath(sData.argv[0], &basename, 0);
                self = dirname + basename;
            } else if (strchr(sData.argv[0], '/')) {
                return false;
            } else {
                basename = sData.argv[0];
            }

            // printf("self %s argv[0] %s basename %s\n", self.c_str(), argv[0], basename.c_str());
            // printf("realPath %s dirname %s argv[0] %s basename %s\n", rp.c_str(), dirname.c_str(), argv[0], basename.c_str());
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
                                    ERROR("Can't follow symlink: %s (%d %s)", exec.c_str(), errno, strerror(errno));
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
    } else {
        exec = preresolved;
    }

    if (exec.empty())
        return false;

    std::string base;
    parsePath(exec, &base, 0);
    if (base.find("g++") != std::string::npos || base.find("gcc") != std::string::npos) {
        sData.resolvedCompiler = exec;
    } else {
        resolveSymlink(exec, [](const std::string &p) -> CheckResult {
                std::string base;
                parsePath(p, &base, 0);
                // Log::debug("GOT BASE %s", base.c_str());
                if (base.find("g++") != std::string::npos || base.find("gcc") != std::string::npos) {
                    return Stop;
                }
                return Continue;
            });
    }
    {
        size_t slash = exec.rfind('/');
        if (slash == std::string::npos)
            slash = 0;
        const char *ch = &exec[slash];
        while (*ch) {
            if (*ch == 'g') {
                if (!strncmp(ch + 1, "++", 2)) {
                    sData.slaveCompiler =  "/usr/bin/g++";
                    break;
                } else if (!strncmp(ch + 1, "cc", 2)) {
                    sData.slaveCompiler =  "/usr/bin/gcc";
                    break;
                }
            } else if (*ch == 'c') {
                if (!strncmp(ch + 1, "lang", 4)) {
                    if (!strncmp(ch + 5, "++", 2)) {
                        sData.slaveCompiler =  "/usr/bin/clang++";
                        break;
                    } else {
                        sData.slaveCompiler =  "/usr/bin/clang";
                        break;
                    }
                }
            }
            ++ch;
        }

    }
    {
        const size_t slash = sData.resolvedCompiler.rfind('/');
        if (slash != std::string::npos) {
            for (size_t i=slash + 2; i<sData.resolvedCompiler.size(); ++i) {
                if (sData.resolvedCompiler[i] == '+' && sData.resolvedCompiler[i - 1] == '+') {
                    if (sData.resolvedCompiler[i - 2] == 'c') {
                        sData.resolvedCompiler[i - 1] = 'c';
                        sData.resolvedCompiler.erase(i);
                    } else if (sData.resolvedCompiler[i - 2] == 'g') {
                        if (i > 6 && !strncmp(sData.resolvedCompiler.c_str() + i - 6, "clang", 5)) {
                            sData.resolvedCompiler.erase(sData.resolvedCompiler.begin() + i - 1, sData.resolvedCompiler.begin() + i + 1);
                        } else {
                            sData.resolvedCompiler[i - 1] = 'c';
                            sData.resolvedCompiler[i] = 'c';
                        }
                    }
                }
            }
        }
    }
    // printf("RESULT %s\n", resolvedCompiler->c_str());

    sData.compiler = std::move(exec);
    return true;
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
    if (!mPath.empty())
        sData.lockFilePaths.insert(path);
}

Client::Slot::~Slot()
{
    if (mFD != -1) {
        DEBUG("Dropping lock on %s for %s", mPath.c_str(), sData.compilerArgs ? sData.compilerArgs->sourceFile().c_str() : "");
        sData.lockFilePaths.erase(mPath);
        flock(mFD, LOCK_UN);
        unlink(mPath.c_str());
    }
}

bool Client::setFlag(int fd, int flag)
{
    int flags, r;
    while ((flags = fcntl(fd, F_GETFL, 0)) == -1 && errno == EINTR);
    if (flags == -1) {
        ERROR("Failed to read flags from %d %d %s", fd, errno, strerror(errno));
        return false;
    }
    while ((r = fcntl(fd, F_SETFL, flags | flag)) == -1 && errno == EINTR);

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

std::unique_ptr<Client::Preprocessed> Client::preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args)
{
    const unsigned long long started = Client::mono();
    Preprocessed *ptr = new Preprocessed;
    std::unique_ptr<Client::Preprocessed> ret(ptr);
    ret->mThread = std::thread([ptr, args, compiler, started] {
            assert(args->mode == CompilerArgs::Compile);
            std::string out, err;
            ptr->stdOut.reserve(1024 * 1024);
            std::string commandLine = compiler;
            const size_t count = args->commandLine.size();
            auto append = [&commandLine](const std::string &arg) {
                // std::string copy;
                // size_t slashes = 0;
                // for (size_t i=0; i<arg.size(); ++i) {
                //     const char ch = arg.at(i);
                //     if (ch == '\\') {
                //         ++slashes;
                //         continue;
                //     }
                //     if (ch == '\'') {
                //         if (slashes % 2 == 0) {
                //             if (copy.empty()) {
                //                 copy.assign(arg.c_str(), i);
                //             } else {

                //             }
                //         }
                //     }
                //     slashes = 0;
                // }
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
            DEBUG("Acquiring preprocess slot: %s", commandLine.c_str());
            std::shared_ptr<Client::Slot> slot = Client::acquireCppSlot(Client::Wait);
            DEBUG("Running preprocess: %s", commandLine.c_str());
            TinyProcessLib::Process proc(commandLine, std::string(),
                                         [ptr](const char *bytes, size_t n) {
                                             ptr->stdOut.append(bytes, n);
                                         }, [ptr](const char *bytes, size_t n) {
                                             ptr->stdErr.append(bytes, n);
                                         });
            ptr->exitStatus = proc.get_exit_status();
            slot.reset();
            std::unique_lock<std::mutex> lock(ptr->mMutex);
            ptr->mDone = true;
            ptr->duration = Client::mono() - started;
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

static std::unique_ptr<Client::Slot> acquireSlot(std::string &&dir, size_t slots, Client::AcquireSlotMode mode)
{
    if (dir.empty() || !slots) {
        return std::make_unique<Client::Slot>(-1, std::string());
    }

    if (!Client::recursiveMkdir(dir)) {
        return std::make_unique<Client::Slot>(-1, std::string());
    }

    if (dir.at(dir.size() - 1) != '/')
        dir += '/';

    auto check = [&dir, slots]() -> std::unique_ptr<Client::Slot> {
        for (size_t i=0; i<slots; ++i) {
            std::string path = dir + std::to_string(i) + ".lock";
            int fd = open(path.c_str(), O_APPEND | O_CLOEXEC | O_CREAT, S_IRWXU);
            if (fd == -1) {
                ERROR("Failed to open file %s %d %s", path.c_str(), errno, strerror(errno));
                continue;
            }
            if (!flock(fd, LOCK_EX|LOCK_NB)) {
                sData.lockFilePaths.insert(path);
                DEBUG("Acquiredlock on %s for %s", path.c_str(), sData.compilerArgs ? sData.compilerArgs->sourceFile().c_str() : "");
                return std::make_unique<Client::Slot>(fd, std::move(path));
            }
            ::close(fd);
        }
        return std::unique_ptr<Client::Slot>();
    };
    std::unique_ptr<Client::Slot> slot = check();
    if (slot || mode == Client::Try) {
        return slot;
    }

    SlotAcquirer slotAcquirer(dir, [&slot, &check]() -> void {
            slot = check();
        });
    Select select;
    select.add(&slotAcquirer);
    do {
        select.exec();
    } while (!slot);

    return slot;
}


std::unique_ptr<Client::Slot> Client::acquireSlot(Client::AcquireSlotMode mode)
{
    std::string dir;
    const std::pair<size_t, size_t> s = Config::localSlots(&dir);
    const size_t slots = mode == Try ? s.first : s.second;
    return ::acquireSlot(std::move(dir), slots, mode);
}

std::unique_ptr<Client::Slot> Client::acquireCppSlot(Client::AcquireSlotMode mode)
{
    std::string dir;
    const size_t slots = Config::cppSlots(&dir);
    return ::acquireSlot(std::move(dir), slots, mode);
}

void Client::runLocal(std::unique_ptr<Slot> &&slot)
{
    auto run = []() {
        char **argvCopy = new char*[sData.argc + 1];
        argvCopy[0] = strdup(sData.compiler.c_str());
        for (int i=1; i<sData.argc; ++i) {
            argvCopy[i] = sData.argv[i];
        }
        argvCopy[sData.argc] = 0;
        ::execv(sData.compiler.c_str(), argvCopy);
        ERROR("fisk: Failed to exec %s (%d %s)", sData.compiler.c_str(), errno, strerror(errno));
    };

    const pid_t pid = fork();
    if (pid == -1) { // errpr
        ERROR("Failed to fork: %d %s", errno, strerror(errno));
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
            _exit(WEXITSTATUS(status));
        _exit(101);
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
            ERROR("Failed to run %s -v\n%s\n", compiler.c_str(), err.c_str());
            return std::string();
        }

        return Client::toHex(Client::sha1(out + err));
    };
    const std::string cache = Config::envCache();
    if (cache.empty())
        return readSignature();

    std::string key = Client::format("%s:%llu", compiler.c_str(), static_cast<unsigned long long>(st.st_mtime));
    json11::Json::object json;
    int fd;
    if ((fd = open(cache.c_str(), O_CLOEXEC|O_RDONLY)) != -1) {
        struct stat st;
        if (flock(fd, LOCK_SH)) {
            ERROR("Failed to flock shared %s (%d %s)", cache.c_str(), errno, strerror(errno));
            ::close(fd);
        } else if (fstat(fd, &st)) {
            ERROR("Failed to fstat %s (%d %s)", cache.c_str(), errno, strerror(errno));
            flock(fd, LOCK_UN);
            ::close(fd);
        } else {
            const long size = st.st_size;
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
                        json11::Json value = obj[key];
                        if (value.is_string()) {
                            DEBUG("Cache hit for compiler %s", key.c_str());
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
    } else {
        DEBUG("Can't open %s for reading (%d %s)", cache.c_str(), errno, strerror(errno));
    }
    const std::string ret = readSignature();
    if (!ret.empty()) {
        json[key] = ret;
        std::string dirname;
        parsePath(cache.c_str(), 0, &dirname);
        recursiveMkdir(dirname);
        if ((fd = open(cache.c_str(), O_CREAT|O_RDWR|O_CLOEXEC, S_IRUSR|S_IWUSR|S_IRGRP|S_IWGRP|S_IROTH)) != -1) {
            std::string str = json11::Json(json).dump();
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

