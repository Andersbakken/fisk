#ifndef SELECT_H
#define SELECT_H

#include <set>
#include <map>
#include <errno.h>
#include <string.h>
#include <functional>
#include <sys/select.h>
#include "Log.h"
#include "Client.h"

struct Socket
{
    virtual ~Socket() {}
    enum Mode {
        None = 0x0,
        Read = 0x1,
        Write = 0x2
    };
    virtual int fd() const = 0;
    virtual unsigned int mode() const = 0;
    virtual void onWrite() = 0;
    virtual void onRead() = 0;
    virtual void onTimeout() = 0;
    virtual int timeout() const = 0;
};

class Select
{
public:
    Select() {}
    void add(Socket *socket) { mSockets.insert(socket); }
    void remove(Socket *socket) { mSockets.erase(socket); }

    int exec(int timeoutMs = -1) const
    {
        fd_set r, w;
        FD_ZERO(&r);
        FD_ZERO(&w);
        int max = -1;
        std::vector<int> timeouts;
        const unsigned long long before = Client::mono();
        for (Socket *socket : mSockets) {
            const int to = socket->timeout();
            if (to != -1 && (timeoutMs == -1 || to < timeoutMs))
                timeoutMs = to;
            timeouts.push_back(to);
            const int fd = socket->fd();
            if (fd == -1)
                continue;
            const unsigned int mode = socket->mode();
            if (!mode)
                continue;
            max = std::max(fd, max);
            if (mode & Socket::Read) {
                FD_SET(fd, &r);
            }
            if (mode & Socket::Write) {
                FD_SET(fd, &w);
            }
        }
        int ret;
        do {
            struct timeval t = {};
            struct timeval *timeout = timeoutMs == -1 ? 0 : &t;
            if (timeout) {
                timeout->tv_sec = timeoutMs / 1000;
                timeout->tv_usec = (timeoutMs % 1000) / 1000;
            }
            ret = select(max + 1, &r, &w, 0, timeout);
        } while (ret == EINTR);
        if (ret == -1) {
            ERROR("Select failed %d %s", errno, strerror(errno));
            return -1;
        }

        const unsigned long long after = ret ? 0 : Client::mono();
        size_t idx = 0;
        for (Socket *socket : mSockets) {
            if (!ret) {
                const unsigned long long socketTimeout = timeouts[idx++] + before;
                if (after >= socketTimeout)
                    socket->onTimeout();
            } else {
                const int fd = socket->fd();
                if (FD_ISSET(fd, &r))
                    socket->onRead();
                if (FD_ISSET(fd, &w))
                    socket->onWrite();
            }
        }

        return ret;
    }
private:
    std::set<Socket *> mSockets;
};


#endif /* SELECT_H */
