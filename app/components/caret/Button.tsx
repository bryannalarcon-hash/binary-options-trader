"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  primary?: boolean;
  ghost?: boolean;
  sm?: boolean;
  lg?: boolean;
  size?: "sm" | "lg";
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  children,
  primary,
  ghost,
  sm,
  lg,
  size,
  leftIcon,
  rightIcon,
  className,
  type = "button",
  ...rest
}: Props) {
  const cls = ["btn"];
  if (primary) cls.push("primary");
  if (ghost) cls.push("ghost");
  if (sm || size === "sm") cls.push("sm");
  if (lg || size === "lg") cls.push("lg");
  if (className) cls.push(className);
  return (
    <button type={type} className={cls.join(" ")} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
