module.exports = {
    // client codes
    get AcquireCppSlot() {  return 1; },
    get AcquireCompileSlot() { return 2; },
    get TryAcquireCompileSlot() { return 3; },
    get ReleaseCppSlot() { return 4; },
    get ReleaseCompileSlot() { return 5; },
    get JSON() { return 6; },

    // daemon codes
    get CppSlotAcquired() { return 10; },
    get CompileSlotAcquired() { return 11; },
    get CompileSlotNotAcquired() { return 12; },
    get JSONResponse() { return 13; }
};
