export function shouldAnswerCaregiver(text: string): boolean {
  return /\?/.test(text)
    || /^\s*(how|what|when|where|which|who|can|could|would|please|approve|pause alerts|resume alerts|check prices|tell|remind|send|undo|summary)\b/i.test(text)
    || /\b(took|was given|gave .{0,30}\b(medicine|medication|pills|dose)|mark(?:ed)? .{0,30}\b(taken|dose))\b/i.test(text)
}

export function isCareSummaryRequest(text: string): boolean {
  const clean = text.trim().toLowerCase()
  return /^(?:(?:please\s+)?(?:send|give|show|get)\s+(?:me\s+)?(?:a\s+)?(?:(?:daily|care)\s+)?summary|(?:(?:daily|care)\s+)?summary)(?:\s+please)?[?.!]*$/.test(clean)
    || /^can i (?:get|have) (?:a )?(?:(?:daily|care) )?summary\??$/.test(clean)
}
