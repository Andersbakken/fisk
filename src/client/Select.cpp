#include "Select.h"

Socket::~Socket()
{
    if (mSelect) {
        mSelect->remove(this);
    }
}

int Select::exec(int timeoutMs) const
{
    fd_set rMaster, wMaster;
    FD_ZERO(&rMaster);
    FD_ZERO(&wMaster);
    int max = mPipe[0];
    FD_SET(mPipe[0], &rMaster);
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
            FD_SET(fd, &rMaster);
        }
        if (mode & Socket::Write) {
            FD_SET(fd, &wMaster);
        }
    }
    // select() mutates the read/write fd_sets in place (and leaves them
    // in an unspecified state on error), so retry from a fresh copy on
    // EINTR rather than feeding the (now indeterminate) sets back in.
    fd_set r, w;
    int ret;
    do {
        r = rMaster;
        w = wMaster;
        struct timeval t = {};
        struct timeval *timeout = timeoutMs == -1 ? nullptr : &t;
        if (timeout) {
            timeout->tv_sec = timeoutMs / 1000;
            timeout->tv_usec = (timeoutMs % 1000) * 1000;
        }
        ret = select(max + 1, &r, &w, nullptr, timeout);
    } while (ret == -1 && errno == EINTR);
    if (ret == -1) {
        ERROR("Select failed %d %s", errno, strerror(errno));
        return -1;
    }

    const unsigned long long after = Client::mono();
    VERBOSE("Woke up from select timeout %dms after %llums with %d sockets fired", timeoutMs, after - before, ret);

    if (FD_ISSET(mPipe[0], &r)) {
        --ret;
        char ch;
        ssize_t readRet;
        do {
            readRet = ::read(mPipe[0], &ch, 1);
        } while (readRet == -1 && errno == EINTR);
    }

    // Snapshot before dispatching: a callback may destroy a Socket, and ~Socket
    // erases itself from mSockets, which would invalidate the iterator underneath
    // us and desynchronise the parallel timeouts vector.
    const std::vector<Socket *> sockets(mSockets.begin(), mSockets.end());
    assert(sockets.size() == timeouts.size());
    for (size_t idx = 0; idx < sockets.size() && idx < timeouts.size(); ++idx) {
        Socket *socket = sockets[idx];
        if (!mSockets.count(socket)) {
            continue;
        }
        // Timeouts have to be evaluated whether or not any fd fired. Only the
        // Watchdog reports a timeout and it has no fd, so gating this on ret == 0
        // meant a single readable or writable socket could starve it forever, and
        // once its timeout hit zero select() returned immediately every time.
        if (timeouts[idx] >= 0 && after >= static_cast<unsigned long long>(timeouts[idx]) + before) {
            socket->onTimeout();
            if (!mSockets.count(socket)) {
                continue;
            }
        }
        if (ret > 0) {
            const int fd = socket->fd();
            if (fd != -1) {
                if (FD_ISSET(fd, &r)) {
                    socket->onRead();
                    if (!mSockets.count(socket)) {
                        continue;
                    }
                }
                if (FD_ISSET(fd, &w)) {
                    socket->onWrite();
                }
            }
        }
    }

    return ret;
}

void Select::wakeup()
{
    if (mPipe[1] != -1) {
        DEBUG("Waking up with pipe");
        ssize_t err;
        EINTRWRAP(err, write(mPipe[1], "w", 1));
    } else {
        DEBUG("Pipe not there");
    }
}
