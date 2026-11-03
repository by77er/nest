// A task's description, edited as it renders (README.md#descriptions): Markdown in and out
// (src/ui/rich/editor-markdown.ts), Tiptap's document only while it's edited. `value` is the Markdown;
// `onChange` gets the Markdown of each edit. A new `value` from outside (the manager rewrote it, a reset)
// replaces the document; the field's own edits coming back don't.

import { useEditor } from "@tiptap/react";
import { type ReactNode, useEffect, useRef } from "react";
import { editorExtensions, fromMarkdown, toMarkdown } from "../../rich/editor-markdown";
// Its own module, not the layout index: the editor (Tiptap) loads only with the forms that use it.
import { RichEditor, richEditorAttributes, useRichEditorLabel } from "../../layout/RichEditor";

export function DescriptionField({ value, onChange, label = "Details", description, error, autoFocus = false, readOnly = false, onEscape }: {
  value: string; onChange: (md: string) => void; label?: string; description?: ReactNode; error?: ReactNode; autoFocus?: boolean; readOnly?: boolean;
  /** Escape in the text: the form's own (leave it, or ask first). ProseMirror's (selecting the parent block) otherwise. */
  onEscape?: () => void;
}) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const labelId = useRichEditorLabel();
  // What the editor last said, so its own edits coming back as `value` aren't loaded again (which would
  // move the cursor).
  const said = useRef(value);
  const editor = useEditor({
    extensions: editorExtensions(),
    content: fromMarkdown(value),
    editable: !readOnly,
    autofocus: autoFocus ? "end" : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: richEditorAttributes(labelId),
      // Ahead of the editor's keymap, which takes Escape: the same as anywhere else in the form. (The
      // link editor is a popover outside the text: its Escape only closes it.)
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape" || event.isComposing || !escape.current) return false;
        escape.current();
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = toMarkdown(e.getJSON());
      said.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    if (!editor || value === said.current) return;
    said.current = value;
    editor.commands.setContent(fromMarkdown(value), { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  return <RichEditor editor={editor} labelId={labelId} label={label} description={description} error={error} />;
}
