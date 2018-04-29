#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include <assert.h>
#include <thread>
#include <chrono>
#include <condition_variable>

static std::condition_variable sCond;
static std::thread sThread;
static Watchdog::Stage sStage = Watchdog::Initial;
static bool sStopped = false;

using namespace std::chrono_literals;

void Watchdog::transition(Stage stage)
{
    std::unique_lock<std::mutex> lock(Client::mutex());
    assert(sStage != stage);
    sStage = stage;
    sCond.notify_one();
}

void Watchdog::start(const std::string &compiler, int argc, char **argv)
{
    sThread = std::thread([compiler, argc, argv]() {
            while (true) {
                std::unique_lock<std::mutex> lock(Client::mutex());
                unsigned long long timeout;
                switch (sStage) {
                case Initial:
                    timeout = Config::schedulerConnectTimeout();
                    break;
                case ConnectedToScheduler:
                    timeout = Config::acquiredSlaveTimeout();
                    break;
                case AcquiredSlave:
                    timeout = Config::slaveConnectTimeout();
                    break;
                case ConnectedToSlave:
                    timeout = Config::responseTimeout();
                    break;
                case WaitingForResponse:
                    return;
                }
                auto now = std::chrono::system_clock::now();
                if (sCond.wait_until(lock, now + (timeout * 1ms)) == std::cv_status::timeout && !sStopped) {
                    Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                    return;
                }
                if (!sStopped)
                    return;
            }
        });
}


void Watchdog::stop()
{
    {
        std::unique_lock<std::mutex> lock(Client::mutex());
        assert(!sStopped);
        sStopped = true;
        sCond.notify_one();
    }
    sThread.join();
}

