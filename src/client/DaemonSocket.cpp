#include "DaemonSocket.h"
#include "Client.h"
#include "Config.h"
#include "Watchdog.h"
#include <arpa/inet.h>
#include <process.hpp>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

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

    if (!Client::setFlag(mFD, O_NONBLOCK | O_CLOEXEC)) {
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
        VERBOSE("DaemonSocket selecting, read|write %zu bytes pending", mSendBuffer.size());
    } else {
        VERBOSE("DaemonSocket selecting, read only");
    }
    return ret;
}

void DaemonSocket::onWrite()
{
    if (mState == Connecting) {
        int err = 0;
        socklen_t size = sizeof(err);
        int e;
        EINTRWRAP(e, ::getsockopt(mFD, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&err), &size));
        if (e == -1) {
            mState = Error;
            ERROR("Failed to getsockopt (%d %s)", errno, strerror(errno));
            return;
        }

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
        VERBOSE("Read from socket %s -> %ld (%d %s)", Config::socket.get().c_str(), r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");

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
        VERBOSE("Write to socket %s -> %zd (%d %s)", Config::socket.get().c_str(), r, r == -1 ? errno : 0, r == -1 ? strerror(errno) : "");
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

    union
    {
        uint32_t bytes;
        char buf[sizeof(uint32_t)];
    };

    bytes = htonl(json.size());
    mSendBuffer.append(buf, sizeof(buf));
    mSendBuffer.append(json.c_str(), json.size());
    DEBUG("DaemonSocket send message: %s", json.c_str());
}

// Key identifying "this exact compiler binary" for the daemon's fingerprint
// cache. The daemon cannot compute this itself: the compiler usually lives in
// our container and its path does not resolve in the daemon's mount namespace.
//
// It hashes the driver's bytes rather than using path+mtime, because one daemon
// can serve several containers and two images can ship the same path with the
// same mtime and size while holding different compilers. This is only a local
// "same file?" key -- the fingerprint the scheduler matches on still comes from
// the probes, precisely because driver bytes differ between machines that
// installed the same compiler package.
std::string DaemonSocket::compilerKey(const std::string &compiler)
{
    std::string contents;
    if (!Client::readFile(compiler, contents)) {
        DEBUG("Can't read compiler %s to key it", compiler.c_str());
        return std::string();
    }
    return Client::toHex(Client::sha1(contents));
}

void DaemonSocket::sendAcquireSlot(const std::string &compiler)
{
    mCompiler = compiler;
    nlohmann::json obj = nlohmann::json::object();
    obj["type"] = "acquireSlot";
    obj["compiler"] = compiler;
    obj["compilerKey"] = compilerKey(compiler);
    if (!Config::localSlot) {
        obj["no-local"] = true;
    }
    send(obj.dump());
}

// Run the probes the daemon asked for and report the raw output back. The
// daemon does the parsing and hashing so there is exactly one implementation of
// the fingerprint; we are merely the process that can see the compiler.
void DaemonSocket::handleCompilerInfoRequest(const nlohmann::json &obj)
{
    const std::string key = obj.value("key", std::string());
    nlohmann::json response = nlohmann::json::object();
    response["type"] = "compilerInfoResponse";
    response["key"] = key;

    const auto probesIt = obj.find("probes");
    if (key.empty() || probesIt == obj.end() || !probesIt->is_array()) {
        response["error"] = "malformed compilerInfoRequest";
        send(response.dump());
        return;
    }
    if (mCompiler.empty()) {
        response["error"] = "no compiler to probe";
        send(response.dump());
        return;
    }

    nlohmann::json results = nlohmann::json::object();
    for (const auto &probe : *probesIt) {
        const std::string label = probe.value("label", std::string());
        const bool required = probe.value("required", false);
        const auto argsIt = probe.find("args");
        if (label.empty() || argsIt == probe.end() || !argsIt->is_array()) {
            continue;
        }

        std::vector<std::string> argv;
        argv.reserve(argsIt->size() + 1);
        argv.push_back(mCompiler);
        for (const auto &arg : *argsIt) {
            if (arg.is_string()) {
                argv.push_back(arg.get<std::string>());
            }
        }

        std::string out, err;
        TinyProcessLib::Process proc(
            argv,
            std::string(),
            [&out](const char *bytes, size_t n) {
            out.append(bytes, n);
        },
            [&err](const char *bytes, size_t n) {
            err.append(bytes, n);
        });
        if (proc.get_exit_status()) {
            DEBUG("Probe %s failed for %s: %s", label.c_str(), mCompiler.c_str(), err.c_str());
            if (required) {
                response["error"] = "probe '" + label + "' failed: " + err;
                send(response.dump());
                return;
            }
            // A failing optional probe is reported as absent rather than as an
            // error; the daemon decides which probes it can live without.
            results[label] = nullptr;
            continue;
        }
        results[label] = out + err;
    }

    response["results"] = std::move(results);
    DEBUG("Reporting compiler info for %s (key %s)", mCompiler.c_str(), key.c_str());
    send(response.dump());
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

bool DaemonSocket::waitForSlot(Select &select)
{
    const unsigned long long start = Client::mono();
    while (!mHasCppSlot && !mHasLocalSlot && mState == Connected && Client::mono() - start < Config::slotAcquisitionTimeout) {
        select.exec();
    }
    return mHasCppSlot || mHasLocalSlot;
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
                break;
            }
            case CompileSlotAcquired:
                DEBUG("CompileSlotAcquired");
                mHasCompileSlot = true;
                used = 1;
                break;
            case LocalSlotAcquired:
                DEBUG("LocalSlotAcquired");
                mHasLocalSlot = true;
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
    nlohmann::json obj = nlohmann::json::parse(json, nullptr, false);
    if (obj.is_discarded()) {
        ERROR("Failed to parse JSON message from daemon: %s", json.c_str());
        return;
    }

    const std::string type = obj.value("type", std::string());
    if (type == "compilerInfoRequest") {
        handleCompilerInfoRequest(obj);
        return;
    }
    if (type != "slotAcquired") {
        fwrite(json.c_str(), 1, json.size(), stdout);
        fflush(stdout);
        return;
    }

    auto ciIt = obj.find("compilerInfo");
    const bool haveCompilerInfo = (ciIt != obj.end() && ciIt->is_object());
    if (haveCompilerInfo) {
        const nlohmann::json &ci = *ciIt;
        mCompilerInfo.hash = ci.value("hash", std::string());
        mCompilerInfo.input = ci.value("input", std::string());
        const std::string t = ci.value("type", std::string("unknown"));
        if (t == "clang") {
            mCompilerInfo.type = Client::CompilerType::Clang;
        } else if (t == "gcc") {
            mCompilerInfo.type = Client::CompilerType::GCC;
        } else {
            mCompilerInfo.type = Client::CompilerType::Unknown;
        }
        auto verIt = ci.find("version");
        if (verIt != ci.end() && verIt->is_object()) {
            mCompilerInfo.version.major = verIt->value("major", 0);
            mCompilerInfo.version.minor = verIt->value("minor", 0);
            mCompilerInfo.version.patch = verIt->value("patch", 0);
        }
    }

    const bool hasError = obj.contains("error");
    if (hasError) {
        WARN("Daemon reported slot acquisition error: %s", obj["error"].dump().c_str());
    }
    if (!haveCompilerInfo) {
        WARN("slotAcquired message missing compilerInfo");
    }

    const std::string slot = obj.value("slot", std::string());
    if (slot == "local") {
        mHasLocalSlot = true;
        mCond.notify_one();
    } else if (slot == "cpp") {
        std::unique_lock<std::mutex> lock(mMutex);
        mHasCppSlot = true;
        mCond.notify_one();
    }
}
