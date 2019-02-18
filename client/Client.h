#ifndef CLIENT_H
#define CLIENT_H

#include "Config.h"
#include "CompilerArgs.h"
#include "Log.h"
#include <assert.h>
#include <condition_variable>
#include <cstdarg>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <openssl/md5.h>

#include <semaphore.h>
#include <set>
#include <string.h>
#include <string>
#include <sys/stat.h>
#include <sys/stat.h>
#include <thread>
#include <vector>

#define EINTRWRAP(VAR, BLOCK) do { VAR = BLOCK; } while (VAR == -1 && errno == EINTR)

class Watchdog;
class SchedulerWebSocket;
namespace Client {
class Preprocessed;
struct Data
{
    ~Data() {}

    int argc { 0 };
    char **argv { 0 };
    std::vector<std::string> originalArgs;
    bool maintainSemaphores { false };
    std::string compiler; // this is the next one on the path and the one we will exec if we run locally
    std::string resolvedCompiler; // this one resolves g++ to gcc and is used for generating hash
    std::string slaveCompiler; // this is the one that actually will exist on the slave
    std::string hash;
    bool objectCache { false };
    int exitCode { 0 };
    std::set<sem_t *> semaphores;
    size_t totalWritten { 0 };

    std::unique_ptr<Preprocessed> preprocessed;
    std::shared_ptr<CompilerArgs> compilerArgs;
    Watchdog *watchdog { 0 };
    CompilerArgs::LocalReason localReason { CompilerArgs::Remote };

    std::string commandLineAsString() const;

    MD5state_st md5 = []() {
        MD5state_st ret;
        MD5_Init(&ret);
        return ret;
    }();
};
Data &data();

extern const unsigned long long started;
extern const unsigned long long milliseconds_since_epoch;

std::mutex &mutex();
bool findCompiler(const std::string &preresolved);
std::string findInPath(const std::string &fn);
void parsePath(const char *path, std::string *basename, std::string *dirname);
inline void parsePath(const std::string &path, std::string *basename, std::string *dirname)
{
    return parsePath(path.c_str(), basename, dirname);
}
class Slot
{
public:
    enum Type {
        DesiredCompile,
        Compile,
        Cpp
    };

    Slot(Type type, sem_t *sem);
    ~Slot();
    static constexpr const char *typeToString(Type type)
    {
        return (type == Compile ? "/fisk.compile" : (type == DesiredCompile ? "/fisk.desiredCompile" : "/fisk.cpp"));
    }
    static size_t slots(Type type)
    {
        switch (type) {
        case Compile:
            return Config::compileSlots;
        case Cpp:
            return Config::cppSlots;
        case DesiredCompile:
            return Config::desiredCompileSlots;
        }
        assert(0);
        return 0;
    }
private:
    Slot(const Slot &) = delete;
    Slot &operator=(const Slot &) = delete;

    const Type mType;
    sem_t *mSemaphore;
};

std::unique_ptr<Slot> tryAcquireSlot(Slot::Type type);
std::unique_ptr<Slot> acquireSlot(Slot::Type type);
void writeStatistics();
[[noreturn]] void runLocal(std::unique_ptr<Slot> &&slot, const std::string &reason);
unsigned long long mono();
bool setFlag(int fd, int flag);
bool recursiveMkdir(const std::string &path, mode_t mode = S_IRWXU);
bool recursiveRmdir(const std::string &path);
std::string realpath(const std::string &path);

class Preprocessed
{
public:
    ~Preprocessed();
    void wait();

    std::string stdOut, stdErr;
    size_t cppSize { 0 };
    int exitStatus { -1 };
    unsigned long long duration { 0 };
    unsigned long long slotDuration { 0 };
private:
    std::mutex mMutex;
    std::condition_variable mCond;
    std::thread mThread;
    bool mDone { false };
    bool mJoined { false };
    friend std::unique_ptr<Preprocessed> preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args);
};
std::unique_ptr<Preprocessed> preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args);

template <size_t StaticBufSize = 4096>
inline static std::string vformat(const char *format, va_list args)
{
    va_list copy;
    va_copy(copy, args);

    char buffer[StaticBufSize];
    const size_t size = ::vsnprintf(buffer, StaticBufSize, format, args);
    assert(size >= 0);
    std::string ret;
    if (size < StaticBufSize) {
        ret.assign(buffer, size);
    } else {
        ret.resize(size);
        ::vsnprintf(&ret[0], size+1, format, copy);
    }
    va_end(copy);
    return ret;
}

template <size_t StaticBufSize = 4096>
inline std::string format(const char *fmt, ...) __attribute__ ((__format__ (__printf__, 1, 2)));

template <size_t StaticBufSize>
inline std::string format(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    std::string ret = vformat<StaticBufSize>(fmt, args);
    va_end(args);
    return ret;
}

