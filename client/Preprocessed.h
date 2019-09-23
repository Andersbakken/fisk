#ifndef PREPROCESSED_H
#define PREPROCESSED_H

#include "Select.h"
#include <thread>
#include <string>
#include <mutex>
#include <condition_variable>

struct CompilerArgs;
class DaemonSocket;
class Preprocessed
{
public:
    ~Preprocessed();
    bool done() const;

    std::string stdOut, stdErr;
    size_t cppSize { 0 };
    int exitStatus { -1 };
    unsigned long long duration { 0 };
    unsigned long long slotDuration { 0 };

    static std::unique_ptr<Preprocessed> create(const std::string &compiler,
                                                const std::shared_ptr<CompilerArgs> &args,
                                                Select &select,
                                                DaemonSocket &daemonSocket);
private:
    Preprocessed();
    mutable std::mutex mMutex;
    std::condition_variable mCond;
    std::thread mThread;
    bool mDone { false };
    bool mJoined { false };
};

#endif /* PREPROCESSED_H */
