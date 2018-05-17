#include "WebSocket.h"
#include "Log.h"
#include "Client.h"

#include <LUrlParser.h>
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static inline std::string create_acceptkey(const std::string& clientkey)
{
    std::string s = clientkey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    return Client::base64(Client::sha1(s));
}

static inline size_t random(void *data, size_t len)
{
    FILE *f = fopen("/dev/urandom", "r");
    if (!f) {
        Log::error("Can't open /dev/urandom for reading %d %s", errno, strerror(errno));
        return 0;
    }

    size_t ret = fread(data, 1, len, f);
    if (ret != len) {
        Log::error("Can't read from /dev/urandom %d %s", errno, strerror(errno));
        return 0;
    }
    fclose(f);
    return ret;
}

WebSocket::WebSocket()
{
    mCallbacks.recv_callback = [](wslay_event_context *ctx,
                                  uint8_t *buf, size_t len,
                                  int flags, void *user_data) -> ssize_t {
        WebSocket *ws = static_cast<WebSocket *>(user_data);
        if (ws->mRecvBuffer.empty()) {
            wslay_event_set_error(ctx, WSLAY_ERR_WOULDBLOCK);
            return -1;
        }
        const ssize_t ret = std::min<ssize_t>(ws->mRecvBuffer.size(), len);
        memcpy(buf, &ws->mRecvBuffer[0], ret);
        ws->mRecvBuffer.erase(ws->mRecvBuffer.begin(), ws->mRecvBuffer.begin() + ret);
        return ret;
    };

    mCallbacks.send_callback = [](wslay_event_context *ctx,
                                  const uint8_t *data, size_t len,
                                  int flags, void *user_data) -> ssize_t {
        WebSocket *ws = static_cast<WebSocket *>(user_data);
        ws->mSendBuffer.resize(ws->mSendBuffer.size() + len);
        memcpy(&ws->mSendBuffer[ws->mSendBuffer.size() - len], data, len);
        return len;
    };
    mCallbacks.genmask_callback = [](wslay_event_context *,
                                     uint8_t *buf, size_t len,
                                     void *) -> int {
        return random(buf, len) == len ? 0 : -1;
    };
    mCallbacks.on_msg_recv_callback = [](wslay_event_context *ctx,
                                         const struct wslay_event_on_msg_recv_arg *arg,
                                         void *user_data) -> void {
        WebSocket *ws = static_cast<WebSocket *>(user_data);
        assert(ws);
        assert(ws->mOnMessage);
        switch (arg->opcode) {
        case WSLAY_TEXT_FRAME:
            ws->mOnMessage(Text, arg->msg, arg->msg_length);
            break;
        case WSLAY_BINARY_FRAME:
            ws->mOnMessage(Binary, arg->msg, arg->msg_length);
            break;
        case WSLAY_PING:
        case WSLAY_PONG:
        case WSLAY_CONTINUATION_FRAME:
            wslay_event_send(ctx);
            break;
        }
    };
}

WebSocket::~WebSocket()
{
    if (mContext)
        wslay_event_context_free(mContext);
    if (mFD != -1)
        ::close(mFD);
}

