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
    SlotAcquirer(const std::string &dir, std::function<void(const std::string &)> &&onRead)
        : mDir(dir), mOnRead(onRead)
    {
        assert(!dir.empty() && dir[dir.size() - 1] == '/');
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
        auto dumpEvent = [](int mask) -> std::string {
            std::string ret;
            if (mask & IN_ACCESS) {
                ret += "IN_ACCESS|";
            }
            if (mask & IN_MODIFY) {
                ret += "IN_MODIFY|";
            }
            if (mask & IN_ATTRIB) {
                ret += "IN_ATTRIB|";
            }
            if (mask & IN_CLOSE_WRITE) {
                ret += "IN_CLOSE_WRITE|";
            }
            if (mask & IN_CLOSE_NOWRITE) {
                ret += "IN_CLOSE_NOWRITE|";
            }
            if (mask & IN_OPEN) {
                ret += "IN_OPEN|";
            }
            if (mask & IN_MOVED_FROM) {
                ret += "IN_MOVED_FROM|";
            }
            if (mask & IN_MOVED_TO) {
                ret += "IN_MOVED_TO|";
            }
            if (mask & IN_CREATE) {
                ret += "IN_CREATE|";
            }
            if (mask & IN_DELETE) {
                ret += "IN_DELETE|";
            }
            if (mask & IN_DELETE_SELF) {
                ret += "IN_DELETE_SELF|";
            }
            if (mask & IN_MOVE_SELF) {
                ret += "IN_MOVE_SELF|";
            }
            if (mask & IN_UNMOUNT) {
                ret += "IN_UNMOUNT|";
            }
            if (mask & IN_Q_OVERFLOW) {
                ret += "IN_Q_OVERFLOW|";
            }
            if (mask & IN_IGNORED) {
                ret += "IN_IGNORED|";
            }
            if (mask & IN_ONLYDIR) {
                ret += "IN_ONLYDIR|";
            }
            if (mask & IN_DONT_FOLLOW) {
                ret += "IN_DONT_FOLLOW|";
            }
            if (mask & IN_EXCL_UNLINK) {
                ret += "IN_EXCL_UNLINK|";
            }
            if (mask & IN_MASK_ADD) {
                ret += "IN_MASK_ADD|";
            }
            if (mask & IN_ISDIR) {
                ret += "IN_ISDIR|";
            }
            if (mask & IN_ONESHOT) {
                ret += "IN_ONESHOT|";
            }
            if (!ret.empty()) {
                ret.resize(ret.size() - 1);
            }
            return ret;
        };
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
                DEBUG("inotify_event %s 0x%x %s\n", event->name, event->mask, dumpEvent(event->mask).c_str());
                if (event->mask & IN_CLOSE) {
                    mOnRead(event->name);
                }
            }
            return;
        }
#else
#warning need to write this code on mac
#endif
        printf("CALLING onread\n");
        mOnRead(std::string());
    }
    virtual void onTimeout() override
    {
        mOnRead(std::string());
    }
    virtual unsigned int mode() const override
    {
        return mFD == -1 ? 0 : Read;
    }

private:
    std::string mDir;
    int mFD { -1 };
    std::function<void(const std::string &)> mOnRead;
};


#endif /* SLOTACQUIRER_H */
