// Mantine's Anchor and Button as typed router links (TanStack Router's createLink), so navigation is a
// real <a href> (middle-click, keyboard) with the route's params and search checked by the compiler.

import { Anchor, type AnchorProps, Button, type ButtonProps } from "@mantine/core";
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
