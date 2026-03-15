export const Constants = {
    // client codes
    get AcquireCppSlot(): number {
        return 1;
    },
    get AcquireCompileSlot(): number {
        return 2;
    },
    get ReleaseCppSlot(): number {
        return 3;
    },
    get ReleaseCompileSlot(): number {
        return 4;
    },
    get JSON(): number {
        return 5;
    },
    get AcquireSlot(): number {
        return 6;
    },
    get ReleaseLocalSlot(): number {
        return 7;
    },

    // daemon codes
    get CppSlotAcquired(): number {
        return 10;
    },
    get CompileSlotAcquired(): number {
        return 11;
    },
    get JSONResponse(): number {
        return 12;
    },
    get LocalSlotAcquired(): number {
        return 13;
    }
};
