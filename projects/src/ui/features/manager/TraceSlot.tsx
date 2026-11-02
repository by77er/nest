// The Manager page's "Trace" tab: a slot. The live trace viewer (src/ui/features/trace/) mounts here,
// replacing this placeholder, with the manager's agent id.
import { IconTimeline } from "@tabler/icons-react";
import { EmptyState } from "../../layout";

export function TraceSlot(_props: { projectId: string; agent: string | null }) {
  return <EmptyState icon={IconTimeline} title="The trace isn't here yet" description="A live view of the manager's turns and tool calls will be shown here." />;
}
