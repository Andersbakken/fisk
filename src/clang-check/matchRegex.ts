export function matchRegex(regex: RegExp, str: string): boolean {
    if (regex.exec(str)) {
        // console.log(str, "matches", regex);
        return true;
    }
    // console.log(str, "does not match", regex);
    return false;
}
