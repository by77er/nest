// Mantine's Anchor and Button as typed router links (TanStack Router's createLink), so navigation is a
// real <a href> (middle-click, keyboard) with the route's params and search checked by the compiler.

import { Anchor, type AnchorProps, Badge, type BadgeProps, Button, type ButtonProps } from "@mantine/core";
import { createLink, type LinkComponent } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, forwardRef } from "react";
import { NavRow } from "../layout/Nav";
import { TaskCardTitleAnchor, TaskChipAnchor } from "../layout/Rich";

type AnchorBaseProps = AnchorProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof AnchorProps>;
const AnchorBase = forwardRef<HTMLAnchorElement, AnchorBaseProps>((props, ref) => <Anchor ref={ref} {...props} />);
const CreatedAnchorLink = createLink(AnchorBase);
export const AnchorLink: LinkComponent<typeof AnchorBase> = (props) => <CreatedAnchorLink preload="intent" {...props} />;

type ButtonBaseProps = ButtonProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonProps>;
const ButtonBase = forwardRef<HTMLAnchorElement, ButtonBaseProps>((props, ref) => <Button component="a" ref={ref} {...props} />);
const CreatedButtonLink = createLink(ButtonBase);
export const ButtonLink: LinkComponent<typeof ButtonBase> = (props) => <CreatedButtonLink preload="intent" {...props} />;

// A badge that goes somewhere (a project's "needs you", to its Board).
type BadgeBaseProps = BadgeProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof BadgeProps>;
const BadgeBase = forwardRef<HTMLAnchorElement, BadgeBaseProps>((props, ref) => <Badge component="a" ref={ref} {...props} />);
const CreatedBadgeLink = createLink(BadgeBase);
export const BadgeLink: LinkComponent<typeof BadgeBase> = (props) => <CreatedBadgeLink preload="intent" {...props} />;

// A sidebar place: the NavRow primitive as a router link, `aria-current="page"` while its route is active
// (which is all the active style keys on).
const CreatedNavRowLink = createLink(NavRow);
export const NavRowLink: LinkComponent<typeof NavRow> = (props) => <CreatedNavRowLink preload="intent" activeProps={{ "aria-current": "page" }} {...props} />;

// A task referenced in a message: its chip, and its card's title, as router links to the board's drawer.
const CreatedChipLink = createLink(TaskChipAnchor);
export const TaskChipLink: LinkComponent<typeof TaskChipAnchor> = (props) => <CreatedChipLink preload="intent" {...props} />;
const CreatedCardTitleLink = createLink(TaskCardTitleAnchor);
export const TaskCardTitleLink: LinkComponent<typeof TaskCardTitleAnchor> = (props) => <CreatedCardTitleLink preload="intent" {...props} />;
