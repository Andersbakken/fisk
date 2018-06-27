#ifndef SLOTACQUIRER_H
#define SLOTACQUIRER_H


#include <unistd.h>
#include <string>
#include "Client.h"
#include <functional>
#include "Select.h"
#ifdef __linux__
#include <sys/inotify.h>
#include <sys/ioctl.h>
#endif

class SlotAcquirer : public Socket
{
public:
    SlotAcquirer(Client::Slot::Type type, size_t slots, std::function<void(std::unique_ptr<Client::Slot> &&)> onAcquired)
        : mOnAcquired(onAcquired), mType(type)
    {
        mSemaphore = sem_open(Client::Slot::typeToString(type), O_CREAT, 0666, slots);
        if (pipe(mPipe) != 0) {
            mPipe[0] = mPipe[1] = -1;
            ERROR("Failed to create pipe %d %s", errno, strerror(errno));
            return;
        }
        mThread = std::thread([this]() {
                while (true) {
                    struct timespec ts;
                    clock_gettime(CLOCK_REALTIME, &ts);
                    ts.tv_sec += 1;

                    const int ret = sem_timedwait(mSemaphore, &ts);
                    std::unique_lock<std::mutex> lock(mMutex);
                    if (mStopped) {
                        if (!ret)
                            sem_post(mSemaphore); // give it back, we're too late
                        break;
                    } else if (!ret) {
                        mSlot.reset(new Client::Slot(mType, mSemaphore));
                        while (true) {
                            if (::write(mPipe[1], "1", 1) != -1 || errno != EINTR)
                                break;
                        }
                        break;
                    }
                }
            });
    }

    ~SlotAcquirer()
    {
        ::close(mPipe[0]);
        ::close(mPipe[1]);
        mThread.join();
    }

    virtual int timeout() const override
    {
        return -1;
    }

    virtual int fd() const override
    {
        return mPipe[0];
    }

    virtual void onWrite() override
    {
    }
    virtual void onRead() override
    {
        mOnAcquired(std::move(mSlot));
    }
    virtual void onTimeout() override
    {
    }
    virtual unsigned int mode() const override
    {
        return Read;
    }
    void stop()
    {
        std::unique_lock<std::mutex> lock(mMutex);
        mStopped = true;
    }
private:
    std::thread mThread;
    std::mutex mMutex;
    sem_t *mSemaphore;
    bool mStopped { false };
    std::function<void(std::unique_ptr<Client::Slot> &&)> mOnAcquired;
    const Client::Slot::Type mType;
    int mPipe[2];
    std::unique_ptr<Client::Slot> mSlot;
};


#endif /* SLOTACQUIRER_H */
