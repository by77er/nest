// The sidebar's pieces (the nest-ui-design skill's Navigation): one row style for every place, one group
// spacing, and the switcher's target. A row's active state comes from the router (`aria-current="page"`).

import { Stack } from "@mantine/core";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { icon as iconSize } from "../theme";
import classes from "./Nav.module.css";

type Icon = React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;

export interface NavRowProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {
  icon: Icon;
  label: ReactNode;
  /** A count or badge at the row's end (a view's "needs you"). */
  end?: ReactNode;
}

/** One place in the sidebar: an icon column, a label, an optional end. The router makes it a link. */
export const NavRow = forwardRef<HTMLAnchorElement, NavRowProps>(function NavRow({ icon: Icon, label, end, className: _c, ...rest }, ref) {
  return (
    <a ref={ref} className={classes.row} data-ds="nav-row" {...rest}>
      <span className={classes.icon}>
        <Icon size={iconSize.md} aria-hidden />
      </span>
      <span className={classes.label}>{label}</span>
      {end && <span className={classes.end}>{end}</span>}
    </a>
  );
});

/** A group of rows, `xs` apart; groups are `xl` apart (NavGroups). */
export function NavGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Stack gap="xs" role="group" aria-label={label} data-ds="nav-group">
      {children}
    </Stack>
  );
}

export function NavGroups({ children }: { children: ReactNode }) {
  return (
    <Stack gap="xl" data-ds="nav-groups">
      {children}
    </Stack>
  );
}

export interface SwitcherTargetProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: Icon;
  label: ReactNode;
  end?: ReactNode;
}

/** The switcher's button: the current parent's name, on the rows' left edge, opening a chooser. */
export const SwitcherTarget = forwardRef<HTMLButtonElement, SwitcherTargetProps>(function SwitcherTarget({ icon: Icon, label, end, className: _c, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={classes.switcher} data-ds="switcher" {...rest}>
      <span className={classes.icon}>
        <Icon size={iconSize.md} aria-hidden />
      </span>
      <span className={classes.label}>{label}</span>
      {end && <span className={classes.end}>{end}</span>}
    </button>
  );
});