bool WebSocket::connect(std::string &&url, const std::map<std::string, std::string> &headers)
{
    mUrl = std::move(url);
    LUrlParser::clParseURL parsedUrl = LUrlParser::clParseURL::ParseURL(mUrl);
    if (!parsedUrl.IsValid()) {
        Log::error("Bad url %s", mUrl.c_str());
        return false;
    }

    if (parsedUrl.m_Scheme != "ws") {
        Log::error("Bad scheme %s %s", parsedUrl.m_Scheme.c_str(), mUrl.c_str());
        return false;
    }

    const std::string host = parsedUrl.m_Host;
    int port;
    if (!parsedUrl.GetPort(&port)) {
        Log::error("Bad port %s %s", parsedUrl.m_Scheme.c_str(), mUrl.c_str());
        return false;
    }

    if (!port)
        port = 80;

    // ### should support literals maybe
    // in_addr literal;
    // addrinfo *addr;
    // if (inet_aton(host.c_str(), &literal)) {
    //     Log::debug("Got literal ip address: %s", host.c_str());
    // }

    addrinfo hints, *res;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = PF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags |= AI_CANONNAME;


    int ret = getaddrinfo(host.c_str(), nullptr, &hints, &res);
    Log::debug("Getting addresses for %s -> %d", host.c_str(), ret);
    if (ret != 0) {
        Log::error("Couldn't resolve host %s", host.c_str());
        return false;
    }

    for (addrinfo *addr = res; addr; addr = addr->ai_next) {
        mFD = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
        Log::debug("Opening socket for for %s -> %d", host.c_str(), ret);

        if (mFD == -1)
            continue;


        sockaddr_in *sockAddr = reinterpret_cast<sockaddr_in *>(addr->ai_addr);
        sockAddr->sin_port = htons(port);
        Log::debug("Connecting socket %s (%s:%d)", host.c_str(),
                   inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr), port);

        do {
            ret = ::connect(mFD, addr->ai_addr, addr->ai_addrlen);
        } while (ret == -1 && errno == EINTR);

        if (!ret) {
            Log::debug("Connected to server %s (%s:%d)", host.c_str(),
                       inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr), port);
            break;
        } else {
            ::close(mFD);
            Log::error("Failed to connect socket %s (%s:%d) %d %s", host.c_str(),
                       inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr),
                       port, errno, strerror(errno));
            mFD = -1;
        }
    }
    freeaddrinfo(res);

    if (mFD == -1) {
        Log::error("Couldn't connect to host %s", host.c_str());
        return false;
    }

    if (!Client::setFlag(mFD, O_CLOEXEC)) {
        Log::error("Failed to make socket O_CLOEXEC");
        return false;
    }

    std::string random(16, ' ');
    ::random(&random[0], random.size());
    const std::string client_key = Client::base64(random);

    {
        char reqHeader[4096];
        Log::debug("Writing HTTP handshake");
        std::string extraHeaders;
        extraHeaders.reserve(1024);
        for (const std::pair<std::string, std::string> &header : headers) {
            extraHeaders += Client::format("%s: %s\r\n", header.first.c_str(), header.second.c_str());
        }
        const size_t reqHeaderSize = snprintf(reqHeader, sizeof(reqHeader),
                                              "GET /%s HTTP/1.1\r\n"
                                              "Host: %s:%d\r\n"
                                              "Upgrade: websocket\r\n"
                                              "Connection: Upgrade\r\n"
                                              "Sec-WebSocket-Key: %s\r\n"
                                              "Sec-WebSocket-Version: 13\r\n"
                                              "%s"
                                              "\r\n",
                                              parsedUrl.m_Path.c_str(), host.c_str(), port,
                                              client_key.c_str(), extraHeaders.c_str());

        Log::debug("Sent headers:\n%s", reqHeader);

        size_t off = 0;
        while (off < reqHeaderSize) {
            ssize_t r;
            size_t len = reqHeaderSize-off;
            while ((r = write(mFD, reqHeader + off, len)) == -1 && errno == EINTR);
            if (r == -1) {
                Log::error("Failed to write http upgrade request to %s %d %s", mUrl.c_str(), errno, strerror(errno));
                return false;
            }
            off += r;
        }
    }
    {
        std::string response;
        char buf[4096];
        while(1) {
            ssize_t r;
            while ((r = read(mFD, buf, sizeof(buf))) == -1 && errno == EINTR);
            if (r <= 0) {
                Log::error("Read error happened for %s: %zd %d %s", mUrl.c_str(), r, errno, strerror(errno));
                return false;
            }
            response.append(buf, buf+r);
            if (response.size() > 8192) {
                Log::error("Too big response header %zu", response.size());
                return false;
            }

            if (response.find("\r\n\r\n") != std::string::npos) {
                break;
            }
        }
        Log::debug("Got response headers %zu bytes", response.size());
        size_t keyhdstart;
        if ((keyhdstart = response.find("Sec-WebSocket-Accept: ")) == std::string::npos) {
            Log::error("http_upgrade: missing required headers");
            return false;
        }
        keyhdstart += 22;
        const size_t keyhdend = response.find("\r\n", keyhdstart);
        const std::string accept_key = response.substr(keyhdstart, keyhdend - keyhdstart);
        if (accept_key != create_acceptkey(client_key)) {
            Log::error("Invalid accept key, expected %s, got %s",
                       create_acceptkey(client_key).c_str(), accept_key.c_str());
            return false;
        }
    }
    if (!Client::setFlag(mFD, O_NONBLOCK)) {
        Log::error("Failed to make socket non blocking %d %s", errno, strerror(errno));
        return false;
    }
    ret = wslay_event_context_client_init(&mContext, &mCallbacks, this);
    if (ret != 0) {
        Log::error("Failed to initialize wslay context: %d", ret);
        return false;
    }
    assert(mContext);
    return true;
}

