#include "Client.h"

#include <unistd.h>
#include "SchedulerWebSocket.h"
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
#include <semaphore.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#endif

#ifdef __APPLE__
const char *systemName = "Darwin x86_64";
#elif defined(__linux__) && defined(__i686)
const char *systemName = "Linux i686"
#elif defined(__linux__) && defined(__x86_64)
const char *systemName = "Linux x86_64";
#else
#error unsupported platform
#endif

static Client::Data sData;
const unsigned long long Client::started = Client::mono();
const unsigned long long Client::milliseconds_since_epoch = std::chrono::system_clock::now().time_since_epoch() / std::chrono::milliseconds(1);
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

void filterCOLLECT(std::string &output)
{
    size_t i=0;
    while ((i = output.find("COLLECT_", i)) != std::string::npos) {
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

std::string Client::findInPath(const std::string &fn)
{
    assert(!fn.empty());
    assert(fn[0] != '/');
    const char *path = getenv("PATH");
    if (!path)
        return std::string();

    const char *begin = path, *end = 0;
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
                Client::parsePath(resolved, 0, &basename);
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
    return exec;
}

bool Client::findCompiler(const std::string &preresolved)
{
    // printf("PATH %s\n", path);
    std::string exec;
    if (preresolved.empty()) {
        std::string fn;
        parsePath(sData.argv[0], &fn, 0);
        exec = findInPath(fn);
    } else if (preresolved[0] != '/') {
        exec = findInPath(preresolved);
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
                sData.resolvedCompiler = p;
                return Stop;
            }
            return Continue;
        });
    }
    if (sData.resolvedCompiler.empty())
        sData.resolvedCompiler = exec;
    {
        auto findSlaveCompiler = [](const std::string &path) {
            size_t slash = path.rfind('/');
            if (slash == std::string::npos)
                slash = 0;
            const char *ch = &path[slash];
            while (*ch) {
                if (*ch == 'g') {
                    if (!strncmp(ch + 1, "++", 2)) {
                        sData.slaveCompiler =  "/usr/bin/g++";
                        return true;
                    } else if (!strncmp(ch + 1, "cc", 2)) {
                        sData.slaveCompiler =  "/usr/bin/gcc";
                        return true;
                    }
                } else if (*ch == 'c') {
                    if (!strncmp(ch + 1, "lang", 4)) {
                        if (!strncmp(ch + 5, "++", 2)) {
                            sData.slaveCompiler =  "/usr/bin/clang++";
                            return true;
                        } else {
                            sData.slaveCompiler =  "/usr/bin/clang";
                            return true;
                        }
                    }
                }
                ++ch;
            }
            return false;
        };
        if (!findSlaveCompiler(exec) && !findSlaveCompiler(sData.resolvedCompiler)) {
            sData.slaveCompiler = exec;
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
    // printf("RESULT %s %s %s\n", sData.resolvedCompiler.c_str(), sData.slaveCompiler.c_str(), exec.c_str());

    if (exec.size() >= 5 && !strcmp(exec.c_str() + exec.size() - 5, "fiskc")) { // resolved to ourselves
        // printf("WE'RE HERE %s %s %s\n", exec.c_str(), sData.slaveCompiler.c_str(), sData.resolvedCompiler.c_str());
        sData.slaveCompiler.clear();
        sData.resolvedCompiler.clear();
        return false;
    }
    sData.compiler = std::move(exec);
    struct stat st;
    return !stat(sData.compiler.c_str(), &st) && (S_ISREG(st.st_mode) || S_ISLNK(st.st_mode));
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

Client::Slot::Slot(Type type, sem_t *semaphore)
    : mType(type), mSemaphore(semaphore)
{
    if (semaphore) {
        sData.semaphores.insert(semaphore);
        DEBUG("Acquired %s semaphore on %s", typeToString(type), sData.compilerArgs ? sData.compilerArgs->sourceFile().c_str() : "");
    } else {
        DEBUG("Acquired %s slot without semaphore for %s", typeToString(type), sData.compilerArgs ? sData.compilerArgs->sourceFile().c_str() : "");
    }
}

Client::Slot::~Slot()
{
    if (mSemaphore) {
        DEBUG("Dropping %s semaphore on %s", typeToString(mType), sData.compilerArgs ? sData.compilerArgs->sourceFile().c_str() : "");
        sem_post(mSemaphore);
        sData.semaphores.erase(mSemaphore);
    }
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

std::unique_ptr<Client::Preprocessed> Client::preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args)
{
    const unsigned long long started = Client::mono();
    Preprocessed *ptr = new Preprocessed;
    std::unique_ptr<Client::Preprocessed> ret(ptr);
    ret->mThread = std::thread([ptr, args, compiler, started] {
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
        std::string depFile;
        std::string outputFile;
        bool hasDepFile = false;
        for (size_t i=1; i<count; ++i) {
            const std::string arg = args->commandLine.at(i);
            if (arg == "-o" && args->commandLine.size() > i + 1) {
                outputFile = args->commandLine.at(++i);
                continue;
            }

            commandLine += " '";
            append(args->commandLine.at(i));
            commandLine += '\'';

            if (arg == "-MMD" || arg == "-MD" || arg == "-MM" || arg == "-M") {
                hasDepFile = true;
            } else if (arg == "-MF" && i + 1 < count) {
                commandLine += " '";
                append(args->commandLine.at(++i));
                commandLine += '\'';
            }
        }
        commandLine += " '-E'";
        if (Client::data().slaveCompiler.find("clang") != std::string::npos) {
            commandLine += " '-frewrite-includes'";
        } else {
            commandLine += " '-fdirectives-only'";
        }
        if (!Config::discardComments) {
            commandLine += " '-C'";
        }

        if (hasDepFile) {
            if (depFile.empty()) {
                if (outputFile.empty())
                    outputFile = args->output();
                depFile = outputFile + "d";
            }
            DEBUG("Depfile is %s", depFile.c_str());
        }
        DEBUG("Acquiring preprocess slot: %s", commandLine.c_str());
        std::shared_ptr<Client::Slot> slot = Client::acquireSlot(Client::Slot::Cpp);
        ptr->slotDuration = Client::mono() - started;
        DEBUG("Running preprocess: %s", commandLine.c_str());
        if (args->flags & (CompilerArgs::CPreprocessed
                           |CompilerArgs::ObjectiveCPreprocessed
                           |CompilerArgs::ObjectiveCPlusPlusPreprocessed
                           |CompilerArgs::CPlusPlusPreprocessed)) {
            DEBUG("Already preprocessed. No need to do it");
            ptr->exitStatus = readFile(args->sourceFile(), ptr->stdOut) ? 0 : 1;
        } else {
            DEBUG("Executing:\n%s", commandLine.c_str());
            TinyProcessLib::Process proc(commandLine, std::string(),
                                         [ptr](const char *bytes, size_t n) {
                                             VERBOSE("Preprocess appending %zu bytes to stdout", n);
                                             ptr->stdOut.append(bytes, n);
                                         }, [ptr](const char *bytes, size_t n) {
                                             VERBOSE("Preprocess appending %zu bytes to stderr", n);
                                             ptr->stdErr.append(bytes, n);
                                         });
            VERBOSE("Preprocess calling get_status");
            ptr->exitStatus = proc.get_exit_status();
            DEBUG("Preprocess got status %d", ptr->exitStatus);
            if (Config::objectCache) {
                const char *ch = ptr->stdOut.c_str();
                const char *last = ch;
                while (*ch) {
                    // VERBOSE("GETTING CHAR [%c]", *ch);
                    if (*ch == '#' && ch[1] == ' ' && std::isdigit(ch[2])) {
                        if (ch > last) {
                            VERBOSE("Adding to MD5:\n%.*s\n", static_cast<int>(ch - last), last);
                            MD5_Update(&Client::data().md5, last, ch - last);
                        }
                        while (*ch && *ch != '\n')
                            ++ch;
                        last = ch;
                    } else {
                        ++ch;
                    }
                }
                if (last < ch) {
                    VERBOSE("Adding to MD5:\n%.*s\n", static_cast<int>(ch - last), last);
                    MD5_Update(&Client::data().md5, last, ch - last);
                }
            }
        }
        slot.reset();
        std::unique_lock<std::mutex> lock(ptr->mMutex);
        ptr->mDone = true;
        ptr->cppSize = ptr->stdOut.size();
        ptr->duration = Client::mono() - started;
        ptr->mCond.notify_one();
        if (hasDepFile)
            ptr->depFile = std::move(depFile);
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

std::unique_ptr<Client::Slot> Client::acquireSlot(Client::Slot::Type type)
{
    const size_t slots = Slot::slots(type);
    if (!slots)
        return std::unique_ptr<Client::Slot>();

    sem_t *sem = sem_open(Client::Slot::typeToString(type), O_CREAT, 0666, slots);
    if (!sem) {
        ERROR("Failed to open semaphore %s for %zu slots: %d %s",
              Client::Slot::typeToString(type), slots, errno, strerror(errno));
        return std::unique_ptr<Client::Slot>(new Client::Slot(type, nullptr));
    }
    int ret;
    EINTRWRAP(ret, sem_wait(sem));

    if (Log::minLogLevel <= Log::Debug) {
#ifdef __linux__
        int val = -1;
        sem_getvalue(sem, &val);
        Log::debug("Opened semaphore %s for %zu slots (value %d)", Client::Slot::typeToString(type), slots, val);
#else
        Log::debug("Opened semaphore %s for %zu slots", Client::Slot::typeToString(type), slots);
#endif
    }

    assert(!ret);
    return std::unique_ptr<Client::Slot>(new Client::Slot(type, sem));
}

void Client::writeStatistics()
{
    if (sData.localReason == CompilerArgs::Local_Preprocess)
        return;
    const std::string file = Config::statisticsLog;
    if (file.empty())
        return;

    const Client::Data &data = Client::data();
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
        int written = data.totalWritten;
        if (!written) {
            const std::string output = data.compilerArgs->output();
            if (!stat(output.c_str(), &st)) {
                written = st.st_size;
            }
        }
        if (written)
            stats["output_size"] = written;
    } else {
        stats["local"] = CompilerArgs::localReasonToString(sData.localReason);
        stats["command_line"] = data.originalArgs;
    }
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
    int ret;
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

std::unique_ptr<Client::Slot> Client::tryAcquireSlot(Client::Slot::Type type)
{
    const size_t slots = Slot::slots(type);
    if (!slots)
        return std::unique_ptr<Client::Slot>();

    sem_t *sem = sem_open(Client::Slot::typeToString(type), O_CREAT, 0666, slots);
    if (!sem) {
        ERROR("Failed to open semaphore %s for %zu slots: %d %s",
              Client::Slot::typeToString(type), slots, errno, strerror(errno));
        return std::unique_ptr<Client::Slot>(new Client::Slot(type, nullptr));
    }
    int ret = sem_trywait(sem);
    if (!ret) {
        return std::unique_ptr<Client::Slot>(new Client::Slot(type, sem));
    }
    return std::unique_ptr<Client::Slot>();
}

static std::string argsAsString()
{
    std::string ret = sData.compiler;
    for (int i=1; i<sData.argc; ++i) {
        ret += ' ';
        ret += sData.argv[i];
    }
    return ret;
}

void Client::runLocal(std::unique_ptr<Slot> &&slot, const std::string &reason)
{
    enum { Increment = 75000 };
    auto run = [&reason]() {
        char **argvCopy = new char*[sData.argc + 1];
        argvCopy[0] = strdup(sData.compiler.c_str());
        for (int i=1; i<sData.argc; ++i) {
            argvCopy[i] = sData.argv[i];
        }
        argvCopy[sData.argc] = 0;
        size_t micros = 0;
        while (true) {
            WARN("Running local: %s because %s", argsAsString().c_str(), reason.c_str());
            ::execv(sData.compiler.c_str(), argvCopy);
            if (micros < Increment * 10)
                micros += Increment;
            ERROR("Trying execv(%s) again in %zu ms errno: %d %s", sData.compiler.c_str(), micros / 1000, errno, strerror(errno));
            usleep(75000);
        }
        ERROR("fisk: Failed to exec %s (%d %s)", sData.compiler.c_str(), errno, strerror(errno));
    };

    pid_t pid;
    size_t micros = 0;
    while (true) {
        pid = fork();
        if (pid == -1 && errno == EAGAIN) {
            if (micros < Increment * 10)
                micros += Increment;
            ERROR("Fork failed (%s) again errno: %d %s. Trying again... in %zums",
                  sData.compiler.c_str(), errno, strerror(errno), micros / 1000);
            usleep(micros);
        } else {
            break;
        }
    }
    if (pid == -1) { // errpr
        ERROR("Failed to fork: %d %s", errno, strerror(errno));
        slot.reset();
        run();
        exit(101);
    } else if (pid == 0) { // child
        run();
        exit(102);
    } else { // paren
        int ret, status;
        EINTRWRAP(ret, waitpid(pid, &status, 0));
        slot.reset();
        writeStatistics();
        if (WIFEXITED(status))
            _exit(WEXITSTATUS(status));
        _exit(103);
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

        out += err;
        filterCOLLECT(out);
        return Client::toHex(Client::sha1(out));
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

std::string Client::base64(const std::string &src)
{
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO *sink = BIO_new(BIO_s_mem());
    BIO_push(b64, sink);
    BIO_write(b64, &src[0], src.size());
    BIO_flush(b64);
    const char *encoded;
    const long len = BIO_get_mem_data(sink, &encoded);
    std::string ret(encoded, len);
    BIO_free(b64);
    BIO_free(sink);
    return ret;
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

bool Client::uploadEnvironment(SchedulerWebSocket *schedulerWebSocket, const std::string &tarball)
{
    FILE *f = fopen(tarball.c_str(), "r");
    std::string dir;
    Client::parsePath(tarball, 0, &dir);
    if (!f) {
        ERROR("Failed to open %s for reading: %d %s", tarball.c_str(), errno, strerror(errno));
        Client::recursiveRmdir(dir);
        return false;
    }
    struct stat st;
    if (stat(tarball.c_str(), &st)) {
        ERROR("Failed to stat %s: %d %s", tarball.c_str(), errno, strerror(errno));
        fclose(f);
        Client::recursiveRmdir(dir);
        return false;
    }
    {
        json11::Json::object msg {
            { "type", "uploadEnvironment" },
            { "hash", sData.hash },
            { "bytes", static_cast<int>(st.st_size) }
        };

        std::string json = json11::Json(msg).dump();
        schedulerWebSocket->send(WebSocket::Text, json.c_str(), json.size());
        Select select;
        select.add(schedulerWebSocket);
        char buf[1024 * 256];
        size_t sent = 0;
        do {
            const size_t chunkSize = std::min<size_t>(st.st_size - sent, sizeof(buf));
            if (fread(buf, 1, chunkSize, f) != chunkSize) {
                ERROR("Failed to read from %s: %d %s", tarball.c_str(), errno, strerror(errno));
                fclose(f);
                Client::recursiveRmdir(dir);
                return false;
            }
            schedulerWebSocket->send(WebSocket::Binary, buf, chunkSize);
            DEBUG("Sending %zu bytes %zu/%zu sent", chunkSize, sent, static_cast<size_t>(st.st_size));
            while (schedulerWebSocket->hasPendingSendData() && schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket)
                select.exec();
            sent += chunkSize;
        } while (sent < static_cast<size_t>(st.st_size) && schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket);
    }
    fclose(f);
    Client::recursiveRmdir(dir);
    return schedulerWebSocket->state() == SchedulerWebSocket::ConnectedWebSocket;
}

extern "C" const unsigned char create_fisk_env[];
extern "C" const unsigned create_fisk_env_size;
std::string Client::prepareEnvironmentForUpload()
{
    char dir[PATH_MAX];
    strcpy(dir, "/tmp/fisk-env-XXXXXX");
    if (!mkdtemp(dir)) {
        ERROR("Failed to mkdtemp %d %s", errno, strerror(errno));
        return std::string();
    }

    // printf("GOT DIR %s\n", dir);

    const std::string info = Client::format("%s/compiler-info_%s", dir, sData.hash.c_str());
    FILE *f = fopen(info.c_str(), "w");
    if (!f) {
        ERROR("Failed to create info file: %s %d %s", info.c_str(), errno, strerror(errno));
        Client::recursiveMkdir(dir);
        return std::string();
    }

    fprintf(f, "{ \"hash\": \"%s\", \"system\": \"%s\", \"originalPath\": \"%s\" }\n",
            sData.hash.c_str(), systemName, sData.resolvedCompiler.c_str());

    {
        std::string stdOut, stdErr;
        TinyProcessLib::Process proc(sData.resolvedCompiler + " -v", dir,
                                     [&stdOut](const char *bytes, size_t n) { stdOut.append(bytes, n); },
                                     [&stdErr](const char *bytes, size_t n) { stdErr.append(bytes, n); });
        const int exit_status = proc.get_exit_status();
        if (exit_status) {
            ERROR("Failed to run %s -v\n%s", sData.resolvedCompiler.c_str(), stdErr.c_str());
            fclose(f);
            Client::recursiveMkdir(dir);
            return std::string();
        }
        stdOut += stdErr;
        filterCOLLECT(stdOut);
        int w;
        EINTRWRAP(w, fwrite(stdOut.c_str(), 1, stdOut.size(), f));
        if (w != static_cast<int>(stdOut.size())) {
            ERROR("Failed to write to %s: %d %s", info.c_str(), errno, strerror(errno));
            fclose(f);
            Client::recursiveMkdir(dir);
            return std::string();
        }
        fclose(f);
    }


    {
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
                                  sData.resolvedCompiler.c_str(),
                                  info.c_str()));
        proc.write(reinterpret_cast<const char *>(create_fisk_env), create_fisk_env_size);
        DEBUG("Running create-fisk-env %s --addfile %s:/etc/compiler_info", sData.resolvedCompiler.c_str(), info.c_str());
        proc.close_stdin();
        const int exit_status = proc.get_exit_status();
        if (exit_status) {
            ERROR("Failed to run create-fisk-env: %s", stdErr.c_str());
            Client::recursiveMkdir(dir);
            return std::string();
        }
        if (stdOut.size() > 1 && stdOut[stdOut.size() - 1] == '\n')
            stdOut.resize(stdOut.size() - 1);
        const size_t idx = stdOut.rfind("\ncreating ");
        if (idx == std::string::npos) {
            ERROR("Failed to parse stdout of create-fisk-env:\n%s", stdOut.c_str());
            Client::recursiveMkdir(dir);
            return std::string();
        }
        std::string tarball = Client::format("%s/%s", dir, stdOut.substr(idx + 10).c_str());
        return tarball;
    }
    return std::string();
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

