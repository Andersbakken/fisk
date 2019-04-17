#include "DaemonSocket.h"
#include "Config.h"
#include "Client.h"
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
    const std::string path = Config::socket;
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

    const pid_t pid = getpid();
    static_assert(sizeof(pid) == 4, "pid_t must be 4 bytes");
    const uint32_t networkOrder = htonl(pid);
    mSendBuffer.append(reinterpret_cast<const char *>(&networkOrder), sizeof(networkOrder));

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
        VERBOSE("DaemonSocket connecting, returning write");
        return Write;
    }

    int ret = Read;
    if (!mSendBuffer.empty()) {
        ret |= Write;
        VERBOSE("DaemonSocket connecting, read|write %zu bytes pending", mSendBuffer.size());
    } else {
        VERBOSE("DaemonSocket connecting, read only");
    }
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
            DEBUG("Still connecting to socket %s", Config::socket.get().c_str());
            return;
        } else if (err && err != EISCONN) {
            ERROR("Failed to connect to socket %s (%d %s)", Config::socket.get().c_str(), err, strerror(err));
            mState = Error;
            return;
        }

        DEBUG("Asynchronously connected to socket %s", Config::socket.get().c_str());
        mState = Connected;
        if (mSendBuffer.size() - mSendBufferOffset == 0)
            return;
    }
    write();
}

void DaemonSocket::onRead()
{
    char buf[1024];
    while (true) {
        ssize_t r;
        errno = 0;
        EINTRWRAP(r, ::read(mFD, buf, sizeof(buf)));
        VERBOSE("Read from socket %s -> %ld (%d %s)", Config::socket.get().c_str(),
                r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");

        if (r == -1) {
            if (errno == EWOULDBLOCK || errno == EAGAIN)
                break;
            ERROR("Read error from socket %s %d %s", Config::socket.get().c_str(), errno, strerror(errno));
            mState = Error;
            break;
        }

        if (!r) {
            DEBUG("Socket connection closed %s", Config::socket.get().c_str());
            close();
            break;
        }

        mRecvBuffer.append(buf, r);
    }

    const char *ch = mRecvBuffer.c_str();
    size_t len = mRecvBuffer.length();
    while (len) {
        size_t consumed = processMessage(ch, len);
        assert(len >= consumed);
        if (!consumed)
            break;
        ch += consumed;
        len -= consumed;
    }
    if (len < mRecvBuffer.size()) {
        mRecvBuffer.erase(mRecvBuffer.begin(), mRecvBuffer.begin() + mRecvBuffer.size() - len);
    }
}

void DaemonSocket::write()
{
    VERBOSE("DaemonSocket::write(%zu, %zu)", mSendBuffer.size(), mSendBufferOffset);
    assert(mSendBuffer.size() - mSendBufferOffset > 0);

    do {
        ssize_t r;
        EINTRWRAP(r, ::write(mFD, mSendBuffer.c_str() + mSendBufferOffset, mSendBuffer.size() - mSendBufferOffset));
        VERBOSE("Write to socket %s -> %zd (%d %s)", Config::socket.get().c_str(),
                r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");
        if (r == -1) {
            if (errno == EWOULDBLOCK || errno == EAGAIN)
                break;

            ERROR("Write error from socket %s %d %s", Config::socket.get().c_str(), errno, strerror(errno));
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

void DaemonSocket::send(Command cmd)
{
    const char ch = static_cast<char>(cmd);
    mSendBuffer.append(&ch, 1);
    DEBUG("Sending command %d", cmd);
}

void DaemonSocket::send(const std::string &json)
{
    send(JSON);
    union {
        uint32_t bytes;
        char buf[sizeof(uint32_t)];
    };
    bytes = htonl(json.size());
    mSendBuffer.append(buf, sizeof(buf));
    mSendBuffer.append(json.c_str(), json.size());
    DEBUG("DaemonSocket send message: %s", json.c_str());
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

bool DaemonSocket::waitForCompileSlot(Select &select)
{
    const unsigned long long start = Client::mono();
    while (!mHasCompileSlot && mState == Connected && Client::mono() - start < Config::slotAcquisitionTimeout) {
        select.exec();
    }
    return mHasCompileSlot;
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

size_t DaemonSocket::processMessage(const char *const msg, const size_t len)
{
    DEBUG("Processing %zu bytes", len);
    size_t ret = 0;
    while (ret < len) {
        size_t used = 0;
        // DEBUG("CHECKING MESSAGE TYPE %d", msg[ret]);
        switch (msg[ret]) {
        case CppSlotAcquired: {
            DEBUG("CppSlotAcquired");
            std::unique_lock<std::mutex> lock(mMutex);
            mHasCppSlot = true;
            mCond.notify_one();
            used = 1;
            break; }
        case CompileSlotAcquired:
            DEBUG("CompileSlotAcquired");
            mHasCompileSlot = true;
            used = 1;
            break;
        case JSONResponse:
            DEBUG("JSONResponse len %zu", len - ret);
            if (ret + 4 < len) {
                uint32_t msgLen;
                memcpy(&msgLen, msg + ret + 1, 4);
                msgLen = ntohl(msgLen);
                DEBUG("Read message ret %zu msgLen %u len %zu", ret, msgLen, len);
                if (ret + 4 + msgLen < len) {
                    std::string json(msg + ret + 5, msgLen);
                    used += 1 + 4 + msgLen;
                    processJSON(json);
                }
            }
            break;
        default:
            break;
        }
        if (used) {
            ret += used;
        } else {
            break;
        }
    }
    return ret;
}

void DaemonSocket::processJSON(const std::string &json)
{
    fwrite(json.c_str(), 1, json.size(), stdout);
    fflush(stdout);
    close();
}