bool WebSocket::send(Mode mode, const void *msg, size_t len)
{
    wslay_event_msg wmsg = {
        static_cast<uint8_t>(mode == Text ? WSLAY_TEXT_FRAME : WSLAY_BINARY_FRAME),
        reinterpret_cast<const uint8_t *>(msg),
        len
    };
    return !wslay_event_queue_msg(mContext, &wmsg) && !wslay_event_send(mContext);
}


bool WebSocket::exec(std::function<void(Mode mode, const void *data, size_t len)> &&onMessage)
{
    mExit = false;
    mOnMessage = std::move(onMessage);
    bool closed = false;
    bool error = false;
    while (true) {
        fd_set r, w;
        int ret;
        do {
            FD_ZERO(&r);
            FD_ZERO(&w);
            FD_SET(mFD, &r);
            if (wslay_event_want_write(mContext) || !mSendBuffer.empty()) {
                printf("WRITEY SHIT %lu\n", mSendBuffer.size());
                FD_SET(mFD, &w);
            }
            errno = 0;
            ret = select(mFD + 1, &r, &w, 0, 0);
        } while (ret == -1 && errno == EINTR);

        printf("Select woke up %d %d %s\n", ret, errno, strerror(errno));

        const bool sendBufferWasEmpty = mSendBuffer.empty();
        if (FD_ISSET(mFD, &r)) {
            while (true) {
                char buf[BUFSIZ];
                const ssize_t r = ::read(mFD, buf, sizeof(buf));
                printf("Read %zd bytes\n", r);
                if (!r) {
                    closed = true;
                    break;
                } else if (r > 0) {
                    mRecvBuffer.insert(mRecvBuffer.end(), buf, buf + r);
                } else if (errno == EWOULDBLOCK || errno == EAGAIN) {
                    break;
                } else {
                    error = true;
                    break;
                }
            }
        }
        if (closed)
            break;
        while (true) {
            const size_t last = mRecvBuffer.size();
            wslay_event_recv(mContext);
            if (!mRecvBuffer.empty() || last == mRecvBuffer.size())
                break;
        }

        if (FD_ISSET(mFD, &w) || (!mSendBuffer.empty() && sendBufferWasEmpty)) {
            size_t sendBufferOffset = 0;
            while (sendBufferOffset < mSendBuffer.size()) {
                const ssize_t r = ::write(mFD, &mSendBuffer[sendBufferOffset], std::min<size_t>(BUFSIZ, mSendBuffer.size() - sendBufferOffset));
                printf("Wrote %zd bytes\n", r);
                if (r > 0) {
                    sendBufferOffset += r;
                } else if (errno == EWOULDBLOCK || errno == EAGAIN) {
                    break;
                } else {
                    error = true;
                    break;
                }
            }
            if (sendBufferOffset) {
                mSendBuffer.erase(mSendBuffer.begin(), mSendBuffer.begin() + sendBufferOffset);
            }
        }

        if (error) {
            break;
        }
        if (mExit && mSendBuffer.empty()) {
            break;
        }
    }
    mOnMessage = nullptr;
    return !error;
}

void WebSocket::exit()
{
    mExit = true;
}

void WebSocket::close(const char *reason)
{
    wslay_event_queue_close(mContext, 1000, reinterpret_cast<const uint8_t *>(reason), reason ? strlen(reason) : 0);
    wslay_event_send(mContext);
}
