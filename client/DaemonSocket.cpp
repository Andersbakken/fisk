#include "DaemonSocket.h"
#include "Config.h"
#include "Client.h"
#include <json11.hpp>
#include "Watchdog.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <arpa/inet.h>

DaemonSocket::DaemonSocket()
{
}

bool DaemonSocket::connect()
{
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    const std::string path = Config::socketFile;
    if (path.size() + 1 > sizeof(addr.sun_path)) {
        ERROR("Socket path is too long %zu > %zu", path.size(), sizeof(addr.sun_path) - 1);
        mState = Error;
        return false;
    }
    memcpy(addr.sun_path, path.c_str(), path.size() + 1);

    assert(mFD == -1);
    mFD = socket(AF_UNIX, SOCK_STREAM, 0);
    if (mFD == -1) {
        ERROR("Failed to create socket %d %s", errno, strerror(errno));
        mState = Error;
        return false;
    }

    if (!Client::setFlag(mFD, O_NONBLOCK|O_CLOEXEC)) {
        ::close(mFD);
        mFD = -1;
        ERROR("Failed to make socket non blocking %d %s", errno, strerror(errno));
        mState = Error;
        return false;
    }

    int ret;
    EINTRWRAP(ret, ::connect(mFD, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)));
    if (ret == 0) {
        mState = Connected;
        return true;
    }

    assert(ret == -1);
    if (errno != EINPROGRESS) {
        ::close(mFD);
        mFD = -1;
        mState = Error;
        ERROR("Failed to connect socket to %s: %d %s", path.c_str(), errno, strerror(errno));
        return false;
    }
    mState = Connecting;
    return true;
}

unsigned int DaemonSocket::mode() const
{
    if (mState == Connecting) {
        return Write;
    }

    int ret = Read;
    if (!mSendBuffer.empty())
        ret |= Write;
    return ret;
}

void DaemonSocket::onWrite()
{
    if (mState == Connecting) {
        int err;
        do {
            socklen_t size = sizeof(err);
            int e = ::getsockopt(mFD, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&err), &size);

            if (e == -1) {
                mState = Error;
                ERROR("Failed to getsockopt (%d %s)", errno, strerror(errno));
                return;
            }
        } while (err == EINTR);

        if (err == EINPROGRESS) {
            DEBUG("Still connecting to socket %s", Config::socketFile.get().c_str());
            return;
        } else if (err && err != EISCONN) {
            ERROR("Failed to connect to socket %s (%d %s)", Config::socketFile.get().c_str(), err, strerror(err));
            mState = Error;
            return;
        }

        DEBUG("Asynchronously connected to socket %s", Config::socketFile.get().c_str());
        mState = Connected;
        return;
    }
    write();
}

void DaemonSocket::onRead()
{
    char buf[1024];
    while (true) {
        int r;
        errno = 0;
        EINTRWRAP(r, ::read(mFD, buf, sizeof(buf)));
        VERBOSE("Read from socket %s -> %d (%d %s)", Config::socketFile.get().c_str(),
                r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");

        if (r == -1) {
            if (errno == EWOULDBLOCK || errno == EAGAIN)
                break;
            ERROR("Read error from socket %s %d %s", Config::socketFile.get().c_str(), errno, strerror(errno));
            mState = Error;
            break;
        }

        if (!r) {
            DEBUG("Socket connection closed %s", Config::socketFile.get().c_str());
            close();
            break;
        }

        mRecvBuffer.append(buf, r);
    }

    while (mRecvBuffer.size() > 4 && mState == Connected) {
        uint32_t messageLength;
        memcpy(&messageLength, mRecvBuffer.c_str(), sizeof(messageLength));
        messageLength = ntohl(messageLength);
        if (mRecvBuffer.size() - sizeof(messageLength) >= messageLength) { // got message
            const std::string message = mRecvBuffer.substr(sizeof(messageLength), messageLength);
            mRecvBuffer.erase(0, messageLength + sizeof(messageLength));
            processMessage(message);
        } else {
            break;
        }
    }
}

void DaemonSocket::write()
{
    assert(mSendBuffer.size() - mSendBufferOffset > 0);

    do {
        int r;
        EINTRWRAP(r, ::write(mFD, mSendBuffer.c_str() + mSendBufferOffset, mSendBuffer.size() - mSendBufferOffset));
        VERBOSE("Write to socket %s -> %d (%d %s)", Config::socketFile.get().c_str(),
                r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");
        if (r == -1) {
            if (errno == EWOULDBLOCK || errno == EAGAIN)
                break;

            ERROR("Write error from socket %s %d %s", Config::socketFile.get().c_str(), errno, strerror(errno));
            mState = Error;
            break;
        }

        mSendBufferOffset += r;
        if (mSendBufferOffset == mSendBuffer.size()) {
            mSendBuffer.clear();
            mSendBufferOffset = 0;
        }
    } while (mSendBuffer.size() > mSendBufferOffset);
}

void DaemonSocket::send(const std::string &json)
{
    union {
        uint32_t bytes;
        char buf[sizeof(uint32_t)];
    };
    bytes = htonl(json.size());
    mSendBuffer.append(buf, sizeof(buf));
    mSendBuffer.append(json.c_str(), json.size());
    DEBUG("DaemonSocket send message: %s", json.c_str());
    // send here?
}

void DaemonSocket::acquireCppSlot()
{
    send("{\"type\":\"acquireCppSlot\"}");
}

bool DaemonSocket::hasCppSlot() const
{
    std::unique_lock<std::mutex> lock(mMutex);
    return mHasCppSlot;
}

bool DaemonSocket::waitForCppSlot()
{
    std::unique_lock<std::mutex> lock(mMutex);
    while (!mHasCppSlot && mState == Connected) {
        mCond.wait(lock);
    }
    return mHasCppSlot;
}

void DaemonSocket::releaseCppSlot()
{
    send("{\"type\":\"releaseCppSlot\"}");
}

void DaemonSocket::acquireCompileSlot()
{
    send("{\"type\":\"acquireCompileSlot\"}");
}

bool DaemonSocket::waitForCompileSlot(Select &select)
{
    while (!mHasCompileSlot && mState == Connected) {
        select.exec();
    }
    return mHasCompileSlot;
}

void DaemonSocket::processMessage(const std::string &message)
{
    DEBUG("DaemonSocket got message: %s", message.c_str());
    std::string err;
    json11::Json msg = json11::Json::parse(message, err, json11::JsonParse::COMMENTS);
    if (!err.empty()) {
        ERROR("Failed to parse json from scheduler: %s", err.c_str());
        Client::data().watchdog->stop();
        close("daemon json parse error");
        return;
    }

    const std::string type = msg["type"].string_value();
    if (type == "cppSlotAcquired") {
        std::unique_lock<std::mutex> lock(mMutex);
        mHasCppSlot = true;
        mCond.notify_one();
    } else if (type == "compileSlotAcquired") {
        mHasCompileSlot = true;
    } else {
        ERROR("Unknown type from daemon: %s\n%s", type.c_str(), message.c_str());
        close("Bad json");
    }
}

void DaemonSocket::close(std::string &&err)
{
    if (mFD != -1) {
        ::close(mFD);
        mFD = -1;
    }
    if (err.size()) {
        mError = std::move(err);
        mState = Error;
    } else {
        mState = Closed;
    }
}
