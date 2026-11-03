// Task references in a manager's message (README.md#rich-messages): `[text](task:tsk_…)`, a bare
// `task:tsk_…`, and a ```tasks block of one id per line with an optional note. They are resolved
// live from the project's own board; the message's own text for them is never shown as task data.

export const TASK_REF = /\btask:(tsk_[a-z0-9]+)\b/g;
export const TASK_HREF = /^task:(tsk_[a-z0-9]+)$/;

/** A `tasks` block's line: its id and note, or null when it isn't one. */
export function taskLine(line: string): { id: string; note: string } | null {
  const m = /^(?:task:)?(tsk_[a-z0-9]+)\b[\s:—–-]*(.*)$/.exec(line.trim());
  return m ? { id: m[1]!, note: m[2]!.trim() } : null;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/**
 * A remark plugin: a bare `task:tsk_…` in text becomes a link to it, so it renders as a chip like a
 * written link does. Code and existing links are left alone.
 */
export function remarkTaskRefs() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children || node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value || !TASK_REF.test(child.value)) {
          TASK_REF.lastIndex = 0;
          walk(child);
          next.push(child);
          continue;
        }
        TASK_REF.lastIndex = 0;
        let at = 0;
        for (const m of child.value.matchAll(TASK_REF)) {
          if (m.index! > at) next.push({ type: "text", value: child.value.slice(at, m.index) });
          next.push({ type: "link", url: `task:${m[1]}`, children: [{ type: "text", value: m[0] }] });
          at = m.index! + m[0].length;
        }
        if (at < child.value.length) next.push({ type: "text", value: child.value.slice(at) });
      }
      node.children = next;
    };
    walk(tree);
  };
}

/**
 * A remark plugin: raw HTML in the text becomes literal text, so it shows escaped (`<b>` as "<b>") and
 * can never be parsed as markup, whatever comes later in the pipeline.
 */
export function remarkEscapeHtml() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      for (const child of node.children ?? []) {
        if (child.type === "html") child.type = "text";
        else walk(child);
      }
    };
    walk(tree);
  };
}
