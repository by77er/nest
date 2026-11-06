// A done task's issue that GitHub refused to close (README.md#triage): why, and a retry once the cause is
// fixed (the grant given `issues: write`, say). A grant that changes retries it on its own as well.

import { Button, Text } from "@mantine/core";
import { useRetryIssueClose } from "../../api/queries";
import type { Task } from "../../api/types";
import { Notice, Stack } from "../../layout";

export function IssueCloseFailed({ projectId, task }: { projectId: string; task: Task }) {
  const retry = useRetryIssueClose(projectId);
  if (task.issue?.close !== "failed") return null;
  return (
    <Notice tone="warning" title={`Issue #${task.issue.number} wasn't closed on GitHub`}>
      <Stack gap="sm" align="flex-start">
        {task.issue.error && <Text fz="sm">{task.issue.error}</Text>}
        <Button variant="default" loading={retry.isPending} onClick={() => retry.mutate({ task: task.id })}>
          Retry closing the issue
        </Button>
      </Stack>
    </Notice>
  );
}
