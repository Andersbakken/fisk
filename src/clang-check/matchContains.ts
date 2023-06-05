export function matchContains(pattern: string, str: string): boolean {
    if (str.includes(pattern)) {
        // console.log(str, "includes", pattern);
        return true;
    }
    // console.log(str, "does not include", pattern);
    return false;
}
