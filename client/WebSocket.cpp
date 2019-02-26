#include "WebSocket.h"
#include "Log.h"
#include "Client.h"

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
        ERROR("Can't open /dev/urandom for reading %d %s", errno, strerror(errno));
        return 0;
    }

    int ret;
    EINTRWRAP(ret, read(fileno(f), data, len));
    if (ret != static_cast<int>(len)) {
        ERROR("Can't read from /dev/urandom %d %s", errno, strerror(errno));
        return 0;
    }
    const size_t r = ret;
    EINTRWRAP(ret, fclose(f));
    return r;
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
        switch (arg->opcode) {
        case WSLAY_TEXT_FRAME:
            ws->onMessage(Text, arg->msg, arg->msg_length);
            break;
        case WSLAY_BINARY_FRAME:
            ws->onMessage(Binary, arg->msg, arg->msg_length);
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
    if (mFD != -1) {
        int ret;
        EINTRWRAP(ret, ::close(mFD));
    }
}

bool WebSocket::connect(std::string &&url, const std::map<std::string, std::string> &headers)
{
    mUrl = std::move(url);
    mHeaders = std::move(headers);
    mParsedUrl = LUrlParser::clParseURL::ParseURL(mUrl);
    if (!mParsedUrl.IsValid()) {
        ERROR("Bad url %s", mUrl.c_str());
        return false;
    }

    if (mParsedUrl.m_Scheme != "ws") {
        ERROR("Bad scheme %s %s", mParsedUrl.m_Scheme.c_str(), mUrl.c_str());
        return false;
    }

    mHost = mParsedUrl.m_Host;
    if (!mParsedUrl.GetPort(&mPort)) {
        ERROR("Bad port %s %s", mParsedUrl.m_Scheme.c_str(), mUrl.c_str());
        return false;
    }

    if (!mPort)
        mPort = 80;

    addrinfo *res = 0;
    addrinfo stackRes;
    in_addr literal;
    sockaddr_in literalSockAddr = { 0 };
    int ret;
    if (inet_aton(mHost.c_str(), &literal)) {
        DEBUG("Got literal ip address: %s", mHost.c_str());
        memset(&stackRes, 0, sizeof(stackRes));
        res = &stackRes;
        res->ai_family = PF_INET;
        res->ai_socktype = SOCK_STREAM;
        res->ai_protocol = 0;
        res->ai_addr = reinterpret_cast<sockaddr *>(&literalSockAddr);
        res->ai_addrlen = sizeof(sockaddr_in);
#ifdef __APPLE__
        literalSockAddr.sin_len = sizeof(sockaddr_in);
#endif
        literalSockAddr.sin_family = AF_INET;
        literalSockAddr.sin_addr = literal;
    } else {
        addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = PF_INET;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_flags |= AI_CANONNAME;

        ret = getaddrinfo(mHost.c_str(), nullptr, &hints, &res);
        DEBUG("Getting addresses for %s -> %d", mHost.c_str(), ret);
        if (ret != 0) {
            ERROR("Couldn't resolve host %s", mHost.c_str());
            return false;
        }
    }

    for (addrinfo *addr = res; addr; addr = addr->ai_next) {
        mFD = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
        DEBUG("Opening socket for for %s -> %d", mHost.c_str(), ret);

        if (mFD == -1)
            continue;

        sockaddr_in *sockAddr = reinterpret_cast<sockaddr_in *>(addr->ai_addr);
        sockAddr->sin_port = htons(mPort);
        DEBUG("Connecting socket %s (%s:%d)", mHost.c_str(),
              inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr), mPort);

        if (!Client::setFlag(mFD, O_NONBLOCK|O_CLOEXEC)) {
            ERROR("Failed to make socket non blocking %d %s", errno, strerror(errno));
            int cret;
            EINTRWRAP(cret, ::close(mFD));
            mFD = -1;
            continue;
        }

        EINTRWRAP(ret, ::connect(mFD, addr->ai_addr, addr->ai_addrlen));

        if (!ret) {
            DEBUG("Connected to server %s (%s:%d)", mHost.c_str(),
                  inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr), mPort);
            mState = ConnectedTCP;
            break;
        } else if (errno != EINPROGRESS) {
            int cret;
            EINTRWRAP(cret, ::close(mFD));
            ERROR("Failed to connect socket %s (%s:%d) %d %s", mHost.c_str(),
                  inet_ntoa(reinterpret_cast<sockaddr_in *>(addr->ai_addr)->sin_addr),
                  mPort, errno, strerror(errno));
            mFD = -1;
            mState = Error;
            break;
        } else {
            mState = ConnectingTCP;
            break; // async connect
        }
    }
    if (res != &stackRes)
        freeaddrinfo(res);

    if (mFD == -1) {
        ERROR("Couldn't connect to host %s", mHost.c_str());
        return false;
    } else if (mState == ConnectingTCP) {
        return true;
    }

    return requestUpgrade();
}

