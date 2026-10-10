import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import styles from "./primitives.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

function buttonClassName(variant: ButtonVariant, className?: string) {
  return `${styles.button} ${styles[variant]} ${className ?? ""}`.trim();
}

export function Button({
  children,
  className,
  type = "button",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button className={buttonClassName(variant, className)} type={type} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  className,
  variant = "primary",
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link className={buttonClassName(variant, className)} {...props}>
      {children}
    </Link>
  );
}
