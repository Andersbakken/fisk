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

    int exec(int timeoutMs = -1) const;
private:
    std::set<Socket *> mSockets;
};


#endif /* SELECT_H */
