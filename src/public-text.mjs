export function cleanPublicChatText(value) {
  const text = String(value ?? "");
  if (!/(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化|\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)\b)/iu.test(text.replace(/[\u200B-\u200D\uFEFF]/gu, ""))) return text.trim();
  return text
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/(?:已|经)?(?:脱[ \t]*敏|脱[ \t]*密|匿名化|去标识化)(?:处理)?(?:版本|版)?/gu, "")
    .replace(/\b(?:saniti[sz]ed|anonymi[sz]ed|de-identified|redacted)(?:[ -]+version)?\b/giu, "")
    .replace(/[（(【\[][ \t]*[）)】\]]/gu, "")
    .replace(/[ \t]+([，。！？；：）》】])/gu, "$1")
    .replace(/([《（【])[ \t]+/gu, "$1")
    .replace(/[_-]+(?=[》）】]|$)/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}