enum CaseSensitivity {
    CaseInsensitive,
    CaseSensitive
};
inline bool endsWith(const std::string &haystack, const std::string &needle, CaseSensitivity cs = CaseSensitive)
{
    if (needle.size() > haystack.size())
        return false;
    if (cs == CaseSensitive) {
        return !strcmp(haystack.c_str() + (haystack.length() - needle.length()), needle.c_str());
    } else {
        return !strcasecmp(haystack.c_str() + (haystack.length() - needle.length()), needle.c_str());
    }
}

inline std::string sha1(const std::string &str)
{
    std::string res(SHA_DIGEST_LENGTH, ' ');
    SHA1(reinterpret_cast<const unsigned char *>(str.c_str()), str.size(), reinterpret_cast<unsigned char *>(&res[0]));
    return res;
}

std::string base64(const std::string &src);
inline std::string toHex(const void *t, size_t s)
{
    std::string ret(s * 2, ' ');
    const unsigned char *in = reinterpret_cast<const unsigned char *>(t);
    const unsigned char hex[] = "0123456789ABCDEF";
    unsigned char *out = reinterpret_cast<unsigned char *>(&ret[0]);
    while (s--) {
        assert(in);
        assert(out);
        *out++ = hex[(*in) >> 4];
        assert(isprint(hex[(*in) >> 4]));

        assert(out);
        *out++ = hex[(*in) & 0x0F];
        assert(isprint(hex[(*in) & 0x0F]));
        ++in;
    }

    return ret;
}

inline std::string toHex(const std::string &src)
{
    return toHex(src.c_str(), src.size());
}

inline std::vector<std::string> split(const std::string &str, const std::string &delim)
{
    std::vector<std::string> ret;
    size_t start = 0U;
    size_t end = str.find(delim);
    while (end != std::string::npos) {
        ret.push_back(str.substr(start, end - start));
        start = end + delim.length();
        end = str.find(delim, start);
    }
    return ret;
}

enum FileType {
    File,
    Directory,
    Symlink,
    Invalid
};

inline FileType fileType(const std::string &path, struct stat *st = 0)
{
    struct stat dummy;
    struct stat &stat = st ? *st : dummy;
    memset(&stat, 0, sizeof(struct stat));
    if (lstat(path.c_str(), &stat)) {
        printf("ERR [%s] %d %s\n", path.c_str(), errno, strerror(errno));
        return Invalid;
    }

    if (S_ISLNK(stat.st_mode))
        return Symlink;
    if (S_ISDIR(stat.st_mode))
        return Directory;
    if (S_ISREG(stat.st_mode))
        return File;
    printf("BAD MODE %d\n", stat.st_mode);
    return Invalid;
}

template <typename T>
inline bool readFile(const std::string &fileName, T &t, bool *opened = nullptr, std::string *error = nullptr)
{
#ifdef READFILE_ERR
#error Do not define READFILE_ERR
#endif
#define READFILE_ERR(...)                           \
    do {                                            \
        if (error) {                                \
            *error = Client::format(__VA_ARGS__);   \
        } else {                                    \
            ERROR(__VA_ARGS__);                     \
        }                                           \
        if (f) {                                    \
            int r;                                  \
            EINTRWRAP(r, fclose(f));                \
        }                                           \
        return false;                               \
    } while (false)

    FILE *f;
    do {
        f = fopen(fileName.c_str(), "r");
    } while (!f && errno == EINTR);


    if (opened)
        *opened = f;

    if (!f)
        READFILE_ERR("Failed to open %s for reading (%d %s)", fileName.c_str(), errno, strerror(errno));

    {
        int ret;
        EINTRWRAP(ret, fseek(f, 0, SEEK_END));
        if (ret)
            READFILE_ERR("Failed to fseek to end of %s (%d %s)", fileName.c_str(), errno, strerror(errno));
    }

    int size;
    EINTRWRAP(size, ftell(f));
    if (size < 0) {
        READFILE_ERR("Failed to ftell %s (%d %s)", fileName.c_str(), errno, strerror(errno));
        return false;
    }

    {
        int ret;
        EINTRWRAP(ret, fseek(f, 0, SEEK_SET));
        if (ret)
            READFILE_ERR("Failed to fseek to beginning of %s (%d %s)", fileName.c_str(), errno, strerror(errno));
    }

    t.resize(size);
    int read;
    EINTRWRAP(read, fread(&t[0], sizeof(char), t.size(), f));
    if (read != size)
        READFILE_ERR("Failed to read from %s (%d %s)", fileName.c_str(), errno, strerror(errno));

    {
        int ret;
        EINTRWRAP(ret, fclose(f));
    }

    return true;
}

std::string environmentHash(const std::string &compiler);
std::string findExecutablePath(const char *argv0);
bool uploadEnvironment(SchedulerWebSocket *schedulerWebSocket, const std::string &tarball);
std::string prepareEnvironmentForUpload();
bool isAtty();
}

#endif /* CLIENT_H */
