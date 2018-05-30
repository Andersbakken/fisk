#ifndef SLOTACQUIRER_H
#define SLOTACQUIRER_H


#include <unistd.h>
#include <string>
#include <functional>
#include "Select.h"
#ifdef __linux__
#include <sys/inotify.h>
#include <sys/ioctl.h>
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
            ERROR("Failed to inotify_init1 %d %s", errno, strerror(errno));
            return;
        }

        const int watch = inotify_add_watch(mFD, dir.c_str(), IN_DELETE|IN_DELETE_SELF|IN_CLOSE_WRITE|IN_CLOSE_NOWRITE);
        if (watch == -1) {
            ERROR("inotify_add_watch() '%s' (%d) %s",
                       dir.c_str(), errno, strerror(errno));
            ::close(mFD);
            mFD = -1;
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
        return mFD == -1 ? 100 : 1000; // check every 1000ms even with inotify
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
#ifdef __linux__
        if (mFD != -1) {
            int s = 0;
            ioctl(mFD, FIONREAD, &s);
            // printf("GOT %d bytes\n", s);
            if (!s)
                return;

            char buf[4096];
            const int read = ::read(mFD, buf, std::min<int>(s, sizeof(buf)));
            int idx = 0;
            while (idx < read) {
                inotify_event *event = reinterpret_cast<inotify_event*>(buf + idx);
                idx += sizeof(inotify_event) + event->len;
                DEBUG("inotify_event %s 0x%x", event->name, event->mask);
                // if (event->mask & (IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT)) {
                //     printf("[SlotAcquirer.h:%d]: if (event->mask & (IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT)) {\n", __LINE__); fflush(stdout);
                // } else if (event->mask & (IN_CREATE|IN_MOVED_TO)) {
                //     printf("[SlotAcquirer.h:%d]: } else if (event->mask & (IN_CREATE|IN_MOVED_TO)) {\n", __LINE__); fflush(stdout);
                // } else if (event->mask & (IN_DELETE|IN_MOVED_FROM)) {
                //     printf("[SlotAcquirer.h:%d]: } else if (event->mask & (IN_DELETE|IN_MOVED_FROM)) {\n", __LINE__); fflush(stdout);
                // } else if (event->mask & (IN_ATTRIB|IN_CLOSE_WRITE)) {
                //     printf("[SlotAcquirer.h:%d]: } else if (event->mask & (IN_ATTRIB|IN_CLOSE_WRITE)) {\n", __LINE__); fflush(stdout);
                // }
            }
        }
#endif
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