bool WebSocket::requestUpgrade()
{
    assert(mState == ConnectedTCP);
    std::string random(16, ' ');
    ::random(&random[0], random.size());
    mClientKey = Client::base64(random);

    {
        char reqHeader[4096];
        DEBUG("Writing HTTP handshake");
        std::string extraHeaders;
        extraHeaders.reserve(1024);
        for (const std::pair<std::string, std::string> &header : mHeaders) {
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
                                              mParsedUrl.m_Path.c_str(), mHost.c_str(), mPort,
                                              mClientKey.c_str(), extraHeaders.c_str());
        DEBUG("Sending headers:\n%s", reqHeader);

        assert(mSendBuffer.empty());
        mSendBuffer = std::vector<unsigned char>(reqHeader, reqHeader + reqHeaderSize);
        mState = WaitingForUpgrade;
    }
    send();
    return mState != Error;
}

void WebSocket::acceptUpgrade()
{
    DEBUG("Accept upgrade %zu bytes", mRecvBuffer.size());
    char *ch = reinterpret_cast<char *>(&mRecvBuffer[0]);
    std::string headers;
    for (size_t i=0; i<mRecvBuffer.size() - 3; ++i) {
        if (!strncmp(ch, "\r\n\r\n", 4)) {
            headers.assign(reinterpret_cast<char *>(&mRecvBuffer[0]), i + 4);
            mRecvBuffer.erase(mRecvBuffer.begin(), mRecvBuffer.begin() + i + 4);
            break;
        }
        ++ch;
    }
    if (!headers.empty()) {
        mHandshakeResponseHeaders = Client::split(headers, "\r\n");
        // for (size_t i=0; i<mHandshakeResponseHeaders.size(); ++i) {
        //     printf("%zu/%zu: %s\n", i, mHandshakeResponseHeaders.size(), mHandshakeResponseHeaders[i].c_str());
        // }

        DEBUG("Got response headers %zu bytes", headers.size());

        size_t keyhdstart;
        if ((keyhdstart = headers.find("Sec-WebSocket-Accept: ")) == std::string::npos) {
            ERROR("http_upgrade: missing required headers");
            mState = Error;
            return;
        }
        keyhdstart += 22;
        const size_t keyhdend = headers.find("\r\n", keyhdstart);
        const std::string accept_key = headers.substr(keyhdstart, keyhdend - keyhdstart);
        if (accept_key != create_acceptkey(mClientKey)) {
            ERROR("Invalid accept key, expected %s, got %s",
                  create_acceptkey(mClientKey).c_str(), accept_key.c_str());
            mState = Error;
            return;
        }
    }
    const int ret = wslay_event_context_client_init(&mContext, &mCallbacks, this);
    if (ret != 0) {
        ERROR("Failed to initialize wslay context: %d", ret);
        mState = Error;
        return;
    }
    assert(mContext);
    mState = ConnectedWebSocket;
    onConnected();
}

