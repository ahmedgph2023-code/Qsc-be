export function isUnrepliedConversation(c: {
  lastInboundAt: Date | string | null;
  lastMessageAt: Date | string | null;
}) {
  return Boolean(
    c.lastInboundAt &&
      c.lastMessageAt &&
      new Date(c.lastInboundAt).getTime() >= new Date(c.lastMessageAt).getTime(),
  );
}

export function isRepliedConversation(c: {
  lastInboundAt: Date | string | null;
  lastMessageAt: Date | string | null;
}) {
  return Boolean(
    c.lastMessageAt &&
      (!c.lastInboundAt || new Date(c.lastMessageAt).getTime() > new Date(c.lastInboundAt).getTime()),
  );
}
