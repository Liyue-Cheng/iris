/**
 * The protocol version this app implements. Mirrors the `protocol:` value
 * written into fresh constitutions (main/iris-templates.ts). On mismatch
 * the app only PROMPTS — the constitution is user-owned; upgrading it is a
 * human gesture (software-definition.md §3 宪法的注入链与版本).
 */
export const PROTOCOL_VERSION = 1;
