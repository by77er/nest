// A field for Markdown, edited as it renders (README.md#descriptions): Mantine's RichTextEditor over a
// Tiptap editor, its toolbar the blocks and marks a description may hold (the common ones first, one row
// that scrolls sideways on a phone), its content drawn as a rich
// message is (the same prose: headings at body size by weight, code on the subtle ground), so what's typed
// looks like what's saved. A block the editor keeps as written shows as its source, labelled.
//
// The field is a labelled control like any other: its label above it, its description and error below,
// the editable area a multi-line textbox named by the label. Styles in RichEditor.module.css.

import { Input } from "@mantine/core";
import "@mantine/tiptap/styles.css";
import { RichTextEditor, useRichTextEditorContext } from "@mantine/tiptap";
import { IconCode, IconHeading, IconSourceCode } from "@tabler/icons-react";
import type { Editor } from "@tiptap/react";
import { useId, type ReactNode } from "react";
import rich from "./Rich.module.css";
import classes from "./RichEditor.module.css";

/** The editable area's attributes, for `useEditor`'s `editorProps`: the prose it's drawn in, and its name. */
export function richEditorAttributes(labelId: string): Record<string, string> {
  return { class: `${rich.prose} ${classes.editable}`, role: "textbox", "aria-multiline": "true", "aria-labelledby": labelId };
}

/** The label's id for a field's editable area: the same in `richEditorAttributes` and on the label. */
export const useRichEditorLabel = () => `rte-${useId().replace(/:/g, "")}`;

type IconProps = { style?: React.CSSProperties };
// Inline code and a code block, told apart: `</>` for the mark, a framed `</>` for the block.
const InlineCodeIcon = ({ style }: IconProps) => <IconCode style={style} stroke={1.5} aria-hidden />;
const CodeBlockIcon = ({ style }: IconProps) => <IconSourceCode style={style} stroke={1.5} aria-hidden />;

/**
 * One heading control, not three levels: a description's headings are drawn at one size by weight (as
 * a rich message's are), so levels would look the same. It makes a heading, or takes one back to text.
 */
function HeadingControl() {
  const { editor } = useRichTextEditorContext();
  const active = editor?.isActive("heading") ?? false;
  return (
    <RichTextEditor.Control
      onClick={() => (active ? editor?.chain().focus().setParagraph().run() : editor?.chain().focus().setHeading({ level: 2 }).run())}
      active={active}
      aria-label="Heading"
      title="Heading"
    >
      <IconHeading style={{ width: "var(--control-icon-size, 1rem)", height: "var(--control-icon-size, 1rem)" }} stroke={1.5} aria-hidden />
    </RichTextEditor.Control>
  );
}

export function RichEditor({ editor, labelId, label, description, error, required = false }: {
  editor: Editor | null; labelId: string; label: string; description?: ReactNode; error?: ReactNode; required?: boolean;
}) {
  return (
    <Input.Wrapper label={label} labelProps={{ id: labelId, component: "div" }} description={description} error={error} withAsterisk={required} data-ds="rich-editor">
      <RichTextEditor editor={editor} variant="subtle" withTypographyStyles={false} classNames={{ root: classes.root, toolbar: classes.toolbar, content: classes.content, control: classes.control }} data-error={error ? true : undefined}>
        {/* The common marks first: on a phone the row scrolls sideways, the rest past its edge. */}
        <RichTextEditor.Toolbar role="group" aria-label={`${label}: formatting`}>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Code icon={InlineCodeIcon} />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.BulletList />
            <RichTextEditor.OrderedList />
            <RichTextEditor.TaskList />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Link />
            <RichTextEditor.Unlink />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <HeadingControl />
            <RichTextEditor.CodeBlock icon={CodeBlockIcon} />
            <RichTextEditor.Blockquote />
            <RichTextEditor.Strikethrough />
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>
        <RichTextEditor.Content />
      </RichTextEditor>
    </Input.Wrapper>
  );
}
