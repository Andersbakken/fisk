#include "WebSocket.h"
#include <assert.h>
#include "Client.h"
#include <sys/types.h>
#include "Log.h"
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <openssl/sha.h>
#include <openssl/bio.h>
#include <openssl/evp.h>

static std::string sha1(const std::string &str)
{
    std::string res(SHA_DIGEST_LENGTH, ' ');
    SHA1(reinterpret_cast<const unsigned char *>(str.c_str()), str.size(), reinterpret_cast<unsigned char *>(&res[0]));
    return res;
}

std::string base64(const std::string &src)
{
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO *sink = BIO_new(BIO_s_mem());
    BIO_push(b64, sink);
    BIO_write(b64, &src[0], src.size());
    BIO_flush(b64);
    const char *encoded;
    const long len = BIO_get_mem_data(sink, &encoded);
    return std::string(encoded, len);
}

std::string create_acceptkey(const std::string& clientkey)
{
    std::string s = clientkey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    return base64(sha1(s));
}

bool WebSocket::connect(std::string &&hostPort,
                        uint32_t timeout,
                        std::function<void(Message &&)> &&onMessage,
                        std::function<void(std::string &&)> &&onError,
                        std::function<void()> &&onClosed)
{
    mConnectTime = Client::mono();
    mConnectTimeout = mConnectTime + timeout;
    assert(onMessage);
    assert(onClosed);
    assert(onError);
    mOnMessage = std::move(onMessage);
    mOnError = std::move(onError);
    mOnClosed = std::move(onClosed);
    mHost = std::move(hostPort);
    size_t colon = hostPort.find(':');
    if (colon == std::string::npos) {
        Log::error("Bad host %s %d %s", mHost.c_str(), errno, strerror(errno));
        return false;
    }
    const std::string host = hostPort.substr(0, colon);
    const uint16_t port = atoi(hostPort.c_str() + colon + 1);
    if (!port) {
        Log::error("Bad host %s %d %s", mHost.c_str(), errno, strerror(errno));
        return false;
    }

    addrinfo hints, *res;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = PF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags |= AI_CANONNAME;

    int ret = getaddrinfo(host.c_str(), nullptr, &hints, &res);
    if (ret != 0) {
        Log::error("Couldn't resolve host %s", host.c_str());
        return false;
    }

    for (addrinfo *addr = res; addr; addr = addr->ai_next) {
        mFD = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
        if (mFD == -1)
            continue;

        do {
            ret = ::connect(mFD, addr->ai_addr, addr->ai_addrlen);
        } while (ret == -1 && errno == EINTR);

        if (!ret)
            break;
    }
    freeaddrinfo(res);

    if (mFD == -1) {
        Log::error("Couldn't connect to host %s", host.c_str());
        return false;
    }

    return 0;
}

void WebSocket::send(Message &&message)
{
    mMessages.push_back(std::move(message));
}
