#ifndef CLIENT_H
#define CLIENT_H

#include <string>

namespace Client {
std::string findCompiler(int argc, char **argv);
void parsePath(const char *path, std::string *basename, std::string *dirname);
[[ noreturn ]] void runLocal(const std::string &compiler, int argc, char **argv);

struct WebSocket *wsConnect();
}

#endif /* CLIENT_H */
