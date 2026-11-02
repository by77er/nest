// Mantine's Anchor and Button as typed router links (TanStack Router's createLink), so navigation is a
// real <a href> (middle-click, keyboard) with the route's params and search checked by the compiler.

import { Anchor, type AnchorProps, Button, type ButtonProps, NavLink, type NavLinkProps } from "@mantine/core";
import { createLink, type LinkComponent } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, forwardRef } from "react";

type AnchorBaseProps = AnchorProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof AnchorProps>;
const AnchorBase = forwardRef<HTMLAnchorElement, AnchorBaseProps>((props, ref) => <Anchor ref={ref} {...props} />);
const CreatedAnchorLink = createLink(AnchorBase);
export const AnchorLink: LinkComponent<typeof AnchorBase> = (props) => <CreatedAnchorLink preload="intent" {...props} />;

type ButtonBaseProps = ButtonProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonProps>;
const ButtonBase = forwardRef<HTMLAnchorElement, ButtonBaseProps>((props, ref) => <Button component="a" ref={ref} {...props} />);
const CreatedButtonLink = createLink(ButtonBase);
export const ButtonLink: LinkComponent<typeof ButtonBase> = (props) => <CreatedButtonLink preload="intent" {...props} />;

// A sidebar place: Mantine's NavLink as a router link, highlighted while its route is active.
type NavBaseProps = NavLinkProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof NavLinkProps>;
const NavBase = forwardRef<HTMLAnchorElement, NavBaseProps>((props, ref) => <NavLink component="a" ref={ref} {...props} />);
const CreatedNavLink = createLink(NavBase);
export const NavItemLink: LinkComponent<typeof NavBase> = (props) => <CreatedNavLink preload="intent" activeProps={{ active: true, "aria-current": "page" }} {...props} />;
