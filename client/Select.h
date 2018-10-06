#ifndef SELECT_H
#define SELECT_H

#include <assert.h>
#include <errno.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>
#include <functional>
#include <map>
#include <set>

#include "Client.h"
#include "Log.h"

class Select;

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
    virtual int timeout() = 0;
    void wakeup();
private:
    Select *mSelect { nullptr };
    friend class Select;
};

class Select
{
public:
    Select()
    {
        if (pipe(mPipe) == -1) {
            mPipe[0] = mPipe[1] = -1;
        }
    }
    ~Select()
    {
        if (mPipe[0] != -1)
            ::close(mPipe[0]);
        if (mPipe[1] != -1)
            ::close(mPipe[1]);
        for (Socket *socket : mSockets) {
            assert(socket->mSelect == this);
            socket->mSelect = nullptr;
        }
    }
    void add(Socket *socket) { assert(!socket->mSelect); socket->mSelect = this; mSockets.insert(socket); }
    void remove(Socket *socket) { assert(socket->mSelect == this); socket->mSelect = nullptr; mSockets.erase(socket); }

    int exec(int timeoutMs = -1) const;
    void wakeup();
private:
    std::set<Socket *> mSockets;
    int mPipe[2];
};

inline void Socket::wakeup()
{
    assert(mSelect);
    mSelect->wakeup();
}

#endif /* SELECT_H */
