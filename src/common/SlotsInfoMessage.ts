export interface SlotInfo {
    active: number;
    capacity: number;
    total: number;
}

export interface SlotsInfoMessage {
    type: "slotsInfo";
    local: SlotInfo;
    cpp: SlotInfo;
    compile: SlotInfo;
}
