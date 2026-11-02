// A task's spec, as the manager wrote it: goal, acceptance criteria, files likely touched, test plan.

import { Code, List, Stack, Text, Title } from "@mantine/core";
import type { Spec } from "../../api/types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap={4}>
      <Title order={4} size="sm" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: 0.4 }}>
        {title}
      </Title>
      {children}
    </Stack>
  );
}

const Prose = ({ text }: { text: string }) =>
  text.trim() ? <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{text}</Text> : <Text size="sm" c="dimmed">Not given</Text>;

export function SpecView({ spec }: { spec: Spec | null }) {
  if (!spec) {
    return (
      <Text size="sm" c="dimmed">
        Not specced yet. The manager writes the spec, and the task is ready once it has one.
      </Text>
    );
  }
  return (
    <Stack gap="md">
      <Section title="Goal">
        <Prose text={spec.goal} />
      </Section>
      <Section title="Acceptance criteria">
        {spec.acceptance_criteria.length ? (
          <List size="sm" spacing={4} type="ordered">
            {spec.acceptance_criteria.map((c, i) => (
              <List.Item key={i}>{c}</List.Item>
            ))}
          </List>
        ) : (
          <Prose text="" />
        )}
      </Section>
      <Section title="Files">
        {spec.files.length ? (
          <List size="sm" spacing={2} listStyleType="none">
            {spec.files.map((f, i) => (
              <List.Item key={i}>
                <Code>{f}</Code>
              </List.Item>
            ))}
          </List>
        ) : (
          <Prose text="" />
        )}
      </Section>
      <Section title="Test plan">
        <Prose text={spec.test_plan} />
      </Section>
    </Stack>
  );
}
