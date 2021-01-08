#include "Preprocessed.h"
#include "Client.h"
#include "DaemonSocket.h"
#include <process.hpp>

Preprocessed::Preprocessed()
{
}

Preprocessed::~Preprocessed()
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

bool Preprocessed::done() const
{
    std::unique_lock<std::mutex> lock(mMutex);
    return mDone;
}

std::unique_ptr<Preprocessed> Preprocessed::create(const std::string &compiler,
                                                   const std::shared_ptr<CompilerArgs> &args,
                                                   Select &select,
                                                   DaemonSocket &daemonSocket)
{
    const unsigned long long started = Client::mono();
    Preprocessed *ptr = new Preprocessed;
    std::unique_ptr<Preprocessed> ret(ptr);
    ret->mThread = std::thread([ptr, args, compiler, started, &daemonSocket, &select] {
        std::string out, err;
        ptr->stdOut.reserve(1024 * 1024);
        std::string commandLine = compiler;
        const size_t count = args->commandLine.size();
        for (size_t i=1; i<count; ++i) {
            const std::string arg = args->commandLine.at(i);
            if (arg == "-o" && args->commandLine.size() > i + 1) {
                ++i;
                continue;
            }

            commandLine += " '";
            commandLine += args->commandLine.at(i);
            commandLine += '\'';
        }
        commandLine += " '-E'";
        if (Client::data().builderCompiler.find("clang") != std::string::npos) {
            commandLine += " '-frewrite-includes'";
        } else {
            commandLine += " '-fdirectives-only'";
        }
        if (!Config::discardComments) {
            commandLine += " '-C'";
        }

        DEBUG("Acquiring preprocess slot: %s", commandLine.c_str());

        if (!daemonSocket.waitForCppSlot()) {
            ptr->exitStatus = 2;
        } else {
            ptr->slotDuration = Client::mono() - started;
            DEBUG("Running preprocess: %s", commandLine.c_str());
            if (args->flags & (CompilerArgs::CPreprocessed
                               |CompilerArgs::ObjectiveCPreprocessed
                               |CompilerArgs::ObjectiveCPlusPlusPreprocessed
                               |CompilerArgs::CPlusPlusPreprocessed)) {
                DEBUG("Already preprocessed. No need to do it");
                ptr->exitStatus = Client::readFile(args->sourceFile(), ptr->stdOut) ? 0 : 1;
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
        }
        {
            std::unique_lock<std::mutex> lock(ptr->mMutex);
            ptr->mDone = true;
            ptr->cppSize = ptr->stdOut.size();
            ptr->duration = Client::mono() - started;
            ptr->mCond.notify_one();
        }
        select.wakeup();
    });
    return ret;
}