bool WebSocket::send(MessageType type, const void *msg, size_t len)
{
    assert(msg);
    assert(len);
    assert(this);
    assert(mContext);
    wslay_event_msg wmsg = {
        static_cast<uint8_t>(type == Text ? WSLAY_TEXT_FRAME : WSLAY_BINARY_FRAME),
        reinterpret_cast<const uint8_t *>(msg),
        len
    };
    return !wslay_event_queue_msg(mContext, &wmsg) && !wslay_event_send(mContext);
}

void WebSocket::close(const char *reason)
{
    wslay_event_queue_close(mContext, 1000, reinterpret_cast<const uint8_t *>(reason), reason ? strlen(reason) : 0);
    wslay_event_send(mContext);
}

unsigned int WebSocket::mode() const
{
    int ret = 0;
    switch (mState) {
    case Error:
    case Closed:
    case None:
        break;
    case ConnectingTCP:
        ret = Write;
        break;
    case ConnectedTCP:
    case WaitingForUpgrade:
        ret = Read;
        if (!mSendBuffer.empty())
            ret |= Write;
        break;
    case ConnectedWebSocket:
        ret |= Read;
        if (wslay_event_want_write(mContext) || !mSendBuffer.empty())
            ret |= Write;
        break;
    }

    return ret;
}

void WebSocket::onWrite()
{
    if (mState == ConnectingTCP) {
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
            DEBUG("Still connecting to host %s:%d", mHost.c_str(), mPort);
            return;
        } else if (err && err != EISCONN) {
            ERROR("Failed to connect to host %s:%d (%d %s)", mHost.c_str(), mPort, err, strerror(err));
            mState = Error;
            return;
        }

        DEBUG("Asynchronously connected to host %s:%d", mHost.c_str(), mPort);
        mState = ConnectedTCP;
        if (!requestUpgrade())
            return;
    }
    send();
}

void WebSocket::onRead()
{
    const bool sendBufferWasEmpty = mSendBuffer.empty();
    while (true) {
        char buf[BUFSIZ];
        const ssize_t r = ::read(mFD, buf, sizeof(buf));
        VERBOSE("Read %zd bytes", r);
        if (!r) {
            mState = Closed;
            break;
        } else if (r > 0) {
            mRecvBuffer.insert(mRecvBuffer.end(), buf, buf + r);
        } else if (errno == EWOULDBLOCK || errno == EAGAIN) {
            break;
        } else if (errno != EINTR) {
            ERROR("Got read error: %d %s", errno, strerror(errno));
            mState = Error;
            break;
        }
    }

    if (mState == WaitingForUpgrade) {
        acceptUpgrade();
    }
    if (mState == ConnectedWebSocket) {
        while (true) {
            const size_t last = mRecvBuffer.size();
            const int r = wslay_event_recv(mContext);
            if (r) {
                ERROR("Got wslay_event_recv error: %d", r);
                mState = Error;
                return;
            }
            if (mRecvBuffer.empty() || last == mRecvBuffer.size())
                break;
        }

        if (sendBufferWasEmpty && !mSendBuffer.empty())
            send();
        wslay_event_send(mContext);
    }
}

void WebSocket::send()
{
    size_t sendBufferOffset = 0;
    while (sendBufferOffset < mSendBuffer.size()) {
        const ssize_t r = ::write(mFD, &mSendBuffer[sendBufferOffset], std::min<size_t>(BUFSIZ, mSendBuffer.size() - sendBufferOffset));
        VERBOSE("Wrote %zd bytes\n", r);
        if (r > 0) {
            sendBufferOffset += r;
        } else if (errno == EWOULDBLOCK || errno == EAGAIN) {
            break;
        } else if (errno != EINTR) {
            ERROR("Got write error: %d %s", errno, strerror(errno));
            mState = Error;
            break;
        }
    }
    if (sendBufferOffset) {
        mSendBuffer.erase(mSendBuffer.begin(), mSendBuffer.begin() + sendBufferOffset);
    }
}
