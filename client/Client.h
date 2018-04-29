#ifndef CLIENT_H
#define CLIENT_H

#include <string>
#include <cstdarg>
#include <assert.h>
#include <sys/stat.h>
#include <memory>
#include <mutex>

struct CompilerArgs;
namespace Client {
std::mutex &mutex();
std::string findCompiler(int argc, char **argv);
void parsePath(const char *path, std::string *basename, std::string *dirname);
class Slot
{
public:
    Slot(int fd, std::string &&path);
   ~Slot();
private:
    Slot(const Slot &) = delete;
    Slot &operator=(const Slot &) = delete;

    const int mFD;
    const std::string mPath;
};

enum AcquireSlotMode {
    Try,
    Wait
};
std::unique_ptr<Slot> acquireSlot(AcquireSlotMode mode);
int runLocal(const std::string &compiler, int argc, char **argv, std::unique_ptr<Slot> &&slot);
unsigned long long mono();
bool setFlag(int fd, int flag);
bool recursiveMkdir(const std::string &path, mode_t mode = S_IRWXU);

struct Preprocessed
{
    std::string stdOut, stdErr;
    int exitStatus;
};
Preprocessed preprocess(const std::string &compiler, const std::shared_ptr<CompilerArgs> &args);

template <size_t StaticBufSize = 4096>
static std::string format(const char *format, va_list args)
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

std::string compilerSignature(const std::string &compiler);
}

#endif /* CLIENT_H */
