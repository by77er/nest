// A task's spec, as the manager wrote it: goal, acceptance criteria, files likely touched, test plan.

import { Code, List, Text } from "@mantine/core";
import type { Spec } from "../../api/types";
import { Prose, Section, Stack } from "../../layout";

const Part = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Section title={title} dense region={false}>
    {children}
  </Section>
);

const Given = ({ text }: { text: string }) => (text.trim() ? <Prose>{text}</Prose> : <Text fz="md" c="dimmed">Not given</Text>);

export function SpecView({ spec }: { spec: Spec | null }) {
  if (!spec) {
    return (
      <Text fz="md" c="dimmed">
        Not specced yet. The manager writes the spec, and the task is ready once it has one.
      </Text>
    );
  }
  return (
    <Stack gap="xl">
      <Part title="Goal">
        <Given text={spec.goal} />
      </Part>
      <Part title="Acceptance criteria">
        {spec.acceptance_criteria.length ? (
          <List fz="md" spacing="xs" type="ordered">
            {spec.acceptance_criteria.map((c, i) => (
              <List.Item key={i}>{c}</List.Item>
            ))}
          </List>
        ) : (
          <Given text="" />
        )}
      </Part>
      <Part title="Files">
        {spec.files.length ? (
          <List fz="md" spacing="xs" listStyleType="none">
            {spec.files.map((f, i) => (
              <List.Item key={i}>
                <Code>{f}</Code>
              </List.Item>
            ))}
          </List>
        ) : (
          <Given text="" />
        )}
      </Part>
      <Part title="Test plan">
        <Given text={spec.test_plan} />
      </Part>
    </Stack>
  );
}
