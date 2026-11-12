// The layout primitives (README.md#design-system, the nest-ui-design skill). Every screen composes from
// these and Mantine's controls; only these files and the theme may use inline styles, raw sizes or CSS
// (src/ui/design.test.ts).
export { AppFrame } from "./AppFrame";
export { ScrollLog } from "./Chat";
export { ChatFrame, ChatLog, ChatWelcome, CodeFrame, ComposerBox, ComposerDock, DaySeparator, MessageGroup, MessageRow, SpinnerSlot, Starter, StepField, StepList, StepRow, StepsDisclosure, type StepStatus, WorkingLine } from "./ChatLog";
export { FadeIn } from "./FadeIn";
export { Glyph, GLYPH, Terminal, TermLine, TermProse, TermRule, TermStatus, type TermTone } from "./Terminal";
export { FieldGroup } from "./FieldGroup";
export { BadgeAnchor, CardGrid, SectionGrid, WithContext } from "./Layouts";
export { MetaItem, MetaRow, Token } from "./Meta";
export { NavGroup, NavGroups, NavRow, SwitcherTarget } from "./Nav";
export { Switcher, type SwitcherItem } from "./Switcher";
export { Notice, type NoticeTone } from "./Notice";
export { Measure, Page, PageHeader } from "./Page";
export { Panel, type PanelTone, TableFrame, Well } from "./Panel";
export { Section } from "./Section";
export { Sheet, useFillColumn } from "./Sheet";
export { StateGlyph, TaskGroup, TaskList, TaskRow, TaskRowTitleAnchor, TaskRowsEmpty } from "./TaskList";
export { Prose, Row, Stack } from "./Stack";
export { RichImage, RichProse, RichTableFrame, SvgFigure, TaskCards, TaskCheck, TaskChipPending, TaskRefCard } from "./Rich";
export { EmptyState, ErrorState, LoadingState } from "./States";
export { Toolbar } from "./Toolbar";
export { icon, weight } from "../theme";
export { ButtonBusy, Grow, Picker, type PickerItem, RowAction, TriggerBadge } from "./Actions";
export { PHONE_QUERY, usePhone } from "./media";
