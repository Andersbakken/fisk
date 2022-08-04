module.exports = {
    // client codes
    get AcquireCppSlot() {  return 1; },
    get AcquireCompileSlot() { return 2; },
    get ReleaseCppSlot() { return 3; },
    get ReleaseCompileSlot() { return 4; },
    get JSON() { return 5; },

    // daemon codes
    get CppSlotAcquired() { return 10; },
    get CompileSlotAcquired() { return 11; },
    get JSONResponse() { return 12; }
};
