#ifndef SLOTACQUIRER_H
#define SLOTACQUIRER_H


#include <unistd.h>
#include <string>
#include <functional>
#include "Select.h"
#ifdef __linux__
#include <sys/inotify.h>
#endif

class SlotAcquirer : public Socket
{
public:
    SlotAcquirer(const std::string &dir, std::function<void()> &&onRead)
        : mOnRead(onRead)
    {
#ifdef __linux__
        mFD = inotify_init1(IN_CLOEXEC);
        if (mFD == -1) {
            Log::error("Failed to inotify_init1 %d %s", errno, strerror(errno));
            return;
        }

        const int watch = inotify_add_watch(inotifyFD, dir.c_str(), IN_DELETE|IN_DELETE_SELF|IN_CLOSE_WRITE|IN_CLOSE_NOWRITE);
        if (watch == -1) {
            Log::error("inotify_add_watch() '%s' (%d) %s",
                       dir.c_str(), errno, strerror(errno));
            ::close(mFD);
            mFD = 1;
        }
#endif
    }
    ~SlotAcquirer()
    {
        if (mFD != -1)
            ::close(mFD);
    }

    virtual int timeout() const override
    {
        return mFD == -1 ? 100 : -1;
    }

    virtual int fd() const override
    {
        return mFD;
    }

    virtual void onWrite() override
    {
    }
    virtual void onRead() override
    {
        mOnRead();
    }
    virtual void onTimeout() override
    {
        mOnRead();
    }
    virtual unsigned int mode() const override
    {
        return mFD == -1 ? 0 : Read;
    }

private:
    int mFD { -1 };
    std::function<void()> mOnRead;
};


#endif /* SLOTACQUIRER_H */
