#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include "Log.h"
#include <assert.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <condition_variable>

static std::condition_variable sCond;
static std::thread sThread;
static Watchdog::Stage sStage = Watchdog::Initial;
static bool sStopped = false;
static std::atomic<bool> sTimedOut(false);
unsigned long long Watchdog::timings[Watchdog::Finished + 1] = {};

using namespace std::chrono_literals;

void Watchdog::transition(Stage stage)
{
    if (!Watchdog::timings[Initial]) {
        Watchdog::timings[Initial] = Client::started;
    }
    assert(stage > 0);
    Watchdog::timings[stage] = Client::mono();
    std::unique_lock<std::mutex> lock(Client::mutex());
    DEBUG("Watchdog transition from %s to %s (stage took %llu)", stageName(sStage), stageName(stage), Watchdog::timings[stage] - Watchdog::timings[stage - 1]);
    assert(sStage != stage);
    sStage = stage;
    sCond.notify_one();
}

void Watchdog::start(const std::string &compiler, int argc, char **argv)
{
    if (!Config::watchdog())
        return;

    sThread = std::thread([]() {
            while (true) {
                std::unique_lock<std::mutex> lock(Client::mutex());
                unsigned long long timeout = 0;
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
                    timeout = Config::uploadJobTimeout();
                    break;
                case UploadedJob:
                    timeout = Config::responseTimeout();
                    break;
                case Finished:
                    return;
                }
                auto now = std::chrono::system_clock::now();
                const Stage next = static_cast<Stage>(sStage + 1);
                DEBUG("Waiting for %s %llu\n", stageName(next), timeout);
                const auto absTime = now + (timeout * 1ms);
                do {
                    const bool timedOut = sCond.wait_until(lock, absTime) == std::cv_status::timeout;
                    if (sStopped)
                        return;
                    if (timedOut) {
                        WARN("Timed out waiting for %s (%llums), running locally", stageName(next), timeout);
                        // printf("GOT HERE\n");
                        sTimedOut = true;
                        lock.unlock();
                        Client::runLocal(Client::acquireSlot(Client::Wait));
                        return;
                    }
                } while (sStage < next);
                // printf("OR GOT HERE\n");
            }
        });
}


void Watchdog::stop()
{
    DEBUG("Watchdog stop\n");
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

bool Watchdog::timedOut()
{
    return sTimedOut;
}
