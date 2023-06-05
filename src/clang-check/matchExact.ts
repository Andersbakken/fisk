export function matchExact(match: string, str: string): boolean {
    if (str === match) {
        // console.log(str, "===", match);
        return true;
    }
    // console.log(str, "!==", match);
    return false;
}
