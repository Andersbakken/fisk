#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <functional>
#include <string>
#include <vector>

class WebSocket
{
public:
    enum Mode {
        Text,
        Binary
    };
    struct Message {
        Mode mode;
        std::string data;
    };
    bool connect(std::string &&host,
                 uint32_t ms,
                 std::function<void(Message &&)> &&onMessage,
                 std::function<void(std::string &&)> &&onError,
                 std::function<void()> &&onClosed);
    void send(Message &&message);
private:
    unsigned long long mConnectTime { 0 }, mConnectTimeout { 0 };
    std::string mHost;
    std::vector<Message> mMessages;
    std::function<void(Message &&)> mOnMessage;
    std::function<void(std::string &&)> mOnError;
    std::function<void()> mOnClosed;
    int mFD { -1 };
};

#endif /* WEBSOCKET_H */
