#include "Client.h"

#include "Log.h"
#include "Config.h"
#include <unistd.h>
#include <climits>
#include <cstdlib>
#include <string.h>
#include <sys/file.h>
#include <sys/inotify.h>
#ifdef __APPLE__
#include <mach/mach.h>
#include <mach/mach_time.h>
#endif

static std::mutex sMutex;
std::mutex &Client::mutex()
{
    return sMutex;
}

std::string Client::findCompiler(int argc, char **argv)
{
    const char *path = getenv("PATH");
    std::string exec;
    if (path) {
        std::string self, basename, dirname;
        char realPath[PATH_MAX];
        const char *begin = path, *end = 0;
        if (realpath(argv[0], realPath)) {
            parsePath(realPath, 0, &dirname);
            parsePath(argv[0], &basename, 0);
            // printf("realPath %s dirname %s argv[0] %s basename %s\n", realPath, dirname.c_str(), argv[0], basename.c_str());
            self = dirname + basename;
            do {
                end = strchr(begin, ':');
                if (!end) {
                    exec = begin;
                } else {
                    exec.assign(begin, end - begin);
                    begin = end + 1;
                }
                // printf("trying %s\n", exec.c_str());
                if (!exec.empty()) {
                    if (exec[exec.size() - 1] != '/')
                        exec += '/';
                    exec += basename;
                    if (exec != self && !access(exec.c_str(), X_OK)) {
                        break;
                    }
                    exec.clear();
                }
            } while (end);
        }
    }
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

std::unique_ptr<Client::Slot> Client::acquireSlot(Client::AcquireSlotMode mode)
{
    std::string dir;
    const size_t slots = Config().localSlots(&dir);
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
                return std::make_unique<Slot>(fd, std::move(path));
            }
        }
        return std::unique_ptr<Slot>();
    };
    std::unique_ptr<Slot> slot = check();
    if (slot || mode == Try) {
        return slot;
    }

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
    return slot;
}

int Client::runLocal(const std::string &exec, int argc, char **argv, std::unique_ptr<Slot> &&slot)
{
    auto run = [&exec, argc, argv]() {
        char **argvCopy = new char*[argc + 1];
        argvCopy[0] = strdup(exec.c_str());
        for (size_t i=1; i<argc; ++i) {
            argvCopy[i] = argv[i];
        }
        argvCopy[argc] = 0;
        ::execv(exec.c_str(), argvCopy);
        Log::error("fisk: Failed to exec %s (%d %s)", exec.c_str(), errno, strerror(errno));
    };

    int pipe[2];
    if (::pipe(pipe) != 0) {
        Log::error("Failed to create a pipe %d %s", errno, strerror(errno));
        run();
        return 0;
    }
    if (!Client::setFlag(pipe[1], O_CLOEXEC)) {
        Log::error("Failed to make pipe O_CLOEXEC");
        run();
        return 0;
    }
    
    pid_t ret = fork();
    if (ret == -1) {
        Log::error("Failed to fork: %d %s", errno, strerror(errno));
        run();
        return 0;
    } else if (ret == 0) {        
        run();
        return 0;
    } else {
        if (ret == -1) {

            char **argvCopy = new char*[argc + 1];
            argvCopy[0] = strdup(exec.c_str());
            for (size_t i=1; i<argc; ++i) {
                argvCopy[i] = argv[i];
            }
            argvCopy[argc] = 0;
            ::execv(exec.c_str(), argvCopy);
            Log::error("fisk: Failed to exec %s (%d %s)", exec.c_str(), errno, strerror(errno));
            return 1;
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

