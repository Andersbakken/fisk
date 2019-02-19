#include "Select.h"

int Select::exec(int timeoutMs) const
{
    fd_set r, w;
    FD_ZERO(&r);
    FD_ZERO(&w);
    int max = mPipe[0];
    FD_SET(mPipe[0], &r);
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
            timeout->tv_usec = (timeoutMs % 1000) * 1000;
        }
        ret = select(max + 1, &r, &w, 0, timeout);
    } while (ret == EINTR);
    if (ret == -1) {
        ERROR("Select failed %d %s", errno, strerror(errno));
        return -1;
    }

    const unsigned long long after = Client::mono();
    VERBOSE("Woke up from select timeout %dms after %llums with %d sockets fired",
            timeoutMs, after - before, ret);

    size_t idx = 0;
    if (FD_ISSET(mPipe[0], &r)) {
        --ret;
        char ch;
        int readRet;
        do {
            readRet = ::read(mPipe[0], &ch, 1);
        } while (readRet == -1 && errno == EINTR);
    }
    for (Socket *socket : mSockets) {
        if (!ret) {
            if (timeouts[idx] >= 0) {
                const unsigned long long socketTimeout = timeouts[idx] + before;
                if (after >= socketTimeout)
                    socket->onTimeout();
            }
            ++idx;
        } else {
            const int fd = socket->fd();
            if (fd != -1) {
                if (FD_ISSET(fd, &r))
                    socket->onRead();
                if (FD_ISSET(fd, &w))
                    socket->onWrite();
            }
        }
    }

    return ret;
}

void Select::wakeup()
{
    if (mPipe[1] != -1) {
        DEBUG("Waking up with pipe");
        int err;
        EINTRWRAP(err, write(mPipe[1], "w", 1));
    } else {
        DEBUG("Pipe not there");
    }
}
