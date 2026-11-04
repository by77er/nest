// The manager's messages the owner hasn't seen: those after the read mark this browser keeps (set when
// the Manager page shows them). Read from the chat's latest page, the query the Manager page polls.
import { useEffect, useState } from "react";
import { useChat } from "../../api/queries";
import { readMark } from "../chat/model";

export function useUnread(projectId: string | undefined, onManager: boolean): number {
  // Outside a project there's no chat to ask for.
  const chat = useChat(projectId ?? "", !!projectId);
  const [mark, setMark] = useState(() => (projectId ? readMark(projectId) : 0));
  useEffect(() => {
    const update = () => setMark(projectId ? readMark(projectId) : 0);
    update();
    window.addEventListener("nest-projects:chat-read", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("nest-projects:chat-read", update);
      window.removeEventListener("storage", update);
    };
  }, [projectId]);
  if (!projectId || onManager) return 0;
  return (chat.data ?? []).filter((m) => m.sender === "manager" && m.seq > mark).length;
}
