#include "Client.h"
#include "CompilerArgs.h"
#include <unistd.h>
#include <climits>
#include <cstdlib>
#include <string.h>

int main(int argc, char **argv)
{
    std::string compiler = Client::findCompiler(argc, argv);
    if (compiler.empty()) {
        fprintf(stderr, "Can't find executable for %s\n", argv[0]);
        return 1;
    }

    std::vector<std::string> args(argc);
    for (size_t i=0; i<argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = argv[i];
    }
    std::shared_ptr<CompilerArgs> compilerArgs = CompilerArgs::create(args);
    if (!compilerArgs || compilerArgs->mode != CompilerArgs::Compile)
        Client::runLocal(compiler, argc, argv); // noreturn



        // runLocal(compiler, argc, argv);
    return 0;
}

