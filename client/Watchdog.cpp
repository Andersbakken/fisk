#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include "Log.h"
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
    Log::debug("Watchdog transition from %s to %s", stageName(sStage), stageName(stage));
    assert(sStage != stage);
    sStage = stage;
    sCond.notify_one();
}

void Watchdog::start(const std::string &compiler, int argc, char **argv)
{
    if (!Config::watchdog())
        return;

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
                const Stage next = static_cast<Stage>(sStage + 1);
                Log::debug("Waiting for %s %llu\n", stageName(next), timeout);
                const auto absTime = now + (timeout * 1ms);
                do {
                    const bool timedOut = sCond.wait_until(lock, absTime) == std::cv_status::timeout;
                    if (sStopped)
                        return;
                    if (timedOut) {
                        Log::warning("Timed out waiting for %s (%llums), running locally", stageName(next), timeout);
                        // printf("GOT HERE\n");
                        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                        return;
                    }
                } while (sStage < next);
                // printf("OR GOT HERE\n");
            }
        });
}


void Watchdog::stop()
{
    Log::debug("Watchdog stop\n");
    if (!Config::watchdog())
        return;

    {
        std::unique_lock<std::mutex> lock(Client::mutex());
        assert(!sStopped);
        sStopped = true;
        sCond.notify_one();
    }
    sThread.join();
}
