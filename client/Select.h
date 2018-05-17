#ifndef SELECT_H
#define SELECT_H

#include <set>
#include <map>
#include <functional>
#include <sys/select.h>
#include "Log.h"

struct Socket
{
    virtual ~Socket() {}
    virtual int fd() const = 0;
    virtual std::function<void()> write() const = 0;
    virtual std::function<void()> read() const = 0;
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
        std::map<int, std::pair<std::function<void()>, std::function<void()> > > fds;
        for (Socket *socket : mSockets) {
            auto read = socket->read();
            auto write = socket->read();
            if (!read && !write)
                continue;
            const int fd = socket->fd();
            max = std::max(fd, max);
            fds[fd] = std::make_pair(std::move(read), std::move(write));
            if (read) {
                FD_SET(fd, &r);
            }
            if (write) {
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
            Log::error("Select failed %d %s", errno, strerror(errno));
            return -1;
        }

        if (ret) {
            for (const auto &fd : fds) {
                if (FD_ISSET(fd.first, &r)) {
                    assert(fd.second.first);
                    fd.second.first();
                }
                if (FD_ISSET(fd.first, &w)) {
                    assert(fd.second.second);
                    fd.second.second();
                }
            }
        }
        return ret;
    }
private:
    std::set<Socket *> mSockets;
};


#endif /* SELECT_H */
